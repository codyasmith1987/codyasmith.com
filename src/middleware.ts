import { defineMiddleware } from 'astro:middleware';
import { validateSession, SESSION_COOKIE, isClientActive, userHasPassword } from './lib/auth';
import { runWithRequestId } from './lib/logger';
import { runMigrations } from './lib/migrate';
import { generateCsrfToken, validateCsrfToken } from './lib/csrf';
import { logRequest, shouldLog } from './lib/request-log';
import { maybeSweepRetention } from './lib/retention';
import { SECURITY_HEADERS } from './lib/security-headers';

let reqCounter = 0;

// Allow-list of origins permitted to make state-mutating POSTs to
// /portal/api/. Astro's checkOrigin is disabled because the framework
// uses request.url.host, which behind Cloudflare + DO can be the DO
// ingress hostname; our own check uses an explicit list so header
// rewrites cannot turn it into a false positive or false negative.
const ALLOWED_ORIGINS: Set<string> = new Set([
  'https://codyasmith.com',
  'https://www.codyasmith.com',
]);
// Dev origins: enabled only when running in non-production mode so a
// production runtime never accepts a localhost-origin request.
if (import.meta.env.DEV || process.env.NODE_ENV === 'development') {
  ALLOWED_ORIGINS.add('http://localhost:4321');
  ALLOWED_ORIGINS.add('http://localhost:3000');
  ALLOWED_ORIGINS.add('http://127.0.0.1:4321');
}

export const onRequest = defineMiddleware(async (context, next) => {
  // Run migrations once at cold start (race-safe, idempotent)
  await runMigrations();

  // Generate request ID for correlation logging and wrap the entire
  // handler chain in an AsyncLocalStorage scope so concurrent requests
  // never cross-correlate. See security-audit-2026-05-12 round 4
  // SEC4-004 (logger fallbackId was shared across requests).
  const requestId = `r${Date.now().toString(36)}-${(++reqCounter).toString(36)}`;
  return runWithRequestId(requestId, async () => {
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
  // Prerendered routes are skipped because Astro 6 warns when middleware
  // reads request.headers during prerender build, and the captured
  // headers there are build-time stubs anyway. SSR routes (/api/*) get
  // the full header capture.
  if (!context.isPrerendered && shouldLog(context.url.pathname)) {
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
});

async function handleRequest(context: Parameters<Parameters<typeof defineMiddleware>[0]>[0], next: Parameters<Parameters<typeof defineMiddleware>[0]>[1]): Promise<Response> {
  // Body-size cap on public API endpoints. Portal API also enforces this
  // below, but the public /api/* routes (quiz, contact, scan, unlock,
  // naming/preview) had no cap and could memory-pressure the process
  // with a single multi-megabyte JSON body. See security-audit-2026-05-12
  // round 4 SEC4-006.
  if (context.url.pathname.startsWith('/api/')) {
    const PUBLIC_API_MAX_BODY = 256 * 1024; // 256KB; public payloads are small
    const len = parseInt(context.request.headers.get('content-length') || '0', 10);
    if (len > PUBLIC_API_MAX_BODY) {
      return new Response(JSON.stringify({ error: 'Request body too large' }), {
        status: 413,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

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

  // Block deactivated users immediately (admins included). The account and all
  // its data are retained; this only governs access. setUserActive revokes
  // sessions when deactivating, so normally there is no live session to catch
  // here. This is the belt-and-suspenders gate for any in-flight session.
  if (result.user && result.user.active === false) {
    context.cookies.delete(SESSION_COOKIE, { path: '/portal' });
    return context.redirect('/portal/login?error=inactive');
  }

  // Reject oversized request bodies (1MB limit) on portal API routes
  // Default 1MB cap on portal API routes. CSV upload bumped to 25MB
  // because SF folder uploads ship 2-file batches that can total
  // 500KB-2MB; the strict 1MB cap was killing legitimate uploads
  // with "Request body too large." CF Free plan allows up to 100MB
  // and DO App Platform handles 25MB comfortably, so 25MB is well
  // inside infrastructure limits.
  const DEFAULT_PORTAL_API_MAX_BODY = 1024 * 1024;          // 1MB
  const CSV_UPLOAD_MAX_BODY = 25 * 1024 * 1024;             // 25MB
  const isCsvUpload = context.url.pathname === '/portal/api/csv/upload';
  const maxBody = isCsvUpload ? CSV_UPLOAD_MAX_BODY : DEFAULT_PORTAL_API_MAX_BODY;
  const contentLength = parseInt(context.request.headers.get('content-length') || '0', 10);
  if (contentLength > maxBody && context.url.pathname.startsWith('/portal/api/')) {
    return new Response(JSON.stringify({
      error: `Request body too large (${Math.round(contentLength / 1024)}KB; max ${Math.round(maxBody / 1024)}KB for this endpoint)`,
    }), {
      status: 413,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Origin check + CSRF validation on all state-mutating requests to
  // portal API routes. Two independent defenses against cross-site
  // POSTs that try to ride the user's session cookie.
  //
  // Astro's framework-level security.checkOrigin is disabled in
  // astro.config.mjs because behind Cloudflare + DO App Platform the
  // host header sometimes resolves to the DO ingress instead of
  // codyasmith.com, producing false-positive 403s. This middleware
  // does the same check against an explicit allow-list so it cannot
  // be confused by header rewrites.
  const mutating = ['POST', 'PUT', 'DELETE', 'PATCH'];
  if (mutating.includes(context.request.method) && context.url.pathname.startsWith('/portal/api/')) {
    const origin = context.request.headers.get('origin');
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

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
  //
  // Proposal viewers are NOT carved out: setting a password is a small
  // commitment that primes the client for the engagement. They hit
  // set-password on first arrival, then can reach /portal/proposals/*.
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
