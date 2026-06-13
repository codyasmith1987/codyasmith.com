import type { APIRoute } from 'astro';
import { validateMagicLink, createSession, SESSION_COOKIE, isUserActive } from '../../../lib/auth';
import { logActivity } from '../../../lib/activity';
import { rateLimit } from '../../../lib/rate-limit';

export const prerender = false;

// Allowlist for ?next= post-verify redirect targets. Must be a same-origin
// path under /portal/, no protocol, no scheme, no path traversal, no //
// (which some browsers parse as a protocol-relative URL).
function safeNextPath(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith('/portal/')) return null;
  if (raw.startsWith('//')) return null;
  if (raw.includes('\\')) return null;
  if (raw.includes('..')) return null;
  if (!/^\/portal\/[A-Za-z0-9/_.\-?=&%]*$/.test(raw)) return null;
  return raw;
}

export const GET: APIRoute = async ({ url, cookies, redirect, clientAddress, request }) => {
  const token = url.searchParams.get('token');
  const next = safeNextPath(url.searchParams.get('next'));

  if (!token) {
    return redirect('/portal/login');
  }

  // Defense-in-depth rate limit on token validation. The token is a 48-char
  // nanoid, so guessing is already infeasible; this just caps brute-force/DoS
  // attempts per IP. Fail-OPEN (4th arg false) so a transient Turso outage
  // never blocks a legitimate user arriving from their email link.
  const ip = clientAddress || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!await rateLimit(`verify:ip:${ip}`, 30, 15 * 60 * 1000, false)) {
    return redirect('/portal/login?error=expired');
  }

  const userId = await validateMagicLink(token);

  if (!userId) {
    // Token invalid or expired — redirect to login with error hint
    return redirect('/portal/login?error=expired');
  }

  // A deactivated user must not be able to ride a magic link back in.
  if (!await isUserActive(userId)) {
    return redirect('/portal/login?error=inactive');
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

  // Clear any pre-existing portal_session cookie before setting the new
  // one, but only if one exists. The login endpoint sets the cookie
  // with sameSite=strict; this endpoint sets it with sameSite=lax
  // (required for cross-site email arrivals). Some browsers do not
  // cleanly overwrite a same-name cookie when sameSite differs.
  //
  // Unconditional delete+set produced two Set-Cookie headers in the
  // response. In incognito (no prior cookie to collide with) the delete
  // header still fired, and on some browsers the order of processing
  // caused the new cookie to be effectively dropped. Conditional on
  // there actually being a prior cookie value avoids that case.
  if (cookies.get(SESSION_COOKIE)?.value) {
    cookies.delete(SESSION_COOKIE, { path: '/portal' });
  }

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

  // If a ?next=/portal/... was passed and passes the allowlist, send the
  // user there instead of the default set-password page. Used for sales
  // proposal magic-links so the recipient lands directly on the proposal
  // viewer (which is carved out from the password-set requirement).
  return redirect(next || '/portal/set-password');
};
