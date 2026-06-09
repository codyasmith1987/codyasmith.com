// Admin endpoint: email an invoice to the client.
//
// POST -> generates the PDF, freezes the Bill To snapshot, sends to the
// client's billing contact (accountant CC'd, plus any per-invoice extra
// recipient), and transitions a draft to 'sent'. This is a deliberate
// admin action (a confirm dialog gates it in the UI), distinct from the
// automatic recurring/overdue mail. Returns who it went to.

import type { APIRoute } from 'astro';
import { getInvoice } from '../../../../../../lib/invoices';
import { sendInvoiceEmail } from '../../../../../../lib/invoice-emails';
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

export const POST: APIRoute = async ({ locals, params }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const invoice = await getInvoice(params.id!);
    if (!invoice) return json({ error: 'Not found' }, 404);

    const result = await sendInvoiceEmail(params.id!);
    if (!result.ok) {
      const r = REASONS[result.reason || ''] || { status: 500, message: 'Failed to send invoice' };
      return json({ error: r.message, reason: result.reason }, r.status);
    }

    const recipientStr = [...result.to, ...result.cc.map(c => `cc ${c}`)].join(', ');
    await logActivity({
      clientId: invoice.client_id,
      userId: locals.user!.id,
      action: 'sent',
      entityType: 'invoice',
      entityId: params.id!,
      summary: `${locals.user!.name} emailed invoice ${invoice.invoice_number} to ${recipientStr}`,
    });

    return json({ ok: true, to: result.to, cc: result.cc });
  } catch (err) {
    logger.error('Send invoice error', err);
    return json({ error: 'Failed to send invoice' }, 500);
  }
};
