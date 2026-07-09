import type { APIRoute } from 'astro';
import { setPassword, PasswordPolicyError } from '../../../../lib/auth';
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

    // Length enforcement happens inside setPassword via the password policy
    // (>= 12 chars, <= 72 bytes). Caught below as PasswordPolicyError so the
    // user sees the specific failure reason.
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
    if (err instanceof PasswordPolicyError) {
      return json({ error: err.message }, 400);
    }
    logger.error('Set password error', err);
    return json({ error: 'Failed to set password' }, 500);
  }
};
