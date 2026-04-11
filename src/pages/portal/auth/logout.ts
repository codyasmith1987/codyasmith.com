import type { APIRoute } from 'astro';
import { validateSession, invalidateSession, SESSION_COOKIE } from '../../../lib/auth';
import { logActivity } from '../../../lib/activity';

export const prerender = false;

export const POST: APIRoute = async ({ cookies, redirect }) => {
  // Auth routes are exempt from middleware session validation,
  // so we must read the session cookie directly here.
  const token = cookies.get(SESSION_COOKIE)?.value;

  if (token) {
    const result = await validateSession(token);
    if (result) {
      await invalidateSession(result.session!.id);
      await logActivity({
        userId: result.user!.id,
        action: 'logged_out',
        entityType: 'session',
        entityId: result.user!.id,
        summary: `${result.user!.name} logged out`,
      });
    }
  }

  cookies.delete(SESSION_COOKIE, { path: '/portal' });
  return redirect('/portal/login');
};
