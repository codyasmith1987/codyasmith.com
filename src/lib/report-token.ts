// Report-link signing for /api/report.
// The unlock email contains a token. Without it, /api/report returns Tier 1 only.
// Token = HMAC(REPORT_SECRET, "report:" + scan_id). Scoped per scan, non-enumerable.

import { sha256 } from '@oslojs/crypto/sha2';
import { encodeHexLowerCase } from '@oslojs/encoding';

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
  return hmac(`report:${scanId}`);
}

export function validateReportToken(scanId: number, token: string | null | undefined): boolean {
  if (!token) return false;
  const expected = generateReportToken(scanId);
  if (token.length !== expected.length) return false;

  // Constant-time comparison
  let mismatch = 0;
  for (let i = 0; i < token.length; i++) {
    mismatch |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}
