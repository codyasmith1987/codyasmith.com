// Invoice email recipients + sending. The recipient model (Cody, 2026-06-04):
// invoices and overdue notices go to the client's PRIMARY billing contact, NOT
// every portal user. An accountant CC (per client) rides along on FINANCIAL
// documents only. A per-invoice extra recipient alerts someone for one invoice.
//
// resolveInvoiceRecipients is pure (unit-tested). sendInvoiceEmail reuses
// sendEmail (CC + PDF attachment) and the invoice PDF. It is a deliberate
// admin-only action (the admin-role send endpoint plus a UI confirm dialog);
// there is NO per-client allowlist in the code. Until the slice is signed off,
// the gate is operational: the branch is unmerged, so only Cody Test (his own
// inbox) is ever used for verification. Do not point Send at a real client
// before sign-off.

export interface InvoiceRecipients {
  to: string[];
  cc: string[];
}

const norm = (e?: string | null): string => (e || '').trim().toLowerCase();
const clean = (e?: string | null): string => (e || '').trim();

// to: the primary billing contact (or, only if none is set, the first fallback
// such as a portal user, as a safety so a misconfigured invoice still reaches
// someone). cc: the per-client accountant + the per-invoice extra, deduped and
// never duplicating a `to` address.
export function resolveInvoiceRecipients(opts: {
  primaryEmail?: string | null;
  billingCcEmail?: string | null;
  extraEmail?: string | null;
  fallbackEmails?: string[];
}): InvoiceRecipients {
  const to: string[] = [];
  const primary = clean(opts.primaryEmail);
  if (primary) {
    to.push(primary);
  } else {
    for (const f of opts.fallbackEmails || []) {
      if (clean(f)) { to.push(clean(f)); break; }
    }
  }

  const seen = new Set(to.map(norm));
  const cc: string[] = [];
  for (const candidate of [opts.billingCcEmail, opts.extraEmail]) {
    const v = clean(candidate);
    if (v && !seen.has(norm(v))) {
      cc.push(v);
      seen.add(norm(v));
    }
  }

  return { to, cc };
}

// ============================================================
// Sending an invoice (the admin "Send to client" action)
// ============================================================

import { getInvoice, updateInvoice, type Invoice } from './invoices';
import { getClientMetadata } from './agreements';
import { getUsersByClientId } from './auth';
import { generateInvoicePdf } from './pdf';
import { sendEmail } from './email';
import { escapeHtml } from './email-safety';
import { logger } from './logger';
import {
  money, invoiceShell, renderInvoiceEmail, variantForStatus,
  type InvoiceEmailVariant, type InvoiceEmailView,
} from './invoice-email-templates';

// The first name to greet, from the client's primary contact only. Falls back
// to "there" when no contact name is set -- never the company/client name, so a
// company-style record never produces an awkward "Hi <Company>" salutation.
function greetNameFrom(meta: { primary_contact_name?: string | null } | null): string {
  const name = (meta?.primary_contact_name || '').trim();
  if (!name) return 'there';
  return name.split(/\s+/)[0] || 'there';
}

// Plain view of an invoice for the pure renderer (no DB types leak into copy).
function invoiceEmailView(
  invoice: { invoice_number: string; title: string | null; total: number; amount_paid: number; due_date: string | null; terms_label: string | null },
  meta: { primary_contact_name?: string | null } | null,
): InvoiceEmailView {
  return {
    invoice_number: invoice.invoice_number,
    title: invoice.title,
    total: invoice.total,
    amount_paid: invoice.amount_paid || 0,
    due_date: invoice.due_date,
    terms_label: invoice.terms_label,
    greet_name: greetNameFrom(meta),
  };
}

export interface SendInvoiceResult {
  ok: boolean;
  to: string[];
  cc: string[];
  reason?: string;
}

