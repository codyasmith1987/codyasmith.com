import type { APIRoute } from 'astro';
import { deleteUser } from '../../../../lib/auth';
import { logger } from '../../../../lib/logger';

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

    await deleteUser(user_id);
    return json({ ok: true });
  } catch (err: any) {
    logger.error('Delete user error', err);
    return json({ error: 'Failed to delete user' }, 500);
  }
};
