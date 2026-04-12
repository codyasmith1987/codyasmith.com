import type { APIRoute } from 'astro';
import { recordPayment, getInvoice } from '../../../../../lib/invoices';
import { logActivity } from '../../../../../lib/activity';
import { logger } from '../../../../../lib/logger';
import { onPaymentRecorded } from '../../../../../lib/triggers';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const { invoice_id, amount, payment_method, reference, paid_at, notes } = await request.json();

    if (!invoice_id?.trim() || amount == null || !paid_at) {
      return json({ error: 'invoice_id, amount, and paid_at are required' }, 400);
    }

    const invoice = await getInvoice(invoice_id);
    if (!invoice) return json({ error: 'Invoice not found' }, 404);

    const id = await recordPayment({
      invoice_id: invoice_id.trim(),
      amount: Number(amount),
      payment_method: payment_method || undefined,
      reference: reference || undefined,
      paid_at,
      recorded_by: locals.user!.id,
      notes: notes?.trim() || undefined,
    });

    await logActivity({
      clientId: invoice.client_id,
      userId: locals.user!.id,
      action: 'created',
      entityType: 'payment',
      entityId: id,
      summary: `${locals.user!.name} recorded $${Number(amount).toFixed(2)} payment on invoice ${invoice.invoice_number}`,
    });

    await onPaymentRecorded(invoice_id, Number(amount));

    return json({ id }, 201);
  } catch (err) {
    logger.error('Record payment error', err);
    return json({ error: 'Failed to record payment' }, 500);
  }
};
