// Pure invoice-email rendering. No DB, no network: takes a plain view of an
// invoice + a variant and returns { subject, html }. Kept separate from
// invoice-emails.ts (which loads the invoice, resolves recipients, and sends)
// so the exact same render feeds the live send, the per-invoice reminder/overdue
// action, AND the read-only preview -- what you preview is exactly what ships,
// and the copy lives in one place. Unit-tested in tests/run-invoice-email-template-tests.mjs.

import { escapeHtml } from './email-safety';

const FROM = 'Cody A Smith LLC';

export function money(n: number): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Cream editorial shell, matching the contract-flow emails for visual
// continuity. Inner HTML is the caller's responsibility to escape.
export function invoiceShell(inner: string): string {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 22px; color: #1a1814; line-height: 1.55;">
      ${inner}
      <p style="font-size: 13px; color: #6b6359; margin: 24px 0 0; padding-top: 16px; border-top: 1px solid #e6ddd0;">Cody Smith, Cody A Smith LLC &middot; codyasmith.com</p>
    </div>
  `;
}

// Whole days a due date is in the past relative to `now` (UTC date comparison).
// 0 when there is no due date or it is today/future. Pure: `now` is injected so
// the render is deterministic and testable.
export function daysPastDue(dueDate: string | null | undefined, now: Date): number {
  if (!dueDate) return 0;
  const due = Date.parse(String(dueDate).slice(0, 10) + 'T00:00:00Z');
  if (Number.isNaN(due)) return 0;
  const today = Date.parse(now.toISOString().slice(0, 10) + 'T00:00:00Z');
  const diff = Math.floor((today - due) / 86400000);
  return diff > 0 ? diff : 0;
}

export type InvoiceEmailVariant = 'ready' | 'reminder' | 'overdue';

// Everything the templates need, decoupled from the DB Invoice row.
export interface InvoiceEmailView {
  invoice_number: string;
  title: string | null;
  total: number;
  amount_paid: number;
  due_date: string | null;
  terms_label: string | null;
  greet_name: string;
}

// Render the chosen variant. `ready` is byte-for-byte the long-standing
// "Your invoice is ready" email. `reminder` is a gentle pre/at-due nudge.
// `overdue` names the days past due (when known) in a professional, non-harsh
// tone that defers to "payment may already be on the way."
export function renderInvoiceEmail(
  view: InvoiceEmailView,
  variant: InvoiceEmailVariant,
  opts: { portalUrl: string; now: Date }
): { subject: string; html: string } {
  const balance = view.total - (view.amount_paid || 0);
  const amountLine = (view.amount_paid || 0) > 0
    ? `${money(view.total)} total, ${money(balance)} now due`
    : `${money(view.total)} due`;
  const dueLine = view.terms_label
    ? escapeHtml(view.terms_label)
    : view.due_date ? `by ${escapeHtml(view.due_date)}` : 'upon receipt';
  const what = view.title ? escapeHtml(view.title) : `invoice ${escapeHtml(view.invoice_number)}`;
  const greet = escapeHtml(view.greet_name || 'there');
  const amount = escapeHtml(amountLine);
  const dpd = daysPastDue(view.due_date, opts.now);
  const cta = `<p style="margin: 24px 0;">
      <a href="${opts.portalUrl}/portal/invoices" style="display: inline-block; background: #1a1814; color: #faf7f2; padding: 12px 22px; text-decoration: none; font-size: 15px;">View invoice in portal</a>
    </p>`;
  const reply = `<p style="font-size: 14px; color: #6b6359; margin: 16px 0 0;">Questions about anything on it? Just reply to this email.</p>`;

  let heading: string;
  let lead: string;
  let subject: string;

  // Subjects are plain-text RFC 5322 headers, NOT HTML: sendEmail CRLF-strips
  // them, and HTML-escaping here would ship literal "&amp;" in the inbox for a
  // title like "Web Management & Marketing" (triple audit 2026-06-09). Only the
  // HTML body uses escapeHtml.
  if (variant === 'overdue') {
    heading = 'Invoice past due';
    const dueClause = dpd > 0 && view.due_date
      ? `was due ${escapeHtml(view.due_date)} and is now ${dpd} day${dpd === 1 ? '' : 's'} past due`
      : 'is now past due';
    lead = `Hi ${greet}, a quick note that your ${what} (<strong>${amount}</strong>) ${dueClause}. If payment is already on the way, thank you and please disregard. Otherwise we would appreciate settling it at your earliest convenience.`;
    subject = view.title
      ? `Past due: ${view.title} (${view.invoice_number})`
      : `Past due: invoice ${view.invoice_number}`;
  } else if (variant === 'reminder') {
    heading = 'A reminder on your invoice';
    lead = `Hi ${greet}, a friendly reminder that your ${what} (<strong>${amount}</strong>) is due ${dueLine}. The same copy is in your portal, and the PDF is attached. Thank you.`;
    subject = view.title
      ? `Reminder: ${view.title} (${view.invoice_number})`
      : `Reminder: invoice ${view.invoice_number}`;
  } else {
    heading = 'Your invoice is ready';
    lead = `Hi ${greet}, here is your ${what}: <strong>${amount}</strong>, due ${dueLine}. The PDF is attached, and the same copy is in your portal.`;
    subject = view.title
      ? `Your invoice: ${view.title} (${view.invoice_number})`
      : `Your invoice ${view.invoice_number} from ${FROM}`;
  }

  const inner = `
    <h2 style="font-size: 22px; margin: 0 0 16px;">${heading}</h2>
    <p style="font-size: 15px; color: #4a4239; margin: 0 0 16px;">${lead}</p>
    ${cta}
    ${reply}
  `;
  return { subject, html: invoiceShell(inner) };
}

// Pick the default variant for an automatic/first send from invoice status: an
// already-overdue invoice sends the overdue copy, everything else the "ready"
// copy. (Explicit admin actions pass the variant directly.)
export function variantForStatus(status: string): InvoiceEmailVariant {
  return status === 'overdue' ? 'overdue' : 'ready';
}

// Statuses for which a manual reminder/overdue notice may be sent. A draft has
// never reached the client (nothing to remind about); paid is settled;
// cancelled is voided; carried_forward's balance lives on the invoice it rolled
// into, so dunning it would demand money already consolidated (the same
// double-count class the terminal-status guards block elsewhere -- triple audit
// 2026-06-09). payment_pending stays eligible: "the check is in the mail" can
// still warrant a deliberate admin nudge if it never arrives. Single source of
// truth for the lib guard AND the admin UI button visibility.
export const REMINDER_ELIGIBLE_STATUSES = ['sent', 'partial', 'overdue', 'payment_pending'] as const;

export function reminderEligibleStatus(status: string): boolean {
  return (REMINDER_ELIGIBLE_STATUSES as readonly string[]).includes(status);
}
