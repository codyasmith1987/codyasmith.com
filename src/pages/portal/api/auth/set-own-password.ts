// Self-service password-set endpoint. Used by the /portal/set-password
// flow after a magic-link sign-in. The session must already exist (the
// magic-link verify created it); this just attaches a password to the
// underlying user so future logins use the password flow. See
// security-audit-2026-05-12 round 3 SEC3-008.

import type { APIRoute } from 'astro';
import { setPassword, PasswordPolicyError } from '../../../../lib/auth';
import { logger } from '../../../../lib/logger';
import { logActivity } from '../../../../lib/activity';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: 'Forbidden' }, 403);

  try {
    const { password } = await request.json();
    if (typeof password !== 'string') {
      return json({ error: 'Password is required' }, 400);
    }

    // setPassword enforces the policy (>= 12 chars, <= 72 bytes) and
    // revokes existing sessions for the user. The caller's current
    // session is implicitly revoked too, so we re-issue cookies via a
    // fresh login on the next request would normally be required.
    // For this self-service flow we keep the current cookie because
    // setPassword has just rotated the user's session row in the DB
    // and the cookie holds the pre-rotation session token.
    //
    // To avoid logging the user out mid-flow we ALSO need to skip the
    // session-revoke. We can't do that without changing setPassword,
    // and forcing a re-login is acceptable UX here (user just chose
    // the password they will use).
    await setPassword(locals.user.id, password);

    await logActivity({
      userId: locals.user.id,
      action: 'updated',
      entityType: 'user',
      entityId: locals.user.id,
      summary: `${locals.user.name} set their own password`,
    });

    return json({ ok: true });
  } catch (err: any) {
    if (err instanceof PasswordPolicyError) {
      return json({ error: err.message }, 400);
    }
    logger.error('Self set-password error', err);
    return json({ error: 'Failed to set password' }, 500);
  }
};
