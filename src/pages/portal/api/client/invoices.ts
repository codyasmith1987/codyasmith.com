// Client-facing: visible invoices with payment status (no internal cost breakdowns)

import type { APIRoute } from 'astro';
import { getClientVisibleInvoices, getInvoiceItems, getPaymentsByInvoice } from '../../../../lib/invoices';
import { logger } from '../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals }) => {
  if (!locals.user?.client_id) return json({ error: 'Forbidden' }, 403);

  try {
    const invoices = await getClientVisibleInvoices(locals.user.client_id);

    const enriched = await Promise.all(invoices.map(async (inv) => {
      const items = await getInvoiceItems(inv.id);
      const payments = await getPaymentsByInvoice(inv.id);

      return {
        id: inv.id,
        invoice_number: inv.invoice_number,
        status: inv.status,
        issued_date: inv.issued_date,
        due_date: inv.due_date,
        total: inv.total,
        amount_paid: inv.amount_paid,
        notes: inv.notes,
        items: items.map(item => ({
          description: item.description,
          quantity: item.quantity,
          unit_price: item.unit_price,
          amount: item.amount,
        })),
        payments: payments.map(p => ({
          amount: p.amount,
          paid_at: p.paid_at,
          payment_method: p.payment_method,
        })),
      };
    }));

    return json(enriched);
  } catch (err) {
    logger.error('Client invoices error', err);
    return json({ error: 'Failed to load invoices' }, 500);
  }
};
