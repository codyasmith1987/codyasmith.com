// CSRF protection: proper HMAC-SHA256 token generation/validation.
// No database state needed. Token = timestamp.HMAC-SHA256(secret, "csrf:" + sessionId + ":" + timestamp).
//
// Uses node:crypto.createHmac (RFC 2104) instead of the previous
// sha256(secret + ':' + data) construction, which was technically
// vulnerable to length-extension attacks. Not exploitable as written
// because we never let an attacker append to a known prefix, but the
// fix is trivial and HMAC is the correct primitive. See
// security-audit-2026-05-12 round 3 SEC3-005.

import { createHmac } from 'node:crypto';

const TOKEN_VALIDITY_MS = 60 * 60 * 1000; // 1 hour

const CSRF_SECRET: string = (() => {
  const secret = import.meta.env.CSRF_SECRET;
  if (!secret) {
    if (import.meta.env.PROD) {
      throw new Error('CSRF_SECRET environment variable is required in production. See .env.example.');
    }
    console.warn('[csrf] CSRF_SECRET not set; using dev fallback. Set CSRF_SECRET before deploying.');
    return 'csrf-dev-only-do-not-deploy';
  }
  return secret;
})();

function hmac(data: string): string {
  return createHmac('sha256', CSRF_SECRET).update(data).digest('hex');
}

/**
 * Generate a CSRF token for the current session.
 * Token includes a timestamp so it expires after TOKEN_VALIDITY_MS.
 */
export function generateCsrfToken(sessionId: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = hmac(`csrf:${sessionId}:${timestamp}`);
  return `${timestamp}.${signature}`;
}

/**
 * Validate a CSRF token against the current session.
 * Checks signature and expiry.
 */
export function validateCsrfToken(sessionId: string, token: string): boolean {
  if (!token || !sessionId) return false;

  const parts = token.split('.');
  if (parts.length !== 2) return false;

  const [timestampStr, signature] = parts;
  const timestamp = parseInt(timestampStr, 10);
  if (isNaN(timestamp)) return false;

  // Check expiry
  const now = Math.floor(Date.now() / 1000);
  if (now - timestamp > TOKEN_VALIDITY_MS / 1000) return false;

  // Verify signature
  const expected = hmac(`csrf:${sessionId}:${timestamp}`);
  if (signature.length !== expected.length) return false;

  // Constant-time comparison
  let mismatch = 0;
  for (let i = 0; i < signature.length; i++) {
    mismatch |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}
