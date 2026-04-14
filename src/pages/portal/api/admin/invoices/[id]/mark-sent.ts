// Admin action — promote a draft invoice to sent.
//
// This is the missing bridge between "invoice generated" and "client
// gets reminders". generateInvoiceForContract always writes status=draft
// so Cody can review before it goes client-visible. sendDueReminders
// only fires for status=sent. Without a mark-sent step, invoices stall
// forever and reminders are a no-op. This endpoint closes that gap with
// one explicit, admin-triggered transition.
//
// Behavior:
//   - 403 if caller is not admin
//   - 404 if the invoice doesn't exist
//   - 409 if the invoice is already sent (or any other non-draft state)
//   - On success: UPDATE status='sent', set issued_date to today if it
//     was null, log activity, fire onInvoiceSent trigger (notifies the
//     client's portal users that the invoice is ready).
//
// CSRF-protected by middleware. Invoked from the admin queue row and
// from future invoice detail views.

import type { APIRoute } from 'astro';
import turso from '../../../../../../lib/turso';
import { getInvoice } from '../../../../../../lib/invoices';
import { onInvoiceSent } from '../../../../../../lib/triggers';
import { logActivity } from '../../../../../../lib/activity';
import { logger } from '../../../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ locals, params }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);
  const id = String(params.id ?? '');
  if (!id) return json({ error: 'id required' }, 400);

  try {
    const invoice = await getInvoice(id);
    if (!invoice) return json({ error: 'invoice not found' }, 404);
    if (invoice.status !== 'draft') {
      return json({ error: `invoice is ${invoice.status}, not draft` }, 409);
    }

    const today = new Date().toISOString().split('T')[0];
    const issuedDate = invoice.issued_date ?? today;

    await turso.execute({
      sql: `UPDATE invoices
            SET status = 'sent', issued_date = ?, updated_at = datetime('now')
            WHERE id = ?`,
      args: [issuedDate, id],
    });

    await logActivity({
      clientId: invoice.client_id,
      userId: locals.user!.id,
      action: 'sent',
      entityType: 'invoice',
      entityId: id,
      summary: `${locals.user!.name} marked ${invoice.invoice_number} as sent ($${invoice.total.toFixed(2)})`,
    });

    // Fire the notification trigger — writes to in-app notifications for
    // the client's portal users. Does NOT dispatch email here; reminder
    // email still fires via the scheduled send_reminders job once the
    // due date approaches.
    await onInvoiceSent(id);

    return json({ ok: true, id, status: 'sent', issued_date: issuedDate });
  } catch (err: any) {
    logger.error('mark-sent error', err);
    return json({ error: err?.message ?? 'failed' }, 500);
  }
};
