import { defineMiddleware } from 'astro:middleware';
import { validateSession, SESSION_COOKIE, isClientActive } from './lib/auth';
import { setRequestId } from './lib/logger';
import { runMigrations } from './lib/migrate';
import { generateCsrfToken, validateCsrfToken } from './lib/csrf';
import { logRequest, shouldLog } from './lib/request-log';

let reqCounter = 0;

export const onRequest = defineMiddleware(async (context, next) => {
  // Run migrations once at cold start (race-safe, idempotent)
  await runMigrations();

  // Generate request ID for correlation logging
  const requestId = `r${Date.now().toString(36)}-${(++reqCounter).toString(36)}`;
  setRequestId(requestId);

  // Add security headers to all responses
  const response = await handleRequest(context, next);
  response.headers.set('X-Request-Id', requestId);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  // CSP: allow self, inline scripts (Astro needs them), Google Fonts, jsDelivr for Chart.js
  response.headers.set('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
  ].join('; '));

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

  return next();
}
