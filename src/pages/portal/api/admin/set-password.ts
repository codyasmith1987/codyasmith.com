import type { APIRoute } from 'astro';
import { setPassword } from '../../../../lib/auth';
import { logger } from '../../../../lib/logger';
import { logActivity } from '../../../../lib/activity';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const { user_id, password } = await request.json();
    if (!user_id || !password) return json({ error: 'user_id and password are required' }, 400);
    if (password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400);

    await setPassword(user_id, password);

    await logActivity({
      userId: locals.user!.id,
      action: 'updated',
      entityType: 'user',
      entityId: user_id,
      summary: `${locals.user!.name} set password for user ${user_id}`,
    });

    return json({ ok: true });
  } catch (err: any) {
    logger.error('Set password error', err);
    return json({ error: 'Failed to set password' }, 500);
  }
};
