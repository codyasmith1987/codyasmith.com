// Admin endpoint: send a single-invoice reminder or overdue notice on demand.
//
// POST { variant: 'reminder' | 'overdue' } -> renders that variant, attaches the
// PDF, and emails the client's billing contact (accountant CC'd, plus any
// per-invoice extra). Distinct from the nightly cron dunning: this is an explicit
// admin click, so it IS allowed for a hand-billed (manual_billing) client. It
// does not change the invoice status; it stamps last_reminder_sent. Returns who
// it went to.

import type { APIRoute } from 'astro';
import { getInvoice } from '../../../../../../lib/invoices';
import { sendInvoiceReminderEmail } from '../../../../../../lib/invoice-emails';
import { logActivity } from '../../../../../../lib/activity';
import { logger } from '../../../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const REASONS: Record<string, { status: number; message: string }> = {
  not_found: { status: 404, message: 'Invoice not found' },
  no_recipient: { status: 400, message: 'No billing contact set for this client. Add a primary contact email first.' },
  empty_invoice: { status: 400, message: 'This invoice has no charges yet (total is $0.00). Add line items before sending it.' },
  pdf_failed: { status: 500, message: 'Could not generate the invoice PDF' },
  send_failed: { status: 502, message: 'The email could not be sent. Check the email configuration and try again.' },
};

export const POST: APIRoute = async ({ locals, params, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const invoice = await getInvoice(params.id!);
    if (!invoice) return json({ error: 'Not found' }, 404);

    const body = await request.json().catch(() => ({}));
    const variant = body?.variant;
    if (variant !== 'reminder' && variant !== 'overdue') {
      return json({ error: 'variant must be "reminder" or "overdue"' }, 400);
    }

    const result = await sendInvoiceReminderEmail(params.id!, variant);
    if (!result.ok) {
      const r = REASONS[result.reason || ''] || { status: 500, message: 'Failed to send notice' };
      return json({ error: r.message, reason: result.reason }, r.status);
    }

    const recipientStr = [...result.to, ...result.cc.map(c => `cc ${c}`)].join(', ');
    await logActivity({
      clientId: invoice.client_id,
      userId: locals.user!.id,
      action: 'sent',
      entityType: 'invoice',
      entityId: params.id!,
      summary: `${locals.user!.name} sent a ${variant === 'overdue' ? 'past-due notice' : 'reminder'} for invoice ${invoice.invoice_number} to ${recipientStr}`,
    });

    return json({ ok: true, to: result.to, cc: result.cc });
  } catch (err) {
    logger.error('Send invoice reminder error', err);
    return json({ error: 'Failed to send notice' }, 500);
  }
};
