import type { APIRoute } from 'astro';
import { toggleClientActive } from '../../../../lib/auth';
import { logger } from '../../../../lib/logger';
import { logActivity } from '../../../../lib/activity';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const { client_id } = await request.json();
    if (!client_id) return json({ error: 'client_id is required' }, 400);

    const active = await toggleClientActive(client_id);

    await logActivity({
      clientId: client_id,
      userId: locals.user!.id,
      action: 'updated',
      entityType: 'client',
      entityId: client_id,
      summary: `${locals.user!.name} ${active ? 'activated' : 'deactivated'} client ${client_id}`,
    });

    return json({ client_id, active });
  } catch (err: any) {
    logger.error('Toggle client error', err);
    return json({ error: err.message || 'Failed to toggle client' }, 500);
  }
};
