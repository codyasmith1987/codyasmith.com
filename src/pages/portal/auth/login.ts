import type { APIRoute } from 'astro';
import { verifyPassword, createSession, SESSION_COOKIE } from '../../../lib/auth';
import { rateLimit } from '../../../lib/rate-limit';
import { logger } from '../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ request, cookies, clientAddress }) => {
  const ip = clientAddress || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!rateLimit(`login:${ip}`, 10, 15 * 60 * 1000)) {
    return json({ error: 'Too many login attempts. Please wait a few minutes.' }, 429);
  }

  try {
    const { email, password } = await request.json();

    if (!email || !password) {
      return json({ error: 'Email and password are required' }, 400);
    }

    const userId = await verifyPassword(email, password);
    if (!userId) {
      return json({ error: 'Invalid email or password' }, 401);
    }

    const sessionToken = await createSession(userId);

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
