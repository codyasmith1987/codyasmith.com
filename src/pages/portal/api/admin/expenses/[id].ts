// Admin expense deletion.
//
// Refuses to delete a pending_charge that has already been consumed
// into a non-draft invoice. Reason: once an invoice is beyond 'draft'
// the charge is part of a client-facing document and deleting it
// would silently desync the invoice total. Draft-bound charges are
// OK to delete; the admin can also delete the draft invoice outright
// via the existing /portal/api/admin/invoices/* routes if needed.
//
// Unbilled charges (billed_invoice_id IS NULL) are always safe to delete.

import type { APIRoute } from 'astro';
import turso from '../../../../../lib/turso';
import { logActivity } from '../../../../../lib/activity';
import { logger } from '../../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const DELETE: APIRoute = async ({ locals, params }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);
  const id = String(params.id ?? '');
  if (!id) return json({ error: 'id required' }, 400);

  try {
    const row = await turso.execute({
      sql: `SELECT pc.contract_id, pc.description, pc.billed_invoice_id, i.status AS invoice_status
            FROM pending_charges pc
            LEFT JOIN invoices i ON i.id = pc.billed_invoice_id
            WHERE pc.id = ?`,
      args: [id],
    });
    if (row.rows.length === 0) return json({ error: 'not found' }, 404);

    const r = row.rows[0];
    const contractId = r[0] as string;
    const description = r[1] as string;
    const billedInvoiceId = r[2] as string | null;
    const invoiceStatus = r[3] as string | null;

    // If the charge is bound to an invoice that's no longer a draft,
    // deletion would desync totals on a client-facing document. Reject.
    if (billedInvoiceId !== null && invoiceStatus !== null && invoiceStatus !== 'draft') {
      return json(
        {
          error: `cannot delete: already billed on invoice (status=${invoiceStatus}). Adjust the invoice directly.`,
        },
        409
      );
    }

    await turso.execute({ sql: 'DELETE FROM pending_charges WHERE id = ?', args: [id] });

    const contract = await turso.execute({
      sql: 'SELECT client_id, title FROM contracts WHERE id = ?',
      args: [contractId],
    });
    const clientId = contract.rows[0]?.[0] as string | undefined;
    const contractTitle = contract.rows[0]?.[1] as string | undefined;

    await logActivity({
      clientId: clientId ?? null,
      userId: locals.user!.id,
      action: 'deleted',
      entityType: 'pending_charge',
      entityId: id,
      summary: `${locals.user!.name} deleted expense "${description}"${contractTitle ? ` from ${contractTitle}` : ''}`,
    });

    return json({ ok: true });
  } catch (err: any) {
    logger.error('delete expense error', err);
    return json({ error: err?.message ?? 'failed' }, 500);
  }
};
