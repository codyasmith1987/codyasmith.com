import type { APIRoute } from 'astro';
import { nanoid } from 'nanoid';
import turso from '../../../../lib/turso';
import { logger } from '../../../../lib/logger';
import { logActivity } from '../../../../lib/activity';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const { client_id, month, category, metric_key, metric_value } = await request.json();

    if (!client_id || !month || !category || !metric_key || metric_value === undefined) {
      return json({ error: 'All fields required: client_id, month, category, metric_key, metric_value' }, 400);
    }

    await turso.execute({
      sql: `INSERT OR REPLACE INTO metrics (id, client_id, month, category, metric_key, metric_value, source)
            VALUES (?, ?, ?, ?, ?, ?, 'manual')
            ON CONFLICT(client_id, month, category, metric_key)
            DO UPDATE SET metric_value = excluded.metric_value, source = 'manual'`,
      args: [nanoid(), client_id, month, category, metric_key, parseFloat(metric_value)],
    });

    await logActivity({
      clientId: client_id,
      userId: locals.user!.id,
      action: 'created',
      entityType: 'metric',
      entityId: `${client_id}:${month}:${category}:${metric_key}`,
      summary: `${locals.user!.name} set ${category}.${metric_key} = ${metric_value}`,
    });

    return json({ ok: true });
  } catch (err: any) {
    logger.error('Manual metric error', err);
    return json({ error: 'Failed to save metric' }, 500);
  }
};
