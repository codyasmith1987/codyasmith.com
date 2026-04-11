import type { APIRoute } from 'astro';
import { revokeUserSessions } from '../../../../lib/auth';
import { logger } from '../../../../lib/logger';
import { logActivity } from '../../../../lib/activity';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const { user_id } = await request.json();
    if (!user_id) return json({ error: 'user_id is required' }, 400);

    const count = await revokeUserSessions(user_id);

    await logActivity({
      userId: locals.user!.id,
      action: 'revoked',
      entityType: 'session',
      entityId: user_id,
      summary: `${locals.user!.name} revoked ${count} session(s) for user ${user_id}`,
    });

    return json({ ok: true, sessions_revoked: count });
  } catch (err: any) {
    logger.error('Revoke sessions error', err);
    return json({ error: 'Failed to revoke sessions' }, 500);
  }
};
