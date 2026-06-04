import type { APIRoute } from 'astro';
import { getInvoice, duplicateInvoice } from '../../../../../../lib/invoices';
import { logActivity } from '../../../../../../lib/activity';
import { logger } from '../../../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// Clone an invoice into a new editable draft. The copy is a draft and not
// client-visible, so this has no client-facing side effect.
export const POST: APIRoute = async ({ locals, params }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const source = await getInvoice(params.id!);
    if (!source) return json({ error: 'Not found' }, 404);

    const { id, invoice_number } = await duplicateInvoice(params.id!, locals.user!.id);

    await logActivity({
      clientId: source.client_id,
      userId: locals.user!.id,
      action: 'created',
      entityType: 'invoice',
      entityId: id,
      summary: `${locals.user!.name} duplicated invoice ${source.invoice_number} as ${invoice_number}`,
    });

    return json({ id, invoice_number });
  } catch (err) {
    logger.error('Duplicate invoice error', err);
    return json({ error: 'Failed to duplicate invoice' }, 500);
  }
};
