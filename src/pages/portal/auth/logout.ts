import type { APIRoute } from 'astro';
import { invalidateSession, SESSION_COOKIE } from '../../../lib/auth';
import { logActivity } from '../../../lib/activity';

export const prerender = false;

export const POST: APIRoute = async ({ locals, cookies, redirect }) => {
  if (locals.session) {
    await invalidateSession(locals.session.id);
  }

  if (locals.user) {
    await logActivity({
      userId: locals.user.id,
      action: 'logged_out',
      entityType: 'session',
      entityId: locals.user.id,
      summary: `${locals.user.name} logged out`,
    });
  }

  cookies.delete(SESSION_COOKIE, { path: '/portal' });
  return redirect('/portal/login');
};
