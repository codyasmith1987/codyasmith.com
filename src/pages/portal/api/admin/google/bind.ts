// POST /portal/api/admin/google/bind
//
// Stores { connection_id, property } in a data_source_bindings row's
// config_json, and flips enabled=1. After this call the binding is
// ready for sync.
//
// body: { binding_id, connection_id, property }

import type { APIRoute } from 'astro';
import turso from '../../../../../lib/turso';
import { getBindingById } from '../../../../../lib/data-sources';
import { getConnectionById } from '../../../../../lib/google/connections';
import { logActivity } from '../../../../../lib/activity';
import { logger } from '../../../../../lib/logger';
import { seedInitialSyncJob } from '../../../../../lib/jobs/google-sync-jobs';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const body = await request.json();
    const bindingId = String(body.binding_id ?? '').trim();
    const connectionId = String(body.connection_id ?? '').trim();
    const property = String(body.property ?? '').trim();

    if (!bindingId || !connectionId || !property) {
      return json({ error: 'binding_id, connection_id, and property are required' }, 400);
    }

    const binding = await getBindingById(bindingId);
    if (!binding) return json({ error: 'binding not found' }, 404);
    if (binding.source !== 'gsc' && binding.source !== 'ga4') {
      return json(
        { error: `cannot bind a Google connection to a ${binding.source} binding` },
        409
      );
    }

    const conn = await getConnectionById(connectionId);
    if (!conn) return json({ error: 'connection not found' }, 404);
    if (conn.admin_user_id !== locals.user!.id) {
      return json({ error: 'connection belongs to a different admin' }, 403);
    }

    const configJson = JSON.stringify({ connection_id: connectionId, property });
    await turso.execute({
      sql: `UPDATE data_source_bindings
            SET config_json = ?, enabled = 1
            WHERE id = ?`,
      args: [configJson, bindingId],
    });

    await logActivity({
      clientId: binding.client_id,
      userId: locals.user!.id,
      action: 'bound',
      entityType: 'data_source_binding',
      entityId: bindingId,
      summary: `${locals.user!.name} bound ${binding.source} to ${property} via connection ${conn.google_account_email}`,
    });

    // Slice 18e — seed the first recurring sync job for this binding.
    // Idempotent: if the binding already has a pending sync job (e.g.
    // admin is re-binding a live binding) this is a no-op. The chain
    // then self-perpetuates from inside the runner handler.
    const seeded = await seedInitialSyncJob(
      bindingId,
      binding.source,
      locals.user!.id
    );

    return json({
      ok: true,
      binding_id: bindingId,
      property,
      connection_id: connectionId,
      sync_seeded: seeded,
    });
  } catch (err) {
    logger.error('google bind error', err);
    return json({ error: String((err as Error)?.message ?? err) }, 500);
  }
};
