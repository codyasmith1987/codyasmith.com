import type { APIRoute } from 'astro';
import { createMagicLink } from '../../../../lib/auth';
import { logger } from '../../../../lib/logger';
import { logActivity } from '../../../../lib/activity';
import { escapeHtml, stripCRLF } from '../../../../lib/email-safety';
import turso from '../../../../lib/turso';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// Resend a portal invite to an existing user. Used from the row-level
// "Resend invite" button on /portal/admin/users so the admin can re-mint
// a fresh magic link without recreating the account or going through the
// per-proposal management page.
//
// Each invocation: looks up the user, mints a fresh 15-min magic link,
// sends a Brevo invite email pointing the link at /portal/auth/verify.
// Previous unused magic links are not auto-revoked (they expire on their
// own), but the latest link is the one the user should follow.
export const POST: APIRoute = async ({ locals, request, url }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const { user_id } = await request.json();
    if (!user_id) return json({ error: 'user_id is required' }, 400);

    // Look up the user
    const lookup = await turso.execute({
      sql: 'SELECT id, email, name FROM users WHERE id = ?',
      args: [user_id],
    });
    if (lookup.rows.length === 0) return json({ error: 'User not found' }, 404);
    const userRow = lookup.rows[0];
    const userEmail = userRow[1] as string;
    const userName = userRow[2] as string;

    // Mint a fresh magic link
    const token = await createMagicLink(user_id);
    const origin = import.meta.env.SITE || new URL(request.url).origin;
    const loginUrl = `${origin}/portal/auth/verify?token=${token}`;

    // Send via Brevo if configured
    const brevoKey = import.meta.env.BREVO_API_KEY;
    let invite_sent = false;
    if (brevoKey) {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': brevoKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sender: { name: 'Cody Smith', email: 'cody@codyasmith.com' },
          to: [{ email: userEmail, name: stripCRLF(userName) }],
          subject: stripCRLF('Your Client Portal login link'),
          htmlContent: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
              <h2 style="color: #171717; margin-bottom: 16px;">Hey ${escapeHtml(userName.split(' ')[0])},</h2>
              <p style="color: #525252; line-height: 1.6; margin-bottom: 12px;">
                Here is a fresh login link for the Client Portal at codyasmith.com.
              </p>
              <p style="color: #525252; line-height: 1.6; margin-bottom: 24px;">
                The link expires in 15 minutes. If it times out, log in with your email at the portal login page for a new one.
              </p>
              <a href="${escapeHtml(loginUrl)}" style="display: inline-block; background: #f59e0b; color: #0a0a0a; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">
                Log in to your Portal
              </a>
              <p style="color: #a3a3a3; font-size: 12px; margin-top: 32px;">
                <a href="https://codyasmith.com" style="color: #a3a3a3;">codyasmith.com</a>
              </p>
            </div>
          `,
        }),
      });
      if (!res.ok) {
        const errBody = await res.text();
        logger.error(`Brevo resend-invite failed for ${userEmail}`, errBody);
        return json({ error: 'Email send failed', detail: errBody.slice(0, 200) }, 502);
      }
      invite_sent = true;
    } else {
      // Dev fallback: log the link for the admin to copy
      logger.info(`[RESEND LINK] ${loginUrl}`);
    }

    await logActivity({
      userId: locals.user!.id,
      action: 'invited',
      entityType: 'user',
      entityId: user_id,
      summary: `${locals.user!.name} resent invite to ${userName} (${userEmail})`,
    });

    return json({ ok: true, invite_sent, email: userEmail });
  } catch (err: any) {
    logger.error('Resend invite error', err);
    return json({ error: 'Failed to resend invite' }, 500);
  }
};
