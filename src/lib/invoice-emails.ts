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

import { getInvoice, updateInvoice } from './invoices';
import { getClientMetadata } from './agreements';
import { getUsersByClientId, getAllClients } from './auth';
import { generateInvoicePdf } from './pdf';
import { sendEmail } from './email';
import { escapeHtml } from './email-safety';
import { logger } from './logger';

const FROM = 'Cody A Smith LLC';

// Cream editorial shell, matching the contract-flow emails for visual
// continuity. Inner HTML is the caller's responsibility to escape.
function invoiceShell(inner: string): string {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 22px; color: #1a1814; line-height: 1.55;">
      ${inner}
      <p style="font-size: 13px; color: #6b6359; margin: 24px 0 0; padding-top: 16px; border-top: 1px solid #e6ddd0;">Cody Smith, Cody A Smith LLC &middot; codyasmith.com</p>
    </div>
  `;
}

function money(n: number): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export interface SendInvoiceResult {
  ok: boolean;
  to: string[];
  cc: string[];
  reason?: string;
}

// Email a single invoice to the client's billing contact (PDF attached, the
// accountant CC'd, plus any per-invoice extra recipient). Freezes the Bill To
// snapshot at send time so later metadata edits never rewrite a sent invoice.
// Transitions a draft to 'sent' and stamps an issue date. Returns who it went
// to so the caller can surface it. Never throws on a soft failure (no
// recipient, send rejected) — it reports via { ok:false, reason }.
export async function sendInvoiceEmail(invoiceId: string): Promise<SendInvoiceResult> {
  const invoice = await getInvoice(invoiceId);
  if (!invoice) return { ok: false, to: [], cc: [], reason: 'not_found' };

  const meta = await getClientMetadata(invoice.client_id).catch(() => null);
  const users = await getUsersByClientId(invoice.client_id);
  const clients = await getAllClients();
  const clientName = clients.find(c => c.id === invoice.client_id)?.name || 'there';

  const recipients = resolveInvoiceRecipients({
    primaryEmail: meta?.primary_contact_email,
    billingCcEmail: meta?.billing_cc_email,
    extraEmail: invoice.extra_recipient_email,
    fallbackEmails: users.map(u => u.email),
  });
  if (recipients.to.length === 0) return { ok: false, to: [], cc: [], reason: 'no_recipient' };

  // Freeze the Bill To from the live record at send time. The PDF and any
  // re-send then render the snapshot, so editing client metadata later does
  // not retroactively change an invoice already in the client's inbox.
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
    logger.error(`sendInvoiceEmail: PDF generation failed for ${invoiceId}`, err);
    return { ok: false, to: recipients.to, cc: recipients.cc, reason: 'pdf_failed' };
  }

  const portalUrl = import.meta.env.SITE || 'https://codyasmith.com';
  const balance = invoice.total - (invoice.amount_paid || 0);
  const amountLine = (invoice.amount_paid || 0) > 0
    ? `${money(invoice.total)} total, ${money(balance)} now due`
    : `${money(invoice.total)} due`;
  const dueLine = invoice.terms_label
    ? escapeHtml(invoice.terms_label)
    : invoice.due_date ? `by ${escapeHtml(invoice.due_date)}` : 'upon receipt';
  const what = invoice.title ? escapeHtml(invoice.title) : `invoice ${escapeHtml(invoice.invoice_number)}`;
  const greetName = escapeHtml((meta?.primary_contact_name || clientName).split(' ')[0] || 'there');

  const inner = `
    <h2 style="font-size: 22px; margin: 0 0 16px;">Your invoice is ready</h2>
    <p style="font-size: 15px; color: #4a4239; margin: 0 0 16px;">Hi ${greetName}, here is your ${what}: <strong>${escapeHtml(amountLine)}</strong>, due ${dueLine}. The PDF is attached, and the same copy is in your portal.</p>
    <p style="margin: 24px 0;">
      <a href="${portalUrl}/portal/invoices" style="display: inline-block; background: #1a1814; color: #faf7f2; padding: 12px 22px; text-decoration: none; font-size: 15px;">View invoice in portal</a>
    </p>
    <p style="font-size: 14px; color: #6b6359; margin: 16px 0 0;">Questions about anything on it? Just reply to this email.</p>
  `;
  const subject = invoice.title
    ? `Your invoice: ${invoice.title} (${invoice.invoice_number})`
    : `Your invoice ${invoice.invoice_number} from ${FROM}`;

  const toName = meta?.primary_contact_name || '';
  const ok = await sendEmail(
    recipients.to.map((e, i) => ({ email: e, name: i === 0 ? toName : '' })),
    subject,
    invoiceShell(inner),
    {
      cc: recipients.cc.map(e => ({ email: e })),
      attachments: [{ name: `${invoice.invoice_number}.pdf`, content: pdfBase64 }],
    }
  );

  if (!ok) return { ok: false, to: recipients.to, cc: recipients.cc, reason: 'send_failed' };

  // On a successful send: mark a draft as sent, stamp an issue date if missing,
  // and fire the in-portal "invoice ready" notification only on the draft->sent
  // transition (so a re-send does not duplicate the notification).
  const wasDraft = invoice.status === 'draft';
  const patch: Record<string, any> = {};
  if (wasDraft) patch.status = 'sent';
  if (!invoice.issued_date) patch.issued_date = new Date().toISOString().split('T')[0];
  // Emailing the invoice to the client inherently makes it client-visible. New
  // invoices default to client_visible = 0, so without this the email's "the
  // same copy is in your portal" line would point at a page where the invoice
  // is hidden. (The recurring path already sets this; the manual Send must too.)
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

  return { ok: true, to: recipients.to, cc: recipients.cc };
}
