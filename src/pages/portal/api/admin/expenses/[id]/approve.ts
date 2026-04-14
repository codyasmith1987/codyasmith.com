// Slice 14b — quick approve action for needs_approval pending_charges.
//
// Flips classification from 'needs_approval' to 'auto_bill' and
// clears the needs_approval bit. The row is NOT immediately attached
// to an invoice — it just rejoins the auto-bill queue so the next
// recurring invoice run picks it up (same behavior as any freshly
// auto-classified charge).
//
// Refuses to touch a row that is already billed (billed_invoice_id
// not null and invoice status beyond 'draft') or one whose current
// classification is not 'needs_approval'. Either case would mean
// Cody is attempting an action that doesn't make sense for the
// current state — fail loudly with 409 so the admin queue surfaces
// the drift rather than silently no-oping.

import type { APIRoute } from 'astro';
import turso from '../../../../../../lib/turso';
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
    const row = await turso.execute({
      sql: `SELECT pc.contract_id, pc.description, pc.amount, pc.classification,
                   pc.billed_invoice_id, i.status AS invoice_status
            FROM pending_charges pc
            LEFT JOIN invoices i ON i.id = pc.billed_invoice_id
            WHERE pc.id = ?`,
      args: [id],
    });
    if (row.rows.length === 0) return json({ error: 'not found' }, 404);

    const r = row.rows[0];
    const contractId = r[0] as string;
    const description = r[1] as string;
    const amount = Number(r[2]);
    const classification = r[3] as string | null;
    const billedInvoiceId = r[4] as string | null;
    const invoiceStatus = r[5] as string | null;

    if (classification !== 'needs_approval') {
      return json(
        {
          error: `cannot approve: classification is '${classification ?? 'NULL'}', expected 'needs_approval'`,
        },
        409
      );
    }
    if (billedInvoiceId !== null && invoiceStatus !== null && invoiceStatus !== 'draft') {
      return json(
        {
          error: `cannot approve: already billed on invoice (status=${invoiceStatus})`,
        },
        409
      );
    }

    await turso.execute({
      sql: `UPDATE pending_charges
            SET classification = 'auto_bill', needs_approval = 0
            WHERE id = ?`,
      args: [id],
    });

    const contract = await turso.execute({
      sql: 'SELECT client_id, title FROM contracts WHERE id = ?',
      args: [contractId],
    });
    const clientId = contract.rows[0]?.[0] as string | undefined;
    const contractTitle = contract.rows[0]?.[1] as string | undefined;

    await logActivity({
      clientId: clientId ?? null,
      userId: locals.user!.id,
      action: 'approved',
      entityType: 'pending_charge',
      entityId: id,
      summary: `${locals.user!.name} approved expense "${description}" ($${amount.toFixed(2)})${contractTitle ? ` on ${contractTitle}` : ''} — reclassified auto_bill`,
    });

    return json({ ok: true, id, classification: 'auto_bill' });
  } catch (err: any) {
    logger.error('approve expense error', err);
    return json({ error: err?.message ?? 'failed' }, 500);
  }
};
