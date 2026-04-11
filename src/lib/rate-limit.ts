// Persistent rate limiter backed by Turso
// Survives restarts and works across instances

import turso from './turso';
import { logger } from './logger';

/**
 * Check and increment rate limit for a given key.
 * @param key - Unique identifier (e.g. "login:192.168.1.1")
 * @param maxRequests - Max requests per window
 * @param windowMs - Window duration in ms (default: 15 minutes)
 * @returns true if request is allowed, false if rate limited
 */
export async function rateLimit(key: string, maxRequests: number, windowMs = 15 * 60 * 1000): Promise<boolean> {
  try {
    const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs).toISOString();

    // Check current count
    const result = await turso.execute({
      sql: 'SELECT count FROM portal_rate_limits WHERE key = ? AND window_start = ?',
      args: [key, windowStart],
    });

    const current = result.rows.length > 0 ? (result.rows[0][0] as number) : 0;

    if (current >= maxRequests) {
      return false;
    }

    // Increment or insert
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

    // Clean up expired windows (older than 1 hour) — piggyback on this call
    const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await turso.execute({
      sql: 'DELETE FROM portal_rate_limits WHERE window_start < ?',
      args: [cutoff],
    });

    return true;
  } catch (err) {
    // If rate limiting fails, allow the request (fail open) — better than blocking legitimate users
    logger.error('Rate limit check failed', err);
    return true;
  }
}
