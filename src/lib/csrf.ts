// CSRF protection — HMAC-based token generation/validation
// No database state needed. Token = HMAC(sessionId + timestamp, secret)

import { sha256 } from '@oslojs/crypto/sha2';
import { encodeHexLowerCase } from '@oslojs/encoding';

const TOKEN_VALIDITY_MS = 60 * 60 * 1000; // 1 hour

function getSecret(): string {
  // Use CSRF_SECRET env var, fall back to a combination of other secrets
  return import.meta.env.CSRF_SECRET
    || import.meta.env.TURSO_AUTH_TOKEN
    || 'csrf-fallback-dev-only';
}

function hmac(data: string): string {
  const key = getSecret();
  const encoded = new TextEncoder().encode(key + ':' + data);
  return encodeHexLowerCase(sha256(encoded));
}

/**
 * Generate a CSRF token for the current session.
 * Token includes a timestamp so it expires after TOKEN_VALIDITY_MS.
 */
export function generateCsrfToken(sessionId: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = hmac(`${sessionId}:${timestamp}`);
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
  const expected = hmac(`${sessionId}:${timestamp}`);
  if (signature.length !== expected.length) return false;

  // Constant-time comparison
  let mismatch = 0;
  for (let i = 0; i < signature.length; i++) {
    mismatch |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}
