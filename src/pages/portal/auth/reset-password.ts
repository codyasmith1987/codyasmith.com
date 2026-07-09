import type { APIRoute } from 'astro';
import { consumePasswordResetToken, setPassword, PasswordPolicyError, PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, isUserActive } from '../../../lib/auth';
import { rateLimit } from '../../../lib/rate-limit';
import { logger } from '../../../lib/logger';
import { logActivity } from '../../../lib/activity';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// Completes a password reset. The token is the authorization (no session is
// involved or created), which is exactly why this lives under /portal/auth/
// (allowlisted, outside the session/CSRF gate) like login and send-link.
// consumePasswordResetToken single-uses the token; setPassword enforces the
// policy and revokes all existing sessions. The user then signs in fresh.
export const POST: APIRoute = async ({ request, clientAddress }) => {
  const ip = clientAddress || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';

  // Per-IP throttle on the token-submit. The 48-char token makes guessing
  // infeasible, so this is defense-in-depth; fail-OPEN so a Turso blip never
  // blocks a legitimate user who is mid-reset.
  if (!await rateLimit(`reset-submit:ip:${ip}`, 20, 15 * 60 * 1000, false)) {
    return json({ error: 'Too many attempts. Please wait a few minutes.' }, 429);
  }

  try {
    const { token, password } = await request.json();
    if (!token || typeof token !== 'string') {
      return json({ error: 'This reset link is invalid or has expired. Request a new one from the login page.' }, 400);
    }
    if (typeof password !== 'string') {
      return json({ error: 'Password is required' }, 400);
    }

    // Check the password policy BEFORE consuming the token, so a recoverable
    // mistake (too short / too long) does not burn the single-use token and
    // force the user to request a brand-new link. Mirrors assertPasswordPolicy.
    if (password.length < PASSWORD_MIN_LENGTH) {
      return json({ error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters` }, 400);
    }
    if (new TextEncoder().encode(password).length > PASSWORD_MAX_LENGTH) {
      return json({ error: `Password must be at most ${PASSWORD_MAX_LENGTH} bytes` }, 400);
    }

    const userId = await consumePasswordResetToken(token);
    if (!userId) {
      return json({ error: 'This reset link is invalid or has expired. Request a new one from the login page.' }, 400);
    }

    // A deactivated user must not be able to change their password, even with a
    // token minted in the window before they were deactivated. No access is
    // granted either way (login rejects inactive users), but this keeps the
    // invariant consistent with every other auth path. Neutral message: this
    // endpoint is unauthenticated, so do not reveal that the address maps to a
    // real-but-deactivated account.
    if (!await isUserActive(userId)) {
      return json({ error: 'This reset link is invalid or has expired. Request a new one from the login page.' }, 400);
    }

    // setPassword enforces the >= 12 char / <= 72 byte policy and revokes all
    // sessions for the user. The token is already consumed above, so a policy
    // rejection here means the user must request a fresh link; that is the
    // safe failure mode (a bad password never silently sets).
    await setPassword(userId, password);

    await logActivity({
      userId,
      action: 'updated',
      entityType: 'user',
      entityId: userId,
      summary: 'User reset their password via reset link',
    });

    return json({ ok: true });
  } catch (err: any) {
    if (err instanceof PasswordPolicyError) {
      return json({ error: err.message }, 400);
    }
    logger.error('Reset password error', err);
    return json({ error: 'Failed to reset password' }, 500);
  }
};