// Shared delivery core: load the invoice, run the guards, resolve recipients,
// freeze the Bill To, render the chosen variant, attach the PDF, and send.
// Returns the outcome plus the loaded invoice so each caller does its own
// post-send bookkeeping. variant 'auto' derives from the invoice status. Never
// throws on a soft failure; reports via { ok:false, reason }.
async function deliverInvoiceEmail(
  invoiceId: string,
  variant: InvoiceEmailVariant | 'auto',
): Promise<{ result: SendInvoiceResult; invoice: Invoice | null }> {
  const invoice = await getInvoice(invoiceId);
  if (!invoice) return { result: { ok: false, to: [], cc: [], reason: 'not_found' }, invoice: null };

  // Never email a $0 / itemless invoice (overhaul design Slice 5). A manually
  // created invoice starts with no line items, so a total of 0 means the admin
  // has not added charges yet; sending would drop "$0.00 due" in the client's
  // inbox (the real INV-2026-0005 incident, 2026-06-09).
  if (!(invoice.total > 0)) {
    return { result: { ok: false, to: [], cc: [], reason: 'empty_invoice' }, invoice };
  }

  const meta = await getClientMetadata(invoice.client_id).catch(() => null);
  const users = await getUsersByClientId(invoice.client_id);
  const recipients = resolveInvoiceRecipients({
    primaryEmail: meta?.primary_contact_email,
    billingCcEmail: meta?.billing_cc_email,
    extraEmail: invoice.extra_recipient_email,
    fallbackEmails: users.map(u => u.email),
  });
  if (recipients.to.length === 0) return { result: { ok: false, to: [], cc: [], reason: 'no_recipient' }, invoice };

  // Freeze the Bill To from the live record at send time so later metadata edits
  // never rewrite an invoice already in the client's inbox.
  if (!invoice.bill_to_snapshot && meta) {
    const snapshot = JSON.stringify({
      company: meta.legal_entity_name || null,
      contact: meta.primary_contact_name || null,
      address: meta.notice_address || meta.principal_address || null,
      email: meta.primary_contact_email || null,
    });
    try { await updateInvoice(invoiceId, { bill_to_snapshot: snapshot }); } catch (err) { logger.error('freeze bill_to_snapshot failed', err); }
  }

  // Generate the PDF after the snapshot is frozen so the attachment matches.
  let pdfBase64: string;
  try {
    const pdf = await generateInvoicePdf(invoiceId);
    pdfBase64 = pdf.toString('base64');
  } catch (err) {
    logger.error(`deliverInvoiceEmail: PDF generation failed for ${invoiceId}`, err);
    return { result: { ok: false, to: recipients.to, cc: recipients.cc, reason: 'pdf_failed' }, invoice };
  }

  const portalUrl = import.meta.env.SITE || 'https://codyasmith.com';
  const v = variant === 'auto' ? variantForStatus(invoice.status) : variant;
  const { subject, html } = renderInvoiceEmail(invoiceEmailView(invoice, meta), v, { portalUrl, now: new Date() });

  const toName = meta?.primary_contact_name || '';
  const ok = await sendEmail(
    recipients.to.map((e, i) => ({ email: e, name: i === 0 ? toName : '' })),
    subject,
    html,
    {
      cc: recipients.cc.map(e => ({ email: e })),
      attachments: [{ name: `${invoice.invoice_number}.pdf`, content: pdfBase64 }],
    }
  );
  if (!ok) return { result: { ok: false, to: recipients.to, cc: recipients.cc, reason: 'send_failed' }, invoice };
  return { result: { ok: true, to: recipients.to, cc: recipients.cc }, invoice };
}

// Email a single invoice to the client's billing contact (PDF attached, the
// accountant CC'd, plus any per-invoice extra recipient). Status-aware copy.
// Transitions a draft to 'sent', stamps an issue date, makes it client-visible,
// and fires the in-portal notification only on the draft->sent transition.
export async function sendInvoiceEmail(invoiceId: string): Promise<SendInvoiceResult> {
  const { result, invoice } = await deliverInvoiceEmail(invoiceId, 'auto');
  if (!result.ok || !invoice) return result;

  const wasDraft = invoice.status === 'draft';
  const patch: Record<string, any> = {};
  if (wasDraft) patch.status = 'sent';
  if (!invoice.issued_date) patch.issued_date = new Date().toISOString().split('T')[0];
  // Emailing the invoice inherently makes it client-visible (new invoices default
  // to client_visible = 0); otherwise the email's "the same copy is in your
  // portal" line points at a hidden invoice.
  if (invoice.client_visible !== 1) patch.client_visible = 1;
  if (Object.keys(patch).length > 0) {
    try { await updateInvoice(invoiceId, patch); } catch (err) { logger.error('post-send invoice update failed', err); }
  }
  if (wasDraft) {
    try {
      const { onInvoiceSent } = await import('./triggers');
      await onInvoiceSent(invoiceId);
    } catch (err) { logger.error('onInvoiceSent after send failed', err); }
  }
  return result;
}

