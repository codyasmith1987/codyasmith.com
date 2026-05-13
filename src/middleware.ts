import { defineMiddleware } from 'astro:middleware';
import { validateSession, SESSION_COOKIE, isClientActive, userHasPassword } from './lib/auth';
import { setRequestId } from './lib/logger';
import { runMigrations } from './lib/migrate';
import { generateCsrfToken, validateCsrfToken } from './lib/csrf';
import { logRequest, shouldLog } from './lib/request-log';
import { maybeSweepRetention } from './lib/retention';
import { SECURITY_HEADERS } from './lib/security-headers';

let reqCounter = 0;

export const onRequest = defineMiddleware(async (context, next) => {
  // Run migrations once at cold start (race-safe, idempotent)
  await runMigrations();

  // Generate request ID for correlation logging
  const requestId = `r${Date.now().toString(36)}-${(++reqCounter).toString(36)}`;
  setRequestId(requestId);

  // Add security headers to all responses. Single source of truth is
  // src/lib/security-headers.ts; the postbuild wrapper reads the same
  // module via tsx import. See SEC4-003.
  const response = await handleRequest(context, next);
  response.headers.set('X-Request-Id', requestId);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(key, value);
  }

  // Portal pages should never be indexed. Belt-and-suspenders the
  // <meta name="robots"> tag on /portal/login with an HTTP-level signal
  // that also covers redirect responses with no HTML body.
  if (context.url.pathname.startsWith('/portal')) {
    response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  }

  // First-party request log for the public surface. Fire and forget so the
  // response isn't blocked. Portal pages and assets are excluded.
  if (shouldLog(context.url.pathname)) {
    void logRequest({
      path: context.url.pathname,
      method: context.request.method,
      referrer: context.request.headers.get('referer'),
      userAgent: context.request.headers.get('user-agent'),
      country: context.request.headers.get('cf-ipcountry'),
      statusCode: response.status,
    });
  }

  // Retention sweep on a throttled interval (at most once per hour
  // across the whole process). Deletes request_log rows older than 90
  // days and rate_limits rows older than 30 days. See SEC-020.
  maybeSweepRetention();

  return response;
});

async function handleRequest(context: Parameters<Parameters<typeof defineMiddleware>[0]>[0], next: Parameters<Parameters<typeof defineMiddleware>[0]>[1]): Promise<Response> {
  // Only protect /portal/* routes
  if (!context.url.pathname.startsWith('/portal')) {
    return next();
  }

  // Allow login and auth routes without session
  if (
    context.url.pathname === '/portal/login' ||
    context.url.pathname.startsWith('/portal/auth/')
  ) {
    return next();
  }

  const token = context.cookies.get(SESSION_COOKIE)?.value;
  if (!token) {
    return context.redirect('/portal/login');
  }

  const result = await validateSession(token);
  if (!result) {
    context.cookies.delete(SESSION_COOKIE, { path: '/portal' });
    return context.redirect('/portal/login');
  }

  context.locals.user = result.user;
  context.locals.session = result.session;
  context.locals.csrfToken = generateCsrfToken(result.session!.id);

  // Reject oversized request bodies (1MB limit) on portal API routes
  const MAX_BODY_SIZE = 1024 * 1024; // 1MB
  const contentLength = parseInt(context.request.headers.get('content-length') || '0', 10);
  if (contentLength > MAX_BODY_SIZE && context.url.pathname.startsWith('/portal/api/')) {
    return new Response(JSON.stringify({ error: 'Request body too large' }), {
      status: 413,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // CSRF validation for all state-mutating requests to portal API routes
  const mutating = ['POST', 'PUT', 'DELETE', 'PATCH'];
  if (mutating.includes(context.request.method) && context.url.pathname.startsWith('/portal/api/')) {
    const csrfToken = context.request.headers.get('X-CSRF-Token');
    if (!validateCsrfToken(result.session!.id, csrfToken || '')) {
      return new Response(JSON.stringify({ error: 'Invalid or missing CSRF token' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // Block users on inactive clients
  if (result.user?.client_id && result.user.role !== 'admin') {
    const active = await isClientActive(result.user.client_id);
    if (!active) {
      context.cookies.delete(SESSION_COOKIE, { path: '/portal' });
      return context.redirect('/portal/login?error=inactive');
    }
  }

  // Block non-admin users from admin routes — redirect to dashboard instead of blank 403
  if (context.url.pathname.startsWith('/portal/admin') && result.user?.role !== 'admin') {
    return context.redirect('/portal/dashboard');
  }

  // Magic-link onboarding requires the user to set a password before
  // they can use the rest of the portal. Otherwise a magic link is a
  // 30-day session equivalent of a password and the password flow on
  // /portal/login is moot. See security-audit-2026-05-12 round 3
  // SEC3-008.
  const isSetPasswordRoute = context.url.pathname === '/portal/set-password';
  const isSelfSetPasswordApi = context.url.pathname === '/portal/api/auth/set-own-password';
  if (
    !isSetPasswordRoute &&
    !isSelfSetPasswordApi &&
    !context.url.pathname.startsWith('/portal/api/notifications') &&
    !await userHasPassword(result.user!.id)
  ) {
    return context.redirect('/portal/set-password');
  }

  return next();
}
