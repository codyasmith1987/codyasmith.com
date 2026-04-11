import type { APIRoute } from 'astro';
import { createUser, createMagicLink, getUserByEmail } from '../../../../lib/auth';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ locals, request, url }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const { name, email, role, client_id, send_invite } = await request.json();

    if (!name?.trim() || !email?.trim()) {
      return json({ error: 'Name and email are required' }, 400);
    }

    if (role !== 'admin' && role !== 'client') {
      return json({ error: 'Role must be "admin" or "client"' }, 400);
    }

    if (role === 'client' && !client_id) {
      return json({ error: 'Client role requires a client assignment' }, 400);
    }

    const existing = await getUserByEmail(email);
    if (existing) {
      return json({ error: 'A user with that email already exists' }, 409);
    }

    const userId = await createUser(email.trim(), name.trim(), role, client_id || null);

    let invite_sent = false;

    if (send_invite) {
      const token = await createMagicLink(userId);
      const origin = url.origin.includes('localhost') ? url.origin : 'https://codyasmith.com';
      const loginUrl = `${origin}/portal/auth/verify?token=${token}`;

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
            to: [{ email: email.trim(), name: name.trim() }],
            subject: 'You\'ve been invited to the Client Portal',
            htmlContent: `
              <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
                <h2 style="color: #171717; margin-bottom: 16px;">Hey ${name.trim().split(' ')[0]},</h2>
                <p style="color: #525252; line-height: 1.6; margin-bottom: 8px;">
                  Cody has set up a client portal for you at codyasmith.com. This is where you'll find your reports, deliverables, and dashboard.
                </p>
                <p style="color: #525252; line-height: 1.6; margin-bottom: 24px;">
                  Click below to log in. This link expires in 15 minutes — after that, just enter your email on the login page to get a new one.
                </p>
                <a href="${loginUrl}" style="display: inline-block; background: #f59e0b; color: #0a0a0a; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">
                  Log in to your Portal
                </a>
                <p style="color: #a3a3a3; font-size: 12px; margin-top: 32px;">
                  <a href="https://codyasmith.com" style="color: #a3a3a3;">codyasmith.com</a>
                </p>
              </div>
            `,
          }),
        }).catch(err => console.error('Brevo invite email error:', err));
        invite_sent = true;
      } else {
        console.log(`\n[INVITE LINK] ${loginUrl}\n`);
        invite_sent = true;
      }
    }

    return json({ id: userId, invite_sent });
  } catch (err: any) {
    console.error('Create user error:', err);
    return json({ error: 'Failed to create user' }, 500);
  }
};
