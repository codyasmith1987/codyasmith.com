import type { APIRoute } from 'astro';
import { getUserByEmail, createMagicLink } from '../../../lib/auth';
import { rateLimit } from '../../../lib/rate-limit';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ request, url, clientAddress }) => {
  const ip = clientAddress || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!rateLimit(`login:${ip}`, 10, 15 * 60 * 1000)) {
    return json({ error: 'Too many login attempts. Please wait a few minutes.' }, 429);
  }
  try {
    const { email } = await request.json();
    if (!email || typeof email !== 'string') {
      return json({ error: 'Email is required' }, 400);
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return json({ error: 'Invalid email address' }, 400);
    }

    const user = await getUserByEmail(email);

    // Always return success to prevent email enumeration
    if (!user) {
      return json({ ok: true });
    }

    const token = await createMagicLink(user.id);
    const origin = import.meta.env.SITE || url.origin;
    const loginUrl = `${origin}/portal/auth/verify?token=${token}`;

    // Send via Brevo
    const brevoKey = import.meta.env.BREVO_API_KEY;
    if (brevoKey) {
      await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': brevoKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sender: { name: 'Cody Smith', email: 'cody@codyasmith.com' },
          to: [{ email: user.email, name: user.name }],
          subject: 'Your Portal Login Link',
          htmlContent: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
              <h2 style="color: #171717; margin-bottom: 16px;">Hey ${user.name.split(' ')[0]},</h2>
              <p style="color: #525252; line-height: 1.6; margin-bottom: 24px;">
                Here's your login link for the client portal. It expires in 15 minutes.
              </p>
              <a href="${loginUrl}" style="display: inline-block; background: #f59e0b; color: #0a0a0a; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">
                Log in to Portal
              </a>
              <p style="color: #a3a3a3; font-size: 12px; margin-top: 32px; line-height: 1.5;">
                If you didn't request this, you can safely ignore this email.<br />
                <a href="https://codyasmith.com" style="color: #a3a3a3;">codyasmith.com</a>
              </p>
            </div>
          `,
        }),
      }).catch(err => console.error('Brevo magic link email error:', err));
    } else {
      // Dev fallback: log the link
      console.log(`\n[MAGIC LINK] ${loginUrl}\n`);
    }

    return json({ ok: true });
  } catch (err: any) {
    console.error('Send link error:', err);
    return json({ error: 'Failed to send login link' }, 500);
  }
};
