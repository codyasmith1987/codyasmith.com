// Data retention sweep. Enforces the privacy policy claims:
//   - request_log: deleted after 90 days (privacy.astro states 90-day target).
//   - rate_limits (public scan throttling, keyed by raw IP): deleted after
//     30 days. The scan rate limiter cares about today's count; older rows
//     are dead weight and accumulating IPs is a needless privacy liability.
//   - portal_rate_limits expired buckets: also swept here for symmetry,
//     though the per-call rate-limit module already throttles cleanup.
//
// Runs at most once per RETENTION_SWEEP_INTERVAL_MS regardless of how often
// the entrypoint is called. Intended to be invoked from middleware on a
// fire-and-forget basis. See security-audit-2026-05-12 SEC-020.

import turso from './turso';
import { logger } from './logger';

const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // at most once per hour
let lastSweepAt = 0;

const REQUEST_LOG_RETENTION_DAYS = 90;
const SCAN_RATE_LIMIT_RETENTION_DAYS = 30;
const PORTAL_RATE_LIMIT_EXPIRY_MS = 60 * 60 * 1000;

export function maybeSweepRetention(): void {
  if (Date.now() - lastSweepAt < RETENTION_SWEEP_INTERVAL_MS) return;
  lastSweepAt = Date.now();
  void sweepRetention().catch(err => logger.error('Retention sweep failed', err));
}

async function sweepRetention(): Promise<void> {
  // request_log uses SQLite datetime('now'); cutoff is N days ago.
  // Column name is `timestamp` per migration 011; previous wording
  // used `created_at` and broke retention sweeps silently.
  await turso.execute({
    sql: `DELETE FROM request_log WHERE timestamp < datetime('now', ?)`,
    args: [`-${REQUEST_LOG_RETENTION_DAYS} days`],
  }).catch(err => {
    // request_log may not exist if migration 011 hasn't run yet; swallow.
    logger.info('request_log sweep skipped: ' + (err?.message || 'unknown'));
  });

  // rate_limits stores scan_date as ISO YYYY-MM-DD per src/lib/db.ts.
  const cutoff = new Date(Date.now() - SCAN_RATE_LIMIT_RETENTION_DAYS * 24 * 60 * 60 * 1000)
    .toISOString().split('T')[0];
  await turso.execute({
    sql: 'DELETE FROM rate_limits WHERE scan_date < ?',
    args: [cutoff],
  }).catch(err => logger.info('rate_limits sweep skipped: ' + (err?.message || 'unknown')));

  // portal_rate_limits uses ISO timestamps; expire after PORTAL_RATE_LIMIT_EXPIRY_MS.
  const portalCutoff = new Date(Date.now() - PORTAL_RATE_LIMIT_EXPIRY_MS).toISOString();
  await turso.execute({
    sql: 'DELETE FROM portal_rate_limits WHERE window_start < ?',
    args: [portalCutoff],
  }).catch(err => logger.info('portal_rate_limits sweep skipped: ' + (err?.message || 'unknown')));

  // Magic links and password reset tokens are single-use and short-lived
  // (15 min / 1 hour). Rows that expired more than a day ago are dead weight;
  // sweep them so the token tables stay small. ISO cutoff matches the ISO
  // timestamps stored in expires_at.
  const tokenCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await turso.execute({
    sql: 'DELETE FROM magic_links WHERE expires_at < ?',
    args: [tokenCutoff],
  }).catch(err => logger.info('magic_links sweep skipped: ' + (err?.message || 'unknown')));
  await turso.execute({
    sql: 'DELETE FROM password_reset_tokens WHERE expires_at < ?',
    args: [tokenCutoff],
  }).catch(err => logger.info('password_reset_tokens sweep skipped: ' + (err?.message || 'unknown')));
}
