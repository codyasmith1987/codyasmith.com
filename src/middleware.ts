import { defineMiddleware } from 'astro:middleware';
import { validateSession, SESSION_COOKIE } from './lib/auth';

export const onRequest = defineMiddleware(async (context, next) => {
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

  // Block non-admin users from admin routes
  if (context.url.pathname.startsWith('/portal/admin') && result.user?.role !== 'admin') {
    return new Response('Forbidden', { status: 403 });
  }

  return next();
});
