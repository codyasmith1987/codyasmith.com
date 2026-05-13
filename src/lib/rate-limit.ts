// Persistent rate limiter backed by Turso.
// Survives restarts and works across instances.
//
// Two failure policies on DB error:
//   - failOpen (default): allow the request. Safe for non-auth endpoints
//     where a Turso outage shouldn't block legitimate users.
//   - failClosed: reject the request. Used on login and other
//     authentication paths so a Turso outage cannot open the door to
//     unlimited brute force. See security-audit-2026-05-12 SEC-016.
//
// Cleanup of expired windows runs every CLEANUP_INTERVAL_MS at most,
// not on every call. That keeps the hot path off a full-table DELETE
// under load. See SEC-020 (retention sweep) for the longer-horizon
// cleanup of rate_limits and request_log.

import turso from './turso';
import { logger } from './logger';

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // sweep expired windows at most every 5 minutes
const EXPIRED_WINDOW_AGE_MS = 60 * 60 * 1000; // window rows older than 1 hour are safe to drop
let lastCleanupAt = 0;

export async function rateLimit(
  key: string,
  maxRequests: number,
  windowMs: number = DEFAULT_WINDOW_MS,
  failClosed: boolean = false,
): Promise<boolean> {
  try {
    const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs).toISOString();

    const result = await turso.execute({
      sql: 'SELECT count FROM portal_rate_limits WHERE key = ? AND window_start = ?',
      args: [key, windowStart],
    });
    const current = result.rows.length > 0 ? (result.rows[0][0] as number) : 0;
    if (current >= maxRequests) return false;

    if (current > 0) {
      await turso.execute({
        sql: 'UPDATE portal_rate_limits SET count = count + 1 WHERE key = ? AND window_start = ?',
        args: [key, windowStart],
      });
    } else {
      await turso.execute({
        sql: 'INSERT OR IGNORE INTO portal_rate_limits (key, window_start, count) VALUES (?, ?, 1)',
        args: [key, windowStart],
      });
    }

    // Throttled cleanup of expired windows. Runs at most once per
    // CLEANUP_INTERVAL_MS regardless of request volume.
    if (Date.now() - lastCleanupAt > CLEANUP_INTERVAL_MS) {
      lastCleanupAt = Date.now();
      const cutoff = new Date(Date.now() - EXPIRED_WINDOW_AGE_MS).toISOString();
      void turso.execute({
        sql: 'DELETE FROM portal_rate_limits WHERE window_start < ?',
        args: [cutoff],
      }).catch(err => logger.error('Rate limit cleanup failed', err));
    }

    return true;
  } catch (err) {
    logger.error('Rate limit check failed', err);
    // Fail-closed callers (login, password endpoints) reject on DB error
    // so a transient Turso outage cannot bypass throttling. Fail-open is
    // the default for less-sensitive endpoints.
    return !failClosed;
  }
}
