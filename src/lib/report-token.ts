// Report-link signing for /api/report.
//
// Token format: <issued-seconds>.<hex-hmac> where the HMAC binds the
// REPORT_SECRET, the scan_id, and the issued timestamp. Verifying the
// signature plus a TTL window means a leaked link is bounded by both
// the data-side scan retention (30 days) and the cryptographic TTL.
// Rotating REPORT_SECRET invalidates every outstanding token.
//
// See security-audit-2026-05-12 SEC2-003.

import { sha256 } from '@oslojs/crypto/sha2';
import { encodeHexLowerCase } from '@oslojs/encoding';

const TOKEN_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, matches scan retention

const REPORT_SECRET: string = (() => {
  const secret = import.meta.env.REPORT_SECRET;
  if (!secret) {
    if (import.meta.env.PROD) {
      throw new Error('REPORT_SECRET environment variable is required in production. See .env.example.');
    }
    console.warn('[report-token] REPORT_SECRET not set; using dev fallback. Set REPORT_SECRET before deploying.');
    return 'report-dev-only-do-not-deploy';
  }
  return secret;
})();

function hmac(data: string): string {
  const encoded = new TextEncoder().encode(REPORT_SECRET + ':' + data);
  return encodeHexLowerCase(sha256(encoded));
}

export function generateReportToken(scanId: number): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const signature = hmac(`report:${scanId}:${issuedAt}`);
  return `${issuedAt}.${signature}`;
}

export function validateReportToken(scanId: number, token: string | null | undefined): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const issuedAt = parseInt(parts[0], 10);
  const signature = parts[1];
  if (!Number.isFinite(issuedAt) || !signature) return false;

  const now = Math.floor(Date.now() / 1000);
  const ageSec = now - issuedAt;
  if (ageSec < 0 || ageSec > TOKEN_VALIDITY_MS / 1000) return false;

  const expected = hmac(`report:${scanId}:${issuedAt}`);
  if (signature.length !== expected.length) return false;

  // Constant-time comparison
  let mismatch = 0;
  for (let i = 0; i < signature.length; i++) {
    mismatch |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}