// Per-invoice reminder / overdue notice: an explicit admin action (the invoice
// detail "Send reminder" / "Send overdue notice" button). Reuses the same render
// + recipients + PDF as a first send, with the chosen variant. Unlike the nightly
// cron dunning, this IS allowed for a manual_billing client, because hand-billing
// is the whole workflow for them and the admin is clicking deliberately. It does
// NOT change the invoice status; it only stamps last_reminder_sent so the AR view
// shows the contact.
export async function sendInvoiceReminderEmail(
  invoiceId: string,
  variant: 'reminder' | 'overdue',
): Promise<SendInvoiceResult> {
  const { result } = await deliverInvoiceEmail(invoiceId, variant);
  if (!result.ok) return result;
  try {
    await updateInvoice(invoiceId, { last_reminder_sent: new Date().toISOString() });
  } catch (err) {
    logger.error('stamp last_reminder_sent after reminder failed', err);
  }
  return result;
}

// Render the client-facing email body for an invoice WITHOUT sending anything
// (no Brevo call, no status change, no client_visible flip). Backs the admin
// "Preview email" surface so the exact copy a client would receive can be seen
// first. Returns null if the invoice is missing.
export async function renderInvoicePreview(
  invoiceId: string,
  variant: InvoiceEmailVariant,
): Promise<{ subject: string; html: string } | null> {
  const invoice = await getInvoice(invoiceId);
  if (!invoice) return null;
  const meta = await getClientMetadata(invoice.client_id).catch(() => null);
  const portalUrl = import.meta.env.SITE || 'https://codyasmith.com';
  return renderInvoiceEmail(invoiceEmailView(invoice, meta), variant, { portalUrl, now: new Date() });
}

// Payment receipt (Cody, 2026-06-04: all financial notices carry the accountant
// CC). Sent after a payment is recorded, to the billing contact + accountant CC
// + any per-invoice extra. Confirms the amount received and the remaining
// balance. Pure-ish: reads the (already-updated) invoice; soft-fails.
export async function sendPaymentReceiptEmail(invoiceId: string, paymentAmount: number): Promise<SendInvoiceResult> {
  const invoice = await getInvoice(invoiceId);
  if (!invoice) return { ok: false, to: [], cc: [], reason: 'not_found' };

  const meta = await getClientMetadata(invoice.client_id).catch(() => null);
  const users = await getUsersByClientId(invoice.client_id);
  const recipients = resolveInvoiceRecipients({
    primaryEmail: meta?.primary_contact_email,
    billingCcEmail: meta?.billing_cc_email,
    extraEmail: invoice.extra_recipient_email,
    fallbackEmails: users.map(u => u.email),
  });
  if (recipients.to.length === 0) return { ok: false, to: [], cc: [], reason: 'no_recipient' };

  const portalUrl = import.meta.env.SITE || 'https://codyasmith.com';
  const balance = invoice.total - (invoice.amount_paid || 0);
  const paidInFull = balance <= 0.005;
  const greetName = escapeHtml((meta?.primary_contact_name || '').split(' ')[0] || 'there');
  const balanceLine = paidInFull
    ? 'That settles this invoice in full. Thank you.'
    : `Your remaining balance on this invoice is <strong>${money(balance)}</strong>.`;

  const inner = `
    <h2 style="font-size: 22px; margin: 0 0 16px;">Payment received, thank you</h2>
    <p style="font-size: 15px; color: #4a4239; margin: 0 0 16px;">Hi ${greetName}, this confirms we received <strong>${money(paymentAmount)}</strong> toward invoice <strong>${escapeHtml(invoice.invoice_number)}</strong>. ${balanceLine}</p>
    <p style="margin: 24px 0;">
      <a href="${portalUrl}/portal/invoices" style="display: inline-block; background: #1a1814; color: #faf7f2; padding: 12px 22px; text-decoration: none; font-size: 15px;">View your invoices</a>
    </p>
    <p style="font-size: 14px; color: #6b6359; margin: 16px 0 0;">Keep this email for your records. Questions? Just reply.</p>
  `;
  const subject = paidInFull
    ? `Paid in full: invoice ${invoice.invoice_number}`
    : `Payment received: invoice ${invoice.invoice_number}`;

  const ok = await sendEmail(
    recipients.to.map((e, i) => ({ email: e, name: i === 0 ? (meta?.primary_contact_name || '') : '' })),
    subject,
    invoiceShell(inner),
    { cc: recipients.cc.map(e => ({ email: e })) }
  );

  return { ok, to: recipients.to, cc: recipients.cc, reason: ok ? undefined : 'send_failed' };
}
