import type { APIRoute } from 'astro';
import { getUserByEmail, createPasswordResetToken, userHasPassword } from '../../../lib/auth';
import { rateLimit } from '../../../lib/rate-limit';
import { logger } from '../../../lib/logger';
import { logActivity } from '../../../lib/activity';
import { escapeHtml, stripCRLF } from '../../../lib/email-safety';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// "Forgot password" request handler. Mints a single-use password reset token
// and emails the link, but ONLY for users who already have a password (the
// people the reset is for). Brand-new, passwordless invitees are served by the
// sign-in-link button instead, so we never mint a reset for them. Always
// returns { ok: true } regardless of whether an email was sent, to preserve the
// no-enumeration property the rest of the auth surface relies on.
export const POST: APIRoute = async ({ request, url, clientAddress }) => {
  const ip = clientAddress || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';

  // Per-IP throttle (fail-closed, like the login + magic-link paths) so a Turso
  // outage cannot open the door to unlimited requests.
  if (!await rateLimit(`reset:ip:${ip}`, 10, 15 * 60 * 1000, true)) {
    return json({ error: 'Too many requests. Please wait a few minutes.' }, 429);
  }

  try {
    const { email } = await request.json();
    if (!email || typeof email !== 'string') {
      return json({ error: 'Email is required' }, 400);
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return json({ error: 'Invalid email address' }, 400);
    }

    // Per-email throttle (fail-closed): a separate bucket from login so a
    // password attempt does not throttle a reset request and vice versa, and so
    // an attacker cannot mailbomb a victim's inbox from rotating IPs.
    const emailKey = email.toLowerCase().trim();
    if (!await rateLimit(`reset:email:${emailKey}`, 5, 15 * 60 * 1000, true)) {
      return json({ ok: true });
    }

    const user = await getUserByEmail(email);

    // Uniform success to prevent email enumeration.
    if (!user) {
      return json({ ok: true });
    }

    // Reset only applies to users who already have a password. A passwordless
    // invitee has nothing to reset; they use the sign-in-link button. Return
    // ok uniformly so the two cases are indistinguishable to a caller.
    if (!await userHasPassword(user.id)) {
      return json({ ok: true });
    }

    const token = await createPasswordResetToken(user.id);

    await logActivity({
      userId: user.id,
      action: 'created',
      entityType: 'password_reset',
      entityId: user.id,
      summary: `Password reset link sent to ${user.email}`,
    });

    const origin = import.meta.env.SITE || url.origin;
    const resetUrl = `${origin}/portal/auth/reset?token=${token}`;

    const brevoKey = import.meta.env.BREVO_API_KEY;
    if (brevoKey) {
      const emailRes = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': brevoKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sender: { name: 'Cody Smith', email: 'cody@codyasmith.com' },
          to: [{ email: user.email, name: stripCRLF(user.name) }],
          subject: stripCRLF('Reset your Client Portal password'),
          htmlContent: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
              <h2 style="color: #171717; margin-bottom: 16px;">Hey ${escapeHtml(user.name.split(' ')[0])},</h2>
              <p style="color: #525252; line-height: 1.6; margin-bottom: 24px;">
                Here's a link to set a new password for the client portal. It expires in 1 hour.
              </p>
              <a href="${escapeHtml(resetUrl)}" style="display: inline-block; background: #f59e0b; color: #0a0a0a; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">
                Set a new password
              </a>
              <p style="color: #a3a3a3; font-size: 12px; margin-top: 32px; line-height: 1.5;">
                If you didn't request this, you can safely ignore this email; your password won't change.<br />
                <a href="https://codyasmith.com" style="color: #a3a3a3;">codyasmith.com</a>
              </p>
            </div>
          `,
        }),
      }).catch(err => { logger.error('Brevo password reset email error', err); return null; });
      if (emailRes && !emailRes.ok) {
        logger.error('Brevo password reset API error', new Error(await emailRes.text()));
      }
    } else {
      // Dev fallback: log the link for the developer to copy.
      logger.info('Password reset link generated (dev mode)', { url: resetUrl });
    }

    return json({ ok: true });
  } catch (err: any) {
    logger.error('Request reset error', err);
    return json({ error: 'Failed to process request' }, 500);
  }
};
