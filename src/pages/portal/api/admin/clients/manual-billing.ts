// Admin endpoint: set a client's "manual billing" flag.
//
// POST { client_id, manual_billing: boolean }
//
// When manual_billing is true the client is billed entirely by hand: the
// automated engine never generates recurring invoices, sends pre-due reminders,
// or sends overdue notices for them (see billing.ts). Used to keep a
// non-standard / transitional client (e.g. ZipKit, pending a v7 re-paper) off
// automation until they are ready. Marking invoices overdue for visibility is
// unaffected; this only governs outbound automated billing.

import type { APIRoute } from 'astro';
import turso from '../../../../../lib/turso';
import { getClientById } from '../../../../../lib/auth';
import { logger } from '../../../../../lib/logger';
import { logActivity } from '../../../../../lib/activity';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  let body: any;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const clientId = (body?.client_id || '').toString().trim();
  if (!clientId) return json({ error: 'client_id is required' }, 400);
  if (typeof body.manual_billing !== 'boolean') return json({ error: 'manual_billing must be a boolean' }, 400);

  const client = await getClientById(clientId);
  if (!client) return json({ error: 'Client not found' }, 404);

  const value = body.manual_billing ? 1 : 0;
  try {
    await turso.execute({ sql: 'UPDATE clients SET manual_billing = ? WHERE id = ?', args: [value, clientId] });
    await logActivity({
      clientId,
      userId: locals.user!.id,
      action: 'updated',
      entityType: 'client',
      entityId: clientId,
      summary: `${locals.user!.name} set ${client.name} to ${value ? 'manual (hand-billed)' : 'automated'} billing`,
    });
    return json({ ok: true, manual_billing: !!value });
  } catch (err: any) {
    logger.error('Set manual_billing failed', err);
    return json({ error: 'Failed to update billing mode' }, 500);
  }
};
