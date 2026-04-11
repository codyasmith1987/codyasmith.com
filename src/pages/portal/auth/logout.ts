import type { APIRoute } from 'astro';
import { invalidateSession, SESSION_COOKIE } from '../../../lib/auth';

export const prerender = false;

export const POST: APIRoute = async ({ locals, cookies, redirect }) => {
  if (locals.session) {
    await invalidateSession(locals.session.id);
  }

  cookies.delete(SESSION_COOKIE, { path: '/portal' });
  return redirect('/portal/login');
};
