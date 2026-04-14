// GET /portal/api/admin/google/connect — starts the OAuth flow.
//
// Generates a random state nonce, drops it into a short-lived
// httpOnly cookie, and 302-redirects to Google's consent screen
// with the required scopes. The matching `google_oauth_state`
// cookie is verified on callback to prevent CSRF.
//
// Fails honestly with 503 if GOOGLE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI
// are not set in the environment.

import type { APIRoute } from 'astro';
import crypto from 'node:crypto';
import {
  buildAuthUrl,
  isOAuthConfigured,
  GSC_SCOPE,
  GA4_SCOPE,
  OPENID_EMAIL_SCOPES,
} from '../../../../../lib/google/oauth';
import { logger } from '../../../../../lib/logger';

export const prerender = false;

export const GET: APIRoute = async ({ locals, cookies, redirect }) => {
  if (locals.user?.role !== 'admin') {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!isOAuthConfigured()) {
    return new Response(
      JSON.stringify({
        error:
          'Google OAuth is not configured on this server. Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_OAUTH_REDIRECT_URI before using this flow.',
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const state = crypto.randomBytes(18).toString('base64url');
  cookies.set('google_oauth_state', state, {
    path: '/portal/api/admin/google',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 10 * 60, // 10 minutes
  });

  try {
    // Slice 18b — request both GSC and GA4 read-only scopes in one
    // consent so Cody doesn't have to re-authorize just to add GA4
    // to an already-connected account. Existing connections that
    // were granted only the GSC scope will re-consent with both on
    // their next "Connect" click since prompt=consent forces the
    // screen.
    const url = buildAuthUrl({
      state,
      scopes: [GSC_SCOPE, GA4_SCOPE, ...OPENID_EMAIL_SCOPES.split(' ')],
    });
    return redirect(url, 302);
  } catch (err) {
    logger.error('google connect error', err);
    return new Response(JSON.stringify({ error: String((err as Error)?.message ?? err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
