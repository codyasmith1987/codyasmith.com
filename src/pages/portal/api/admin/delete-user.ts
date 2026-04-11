import type { APIRoute } from 'astro';
import { deleteUser } from '../../../../lib/auth';
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

    // Prevent self-deletion
    if (user_id === locals.user.id) {
      return json({ error: 'You cannot delete your own account' }, 400);
    }

    // Log before delete — the user record won't exist after
    await logActivity({
      userId: locals.user!.id,
      action: 'deleted',
      entityType: 'user',
      entityId: user_id,
      summary: `${locals.user!.name} deleted user ${user_id}`,
    });

    await deleteUser(user_id);
    return json({ ok: true });
  } catch (err: any) {
    logger.error('Delete user error', err);
    return json({ error: 'Failed to delete user' }, 500);
  }
};
