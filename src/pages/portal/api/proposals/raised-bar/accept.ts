// Interactive proposal acceptance endpoint.
//
// Accepts the Raised Bar engagement signoff from the proposal page form.
// Authorizes against the same gate as the proposal viewer: admin OR a
// client user belonging to Raised Bar Group. CSRF is enforced by portal
// middleware on /portal/api/* (mutating methods).
//
// On success:
//   1. Logs activity with the full decision (tier, add-on, signers).
//   2. Sends Cody a notification email with the decision summary.
//   3. Sends Jason and Kevin a confirmation email.
//
// Returns { ok: true, confirmation_emails } on success so the page can
// render a thank-you panel with the addresses the emails landed in.

import type { APIRoute } from 'astro';
import { getClientBySlug } from '../../../../../lib/auth';
import { logActivity } from '../../../../../lib/activity';
import { logger } from '../../../../../lib/logger';
import { escapeHtml, stripCRLF } from '../../../../../lib/email-safety';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const TIERS = {
  good:   { name: 'Good',   monthly: 1031.60, oneTime: 7925 },
  better: { name: 'Better', monthly: 1891.60, oneTime: 8925 },
  best:   { name: 'Best',   monthly: 2661.60, oneTime: 10625 },
} as const;
const ADDON_MONTHLY: Record<keyof typeof TIERS, number> = { good: 237.60, better: 397.60, best: 517.60 };
const ADDON_ONETIME = 4500;
const CLIENT_SLUG = 'raised-bar-group';
const SIGNER_EMAILS = ['jasonroth1122@gmail.com', 'kevo.adams@gmail.com'];

