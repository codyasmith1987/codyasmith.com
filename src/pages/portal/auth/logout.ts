import type { APIRoute } from 'astro';
import { validateSession, invalidateSession, SESSION_COOKIE } from '../../../lib/auth';
import { logActivity } from '../../../lib/activity';
import { validateCsrfToken } from '../../../lib/csrf';

export const prerender = false;

export const POST: APIRoute = async ({ cookies, redirect, request }) => {
  // Auth routes are exempt from middleware session validation,
  // so we read the session cookie directly here.
  const token = cookies.get(SESSION_COOKIE)?.value;

  if (token) {
    const result = await validateSession(token);
    if (result) {
      // CSRF check: logout is state-mutating and the user has a session,
      // so we can validate. Accept token from either header or form field
      // so a no-JS form submit still works. Middleware exempts auth routes,
      // so the check lives here.
      let csrfToken: string | null = request.headers.get('X-CSRF-Token');
      if (!csrfToken && request.headers.get('content-type')?.includes('application/x-www-form-urlencoded')) {
        try {
          const form = await request.formData();
          csrfToken = String(form.get('csrf-token') ?? '');
        } catch {
          // formData parsing failed; treat as missing token
        }
      }
      if (!validateCsrfToken(result.session!.id, csrfToken || '')) {
        return new Response(JSON.stringify({ error: 'Invalid or missing CSRF token' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      await invalidateSession(result.session!.id);
      await logActivity({
        userId: result.user!.id,
        action: 'logged_out',
        entityType: 'session',
        entityId: result.user!.id,
        summary: `${result.user!.name} logged out`,
      });
    }
  }

  cookies.delete(SESSION_COOKIE, { path: '/portal' });
  return redirect('/portal/login');
};
