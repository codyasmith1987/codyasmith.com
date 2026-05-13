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

  // 1-hour session for magic-link arrivals. Middleware bounces them to
  // /portal/set-password where setPassword revokes the row on completion;
  // the short DB-side TTL is the failsafe when the user abandons before
  // setting a password. See security-audit-2026-05-12 round 6 SEC6-001.
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const sessionToken = await createSession(userId, ONE_HOUR_MS);

  await logActivity({
    userId,
    action: 'logged_in',
    entityType: 'session',
    entityId: userId,
    summary: 'User logged in via magic link',
  });

  // SameSite=Lax (not Strict) for this specific cookie set: the user is
  // arriving from an email client, which is a cross-site initiator. Some
  // browsers (notably Safari) refuse to set Strict cookies in cross-site
  // initiated navigations entirely, leaving the user with no session on
  // the immediate redirect to /portal/dashboard. Lax is the right floor
  // for top-level navigations. /portal/auth/login still uses Strict
  // because login submits are always same-site by the time they fire.
  // See security-audit-2026-05-12 round 5 SEC5-001.
  //
  // Short maxAge until the user has set a password. Middleware bounces
  // these sessions to /portal/set-password where setPassword revokes
  // them on completion, so the short TTL only matters as a failsafe
  // when the user abandons the flow. See SEC5-002.
  cookies.set(SESSION_COOKIE, sessionToken, {
    path: '/portal',
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 60 * 60, // 1 hour
  });

  return redirect('/portal/set-password');
};
