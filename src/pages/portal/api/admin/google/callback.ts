// GET /portal/api/admin/google/callback — handles the OAuth redirect.
//
// Verifies the state cookie, exchanges the authorization code for
// tokens, looks up the Google account email, and upserts a
// google_connections row. Redirects back to the admin page with a
// status query parameter so the UI can display what happened.

import type { APIRoute } from 'astro';
import {
  exchangeCode,
  fetchGoogleUserEmail,
  isOAuthConfigured,
  GSC_SCOPE,
} from '../../../../../lib/google/oauth';
import { createConnection } from '../../../../../lib/google/connections';
import { isGoogleCryptoConfigured } from '../../../../../lib/google/crypto';
import { logActivity } from '../../../../../lib/activity';
import { logger } from '../../../../../lib/logger';

export const prerender = false;

function redirectTo(target: string): Response {
  return new Response(null, { status: 302, headers: { Location: target } });
}

export const GET: APIRoute = async ({ locals, url, cookies }) => {
  if (locals.user?.role !== 'admin') {
    return redirectTo('/portal/login');
  }

  const code = url.searchParams.get('code');
  const stateParam = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');

  if (errorParam) {
    return redirectTo(`/portal/admin/google?connect_error=${encodeURIComponent(errorParam)}`);
  }
  if (!code || !stateParam) {
    return redirectTo('/portal/admin/google?connect_error=missing_code');
  }

  const stateCookie = cookies.get('google_oauth_state')?.value;
  if (!stateCookie || stateCookie !== stateParam) {
    return redirectTo('/portal/admin/google?connect_error=state_mismatch');
  }
  cookies.delete('google_oauth_state', { path: '/portal/api/admin/google' });

  if (!isOAuthConfigured()) {
    return redirectTo('/portal/admin/google?connect_error=not_configured');
  }
  if (!isGoogleCryptoConfigured()) {
    return redirectTo('/portal/admin/google?connect_error=token_key_missing');
  }

  try {
    const tokens = await exchangeCode(code);
    if (!tokens.refresh_token) {
      // Google only returns a refresh token on first consent, or
      // when prompt=consent is passed. buildAuthUrl sets
      // prompt=consent, so a missing refresh token means the user
      // somehow bypassed the consent screen — abort rather than
      // create a stub connection.
      return redirectTo('/portal/admin/google?connect_error=no_refresh_token');
    }
    const accessToken = tokens.access_token;
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
    const email = await fetchGoogleUserEmail(accessToken);

    const connectionId = await createConnection({
      admin_user_id: locals.user!.id,
      google_account_email: email,
      refresh_token: tokens.refresh_token,
      access_token: accessToken,
      access_token_expires_at: expiresAt,
      scopes: tokens.scope.split(/\s+/).filter(Boolean),
    });

    await logActivity({
      clientId: null,
      userId: locals.user!.id,
      action: 'connected',
      entityType: 'google_connection',
      entityId: connectionId,
      summary: `${locals.user!.name} connected Google account ${email} (scopes: ${tokens.scope})`,
    });

    return redirectTo(`/portal/admin/google?connected=${encodeURIComponent(email)}`);
  } catch (err) {
    logger.error('google callback error', err);
    return redirectTo(
      `/portal/admin/google?connect_error=${encodeURIComponent(String((err as Error)?.message ?? err).slice(0, 120))}`
    );
  }
};
