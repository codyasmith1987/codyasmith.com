import { defineMiddleware } from 'astro:middleware';
import { validateSession, SESSION_COOKIE, isClientActive } from './lib/auth';
import { setRequestId } from './lib/logger';
import { runMigrations } from './lib/migrate';
import { generateCsrfToken, validateCsrfToken } from './lib/csrf';
import {
  DEFAULT_MODULES,
  MODULE_KEYS,
  getEnabledModulesForClient,
  isPathAllowed,
  pathRequiresModule,
  type ModuleKey,
} from './lib/modules';
import { getClientProfile } from './lib/clients';

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

  // Scheduled-jobs runner trigger — intended to be hit by an external
  // cron with an x-jobs-secret header. It has no session and no CSRF
  // token. The route handler validates the secret itself; the middleware
  // just gets out of the way. Never allow any other /portal/api/jobs/*
  // path through without session, only this one exact endpoint.
  if (context.url.pathname === '/portal/api/jobs/run') {
    return next();
  }

  // Slice 18 — Google OAuth callback is a 302 redirect back from
  // Google's consent screen. It carries the authorization code and
  // our state nonce in the query string but has no way to include
  // an X-CSRF-Token header. The handler itself validates the state
  // nonce against an httpOnly cookie set at connect time, so CSRF
  // protection is preserved — we just need to exempt it from the
  // mutating-route CSRF check below. Session is still required.

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

  // CSRF validation for all state-mutating requests to portal API routes.
  // The Google OAuth callback is exempt because Google redirects to us
  // via 302, so there is no way to attach X-CSRF-Token. The callback
  // handler validates a state cookie instead.
  const mutating = ['POST', 'PUT', 'DELETE', 'PATCH'];
  const isGoogleCallback = context.url.pathname === '/portal/api/admin/google/callback';
  if (
    mutating.includes(context.request.method) &&
    context.url.pathname.startsWith('/portal/api/') &&
    !isGoogleCallback
  ) {
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

  // Slice 13 — module enforcement. Compute the enabled module set for
  // the authenticated user, stash in locals so Portal.astro's nav
  // rendering can filter, then hard-gate the URL.
  //
  //   admin    → always the full set, no gate
  //   client   → union of modules_json across active contracts, with
  //              a DEFAULT_MODULES fallback for clients with zero
  //              active contracts or corrupt JSON
  //
  // Dashboard is always reachable even if explicitly disabled, so a
  // client can never be locked out of a landing page.
  // Load brand_accent once per client request so layouts can render
  // the CSS custom property without a second DB round-trip. Admins
  // in preview mode can optionally be targeted by their ?client_id=
  // parameter, but for now the middleware only loads accent for the
  // authenticated user's own client_id. Admin preview styling is a
  // later polish.
  if (result.user?.client_id) {
    const profile = await getClientProfile(result.user.client_id);
    context.locals.brandAccent = profile?.brand_accent ?? null;
  } else {
    context.locals.brandAccent = null;
  }

  if (result.user?.role === 'admin') {
    context.locals.enabledModules = new Set<ModuleKey>(MODULE_KEYS);
  } else if (result.user?.client_id) {
    const enabled = await getEnabledModulesForClient(result.user.client_id);
    context.locals.enabledModules = enabled;

    if (!isPathAllowed(context.url.pathname, enabled)) {
      // Non-admin hitting a module they aren't entitled to. Redirect
      // page navigations to dashboard so the client doesn't hit a
      // blank 403, but hard-403 API calls so malicious direct fetches
      // see a real denial.
      const required = pathRequiresModule(context.url.pathname);
      if (context.url.pathname.startsWith('/portal/api/')) {
        return new Response(
          JSON.stringify({ error: 'Module not enabled for this client', required }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return context.redirect('/portal/dashboard');
    }
  } else {
    // Client-less session (edge case) — give them the default set so
    // Portal.astro renders a sane nav.
    context.locals.enabledModules = new Set<ModuleKey>(DEFAULT_MODULES);
  }

  return next();
}
