import { defineMiddleware } from 'astro:middleware';
import { validateSession, SESSION_COOKIE } from './lib/auth';

export const onRequest = defineMiddleware(async (context, next) => {
  // Add security headers to all responses
  const response = await handleRequest(context, next);
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

  // Block non-admin users from admin routes — redirect to dashboard instead of blank 403
  if (context.url.pathname.startsWith('/portal/admin') && result.user?.role !== 'admin') {
    return context.redirect('/portal/dashboard');
  }

  return next();
}
