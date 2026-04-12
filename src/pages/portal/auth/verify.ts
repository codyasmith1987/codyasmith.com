import type { APIRoute } from 'astro';
import { validateMagicLink, createSession, SESSION_COOKIE } from '../../../lib/auth';
import { logActivity } from '../../../lib/activity';

export const prerender = false;

export const GET: APIRoute = async ({ url, cookies, redirect }) => {
  const token = url.searchParams.get('token');

  if (!token) {
    return redirect('/portal/login');
  }

  const userId = await validateMagicLink(token);

  if (!userId) {
    // Token invalid or expired — redirect to login with error hint
    return redirect('/portal/login?error=expired');
  }

  const sessionToken = await createSession(userId);

  await logActivity({
    userId,
    action: 'logged_in',
    entityType: 'session',
    entityId: userId,
    summary: 'User logged in via magic link',
  });

  cookies.set(SESSION_COOKIE, sessionToken, {
    path: '/portal',
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60, // 30 days in seconds
  });

  return redirect('/portal/dashboard');
};
