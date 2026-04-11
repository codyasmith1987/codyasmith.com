// Simple in-memory rate limiter for API endpoints
// Resets on server restart — acceptable for a single-server deployment

const windows = new Map<string, { count: number; resetAt: number }>();

/**
 * Check and increment rate limit for a given key.
 * @param key - Unique identifier (e.g. "contact:192.168.1.1")
 * @param maxRequests - Max requests per window
 * @param windowMs - Window duration in ms (default: 15 minutes)
 * @returns true if request is allowed, false if rate limited
 */
export function rateLimit(key: string, maxRequests: number, windowMs = 15 * 60 * 1000): boolean {
  const now = Date.now();
  const entry = windows.get(key);

  if (!entry || now >= entry.resetAt) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (entry.count >= maxRequests) {
    return false;
  }

  entry.count++;
  return true;
}

// Periodically clean up expired entries (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of windows) {
    if (now >= entry.resetAt) windows.delete(key);
  }
}, 5 * 60 * 1000);
