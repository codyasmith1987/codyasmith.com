// Notification endpoints — available to all authenticated users

import type { APIRoute } from 'astro';
import { getNotifications, getUnreadCount, markAsRead, markAllAsRead } from '../../../../lib/notifications';
import { logger } from '../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals, url }) => {
  if (!locals.user) return json({ error: 'Forbidden' }, 403);

  try {
    const countOnly = url.searchParams.get('count');
    if (countOnly === 'true') {
      const count = await getUnreadCount(locals.user.id);
      return json({ unread: count });
    }

    const limit = parseInt(url.searchParams.get('limit') || '50', 10);
    const notifications = await getNotifications(locals.user.id, limit);
    return json(notifications);
  } catch (err) {
    logger.error('Get notifications error', err);
    return json({ error: 'Failed to load notifications' }, 500);
  }
};

// Mark notification(s) as read
export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: 'Forbidden' }, 403);

  try {
    const { id, all } = await request.json();

    if (all) {
      await markAllAsRead(locals.user.id);
      return json({ ok: true });
    }

    if (id) {
      await markAsRead(id);
      return json({ ok: true });
    }

    return json({ error: 'id or all:true required' }, 400);
  } catch (err) {
    logger.error('Mark notification read error', err);
    return json({ error: 'Failed to update notification' }, 500);
  }
};
