import type { APIRoute } from 'astro';
import { verifyPassword, createSession, SESSION_COOKIE } from '../../../lib/auth';
import { rateLimit } from '../../../lib/rate-limit';
import { logger } from '../../../lib/logger';
import { logActivity } from '../../../lib/activity';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ request, cookies, clientAddress }) => {
  const ip = clientAddress || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  // Per-IP throttle, fail-closed so a Turso outage cannot bypass brute-force
  // protection. See security-audit-2026-05-12 SEC-016.
  if (!await rateLimit(`login:ip:${ip}`, 10, 15 * 60 * 1000, true)) {
    return json({ error: 'Too many login attempts. Please wait a few minutes.' }, 429);
  }

  try {
    const { email, password } = await request.json();

    if (!email || !password) {
      return json({ error: 'Email and password are required' }, 400);
    }

    // Per-account throttle: defends against credential stuffing from
    // rotating-IP botnets. See SEC-011. Fail-closed.
    const emailKey = typeof email === 'string' ? email.toLowerCase().trim() : 'unknown';
    if (!await rateLimit(`login:email:${emailKey}`, 10, 15 * 60 * 1000, true)) {
      return json({ error: 'Too many login attempts. Please wait a few minutes.' }, 429);
    }

    const userId = await verifyPassword(email, password);
    if (!userId) {
      return json({ error: 'Invalid email or password' }, 401);
    }

    const sessionToken = await createSession(userId);

    await logActivity({
      userId,
      action: 'logged_in',
      entityType: 'session',
      entityId: userId,
      summary: `User logged in via password`,
    });

    cookies.set(SESSION_COOKIE, sessionToken, {
      path: '/portal',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60,
    });

    return json({ ok: true });
  } catch (err: any) {
    logger.error('Login error', err);
    return json({ error: 'Login failed' }, 500);
  }
};