function moneyInt(n: number): string {
  return '$' + n.toLocaleString('en-US');
}
function money(n: number): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export const POST: APIRoute = async ({ locals, request }) => {
  const user = locals.user;
  if (!user) return json({ error: 'Not authenticated' }, 401);

  // Same access gate as the proposal page itself.
  const client = await getClientBySlug(CLIENT_SLUG);
  const isAuthorized = user.role === 'admin' || (!!client && user.client_id === client.id);
  if (!isAuthorized) return json({ error: 'Forbidden' }, 403);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request body' }, 400);
  }

  const tier = String(body?.tier || '').toLowerCase();
  const addOn = String(body?.add_on || '').toLowerCase();
  const jasonName = String(body?.jason_name || '').trim();
  const kevinName = String(body?.kevin_name || '').trim();

  if (!(tier in TIERS)) return json({ error: 'Invalid tier' }, 400);
  if (addOn !== 'yes' && addOn !== 'no') return json({ error: 'Invalid add_on' }, 400);
  if (!jasonName || jasonName.length > 120) return json({ error: 'Jason name is required' }, 400);
  if (!kevinName || kevinName.length > 120) return json({ error: 'Kevin name is required' }, 400);

  const tierData = TIERS[tier as keyof typeof TIERS];
  const monthly = tierData.monthly + (addOn === 'yes' ? ADDON_MONTHLY[tier as keyof typeof TIERS] : 0);
  const oneTime = tierData.oneTime + (addOn === 'yes' ? ADDON_ONETIME : 0);
  const acceptedAt = new Date().toISOString();
  const sigBy = `${user.name} (${user.email})`;

  // Audit log entry — survives even if the email send fails.
  await logActivity({
    clientId: client?.id || null,
    userId: user.id,
    action: 'accepted',
    entityType: 'proposal',
    entityId: 'raised-bar',
    summary: `Raised Bar accepted: tier=${tier}, add_on=${addOn}, jason="${jasonName}", kevin="${kevinName}", one_time=${oneTime}, monthly=${monthly.toFixed(2)}, sigBy=${sigBy}`,
  });

  const brevoKey = import.meta.env.BREVO_API_KEY;
  const sentTo: string[] = [];

  if (!brevoKey) {
    // No mailer configured. Acceptance is still logged; just report
    // back so the page can show the thank-you panel and Cody can pick
    // up the activity row.
    return json({ ok: true, confirmation_emails: '(email service not configured; acceptance logged)' });
  }

  // Notification to Cody.
  try {
    const codyHtml = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 22px; color: #1a1814; line-height: 1.55;">
        <h2 style="font-size: 22px; margin: 0 0 16px;">Raised Bar engagement accepted</h2>
        <table style="width: 100%; border-collapse: collapse; font-size: 14px; margin-bottom: 20px;">
          <tr><td style="padding: 6px 0; color: #6b6359;">Tier</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">${escapeHtml(tierData.name)}</td></tr>
          <tr><td style="padding: 6px 0; color: #6b6359;">Tailwater micro-site</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">${addOn === 'yes' ? 'Yes' : 'No'}</td></tr>
          <tr><td style="padding: 6px 0; color: #6b6359; border-top: 1px solid #e6ddd0;">One-time at signing</td><td style="padding: 6px 0; text-align: right; font-weight: 600; border-top: 1px solid #e6ddd0;">${escapeHtml(moneyInt(oneTime))}</td></tr>
          <tr><td style="padding: 6px 0; color: #6b6359;">Monthly recurring</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">${escapeHtml(money(monthly))}</td></tr>
        </table>
        <p style="font-size: 14px; color: #6b6359; margin: 0 0 8px;">Signed as Jason Roth: <strong style="color: #1a1814;">${escapeHtml(jasonName)}</strong></p>
        <p style="font-size: 14px; color: #6b6359; margin: 0 0 16px;">Signed as Kevin Adams: <strong style="color: #1a1814;">${escapeHtml(kevinName)}</strong></p>
        <p style="font-size: 12px; color: #a3a3a3; margin: 0;">Submitted ${escapeHtml(acceptedAt)} by ${escapeHtml(sigBy)}.</p>
      </div>
    `;
    const r1 = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': brevoKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        sender: { name: 'Cody A Smith Portal', email: 'cody@codyasmith.com' },
        to: [{ email: 'cody@codyasmith.com', name: 'Cody Smith' }],
        subject: stripCRLF('Raised Bar engagement accepted'),
        htmlContent: codyHtml,
      }),
    });
    if (r1.ok) sentTo.push('cody@codyasmith.com');
    else logger.error(`Brevo Cody notification failed: ${r1.status}`, await r1.text());
  } catch (err) {
    logger.error('Brevo Cody notification threw', err);
  }

  // Confirmation to Jason and Kevin.
  for (const signerEmail of SIGNER_EMAILS) {
    try {
      const signerHtml = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 22px; color: #1a1814; line-height: 1.55;">
          <h2 style="font-size: 22px; margin: 0 0 16px;">Engagement confirmed</h2>
          <p style="font-size: 15px; color: #4a4239; margin: 0 0 16px;">Thanks for sending in your acceptance. Here is what you both picked:</p>
          <table style="width: 100%; border-collapse: collapse; font-size: 14px; margin-bottom: 20px;">
            <tr><td style="padding: 6px 0; color: #6b6359;">Engagement tier</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">${escapeHtml(tierData.name)}</td></tr>
            <tr><td style="padding: 6px 0; color: #6b6359;">Tailwater micro-site</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">${addOn === 'yes' ? 'Yes, added' : 'No, single unified site'}</td></tr>
            <tr><td style="padding: 6px 0; color: #6b6359; border-top: 1px solid #e6ddd0;">One-time at signing</td><td style="padding: 6px 0; text-align: right; font-weight: 600; border-top: 1px solid #e6ddd0;">${escapeHtml(moneyInt(oneTime))}</td></tr>
            <tr><td style="padding: 6px 0; color: #6b6359;">Monthly recurring</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">${escapeHtml(money(monthly))}</td></tr>
          </table>
          <p style="font-size: 15px; color: #4a4239; margin: 0 0 16px;">
            Formal contracts and the first invoice will follow within the week. I will be in touch directly. Reach me at <a href="mailto:cody@codyasmith.com" style="color: #c47d5a;">cody@codyasmith.com</a> or by phone with anything you need before then.
          </p>
          <p style="font-size: 13px; color: #6b6359; margin: 24px 0 0; padding-top: 16px; border-top: 1px solid #e6ddd0;">Cody Smith, Cody A Smith LLC &middot; codyasmith.com</p>
        </div>
      `;
      const r2 = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': brevoKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          sender: { name: 'Cody Smith', email: 'cody@codyasmith.com' },
          to: [{ email: signerEmail }],
          subject: stripCRLF('Raised Bar engagement confirmed'),
          htmlContent: signerHtml,
        }),
      });
      if (r2.ok) sentTo.push(signerEmail);
      else logger.error(`Brevo confirmation to ${signerEmail} failed: ${r2.status}`, await r2.text());
    } catch (err) {
      logger.error(`Brevo confirmation to ${signerEmail} threw`, err);
    }
  }

  return json({ ok: true, confirmation_emails: sentTo.join(', ') });
};
