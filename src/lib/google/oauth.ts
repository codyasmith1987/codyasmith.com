// Google OAuth 2.0 — hand-rolled authorization code flow.
//
// Only the three endpoints we actually need:
//   1. Build the consent screen URL
//   2. Exchange an authorization code for an access + refresh token
//   3. Refresh an access token using a stored refresh token
//
// We deliberately do not depend on the googleapis npm package. The
// HTTP surface we need is three endpoints, all documented at
// https://developers.google.com/identity/protocols/oauth2/web-server
//
// Scopes:
//   GSC read-only:   https://www.googleapis.com/auth/webmasters.readonly
//   GA4 read-only:   https://www.googleapis.com/auth/analytics.readonly
//
// Env vars (all required for the connect flow to work):
//   GOOGLE_OAUTH_CLIENT_ID
//   GOOGLE_OAUTH_CLIENT_SECRET
//   GOOGLE_OAUTH_REDIRECT_URI

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

export const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
export const GA4_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
export const OPENID_EMAIL_SCOPES = 'openid email';

export interface GoogleOAuthEnv {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export class GoogleOAuthNotConfiguredError extends Error {
  constructor(missing: string[]) {
    super(`Google OAuth not configured: missing ${missing.join(', ')}`);
    this.name = 'GoogleOAuthNotConfiguredError';
  }
}

export function readOAuthEnv(): GoogleOAuthEnv {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  const missing: string[] = [];
  if (!clientId) missing.push('GOOGLE_OAUTH_CLIENT_ID');
  if (!clientSecret) missing.push('GOOGLE_OAUTH_CLIENT_SECRET');
  if (!redirectUri) missing.push('GOOGLE_OAUTH_REDIRECT_URI');
  if (missing.length > 0) throw new GoogleOAuthNotConfiguredError(missing);
  return {
    clientId: clientId!,
    clientSecret: clientSecret!,
    redirectUri: redirectUri!,
  };
}

export function isOAuthConfigured(): boolean {
  try {
    readOAuthEnv();
    return true;
  } catch {
    return false;
  }
}

// Builds the Google consent screen URL. `state` must be a random
// unguessable string the caller also stores in a short-lived cookie
// so the callback can verify CSRF.
export function buildAuthUrl(options: {
  state: string;
  scopes: string[];
  env?: GoogleOAuthEnv;
}): string {
  const env = options.env ?? readOAuthEnv();
  const params = new URLSearchParams({
    client_id: env.clientId,
    redirect_uri: env.redirectUri,
    response_type: 'code',
    scope: options.scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state: options.state,
    include_granted_scopes: 'true',
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export interface TokenResponse {
  access_token: string;
  expires_in: number; // seconds
  refresh_token?: string; // only present on first consent or with prompt=consent
  scope: string;
  token_type: string;
  id_token?: string;
}

async function postForm(
  url: string,
  body: Record<string, string>
): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Google OAuth: non-JSON response (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const desc = json.error_description || json.error || 'unknown';
    throw new Error(`Google OAuth ${res.status}: ${desc}`);
  }
  return json;
}

export async function exchangeCode(
  code: string,
  env: GoogleOAuthEnv = readOAuthEnv()
): Promise<TokenResponse> {
  return (await postForm(TOKEN_URL, {
    code,
    client_id: env.clientId,
    client_secret: env.clientSecret,
    redirect_uri: env.redirectUri,
    grant_type: 'authorization_code',
  })) as TokenResponse;
}

export async function refreshAccessToken(
  refreshToken: string,
  env: GoogleOAuthEnv = readOAuthEnv()
): Promise<TokenResponse> {
  return (await postForm(TOKEN_URL, {
    client_id: env.clientId,
    client_secret: env.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })) as TokenResponse;
}

// After code exchange we hit userinfo to learn which Google account
// was connected — used to key the google_connections row so a
// subsequent re-connect updates instead of creating a duplicate.
export async function fetchGoogleUserEmail(accessToken: string): Promise<string> {
  const res = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Google userinfo ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = JSON.parse(text);
  if (typeof json.email !== 'string') {
    throw new Error('Google userinfo response missing email');
  }
  return json.email;
}
