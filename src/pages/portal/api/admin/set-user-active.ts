import type { APIRoute } from 'astro';
import { setUserActive } from '../../../../lib/auth';
import { logActivity } from '../../../../lib/activity';
import { logger } from '../../../../lib/logger';
import turso from '../../../../lib/turso';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// Deactivate / reactivate a user. The preferred alternative to deleting a user:
// it revokes access and signs them out (setUserActive clears their sessions)
// while RETAINING the account and all of its history. Admin-only.
export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const { user_id, active } = await request.json();
    if (!user_id || typeof active !== 'boolean') {
      return json({ error: 'user_id and active (boolean) are required' }, 400);
    }

    // An admin cannot deactivate their own account, which would lock them out.
    if (user_id === locals.user!.id && !active) {
      return json({ error: 'You cannot deactivate your own account.' }, 400);
    }

    const lookup = await turso.execute({
      sql: 'SELECT name FROM users WHERE id = ?',
      args: [user_id],
    });
    if (lookup.rows.length === 0) return json({ error: 'User not found' }, 404);
    const userName = lookup.rows[0][0] as string;

    await setUserActive(user_id, active);

    await logActivity({
      userId: locals.user!.id,
      action: active ? 'activated' : 'deactivated',
      entityType: 'user',
      entityId: user_id,
      summary: `${locals.user!.name} ${active ? 'reactivated' : 'deactivated'} ${userName}`,
    });

    return json({ ok: true, active });
  } catch (err: any) {
    logger.error('Set user active error', err);
    return json({ error: 'Failed to update user' }, 500);
  }
};
