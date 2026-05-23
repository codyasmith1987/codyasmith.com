// Interactive proposal acceptance endpoint for the Raised Bar engagement.
//
// Accepts the four-step decision from the proposal page:
//   - mgmt_tier: 'good' | 'better' | 'best'
//   - option:    'o1' | 'o2'  (single unified site vs split with micro-site)
//   - consulting: 'yes' | 'no'
//   - consulting_tier: 'good' | 'better' | 'best'  (required only when consulting === 'yes')
//   - jason_name, kevin_name (typed signatures)
//
// Authorizes against the same gate as the proposal page (admin OR Raised
// Bar Group client). Admin is blocked from submit so admin preview does
// not fire emails. CSRF is enforced by portal middleware on /portal/api/*
// mutating requests.
//
// On success: logs activity, emails Cody the decision summary, emails
// Jason and Kevin individual confirmations.

import type { APIRoute } from 'astro';
import { getClientBySlug } from '../../../../../lib/auth';
import { logActivity } from '../../../../../lib/activity';
import { logger } from '../../../../../lib/logger';
import { escapeHtml, stripCRLF } from '../../../../../lib/email-safety';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const MGMT_TIERS = {
  good:   { name: 'Good',   base: 297,  onb: 800,  hoursBase: 3 },
  better: { name: 'Better', base: 497,  onb: 800,  hoursBase: 5 },
  best:   { name: 'Best',   base: 647,  onb: 1000, hoursBase: 8 },
} as const;
const CONSULTING_TIERS = {
  good:   { name: 'Good',   monthly: 497,  audit: 1500 },
  better: { name: 'Better', monthly: 997,  audit: 2500 },
  best:   { name: 'Best',   monthly: 1497, audit: 4000 },
} as const;
const BUILD_BUILDERS = 5625;
const BUILD_TAILWATER = 4500;
const F3_ONBOARDING = 800;
const CLIENT_SLUG = 'raised-bar-group';
const SIGNER_EMAILS = ['jasonroth1122@gmail.com', 'kevo.adams@gmail.com'];

type MgmtTier = keyof typeof MGMT_TIERS;
type ConsultingTier = keyof typeof CONSULTING_TIERS;
type Option = 'o1' | 'o2';

function moneyInt(n: number): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function money(n: number): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function mgmtMonthly(tier: MgmtTier, option: Option): number {
  const base = MGMT_TIERS[tier].base;
  const sites = option === 'o2' ? 3 : 2;
  return base + (sites - 1) * base * 0.80;
}
function buildBreakdown(
  tier: MgmtTier,
  option: Option,
  consulting: 'yes' | 'no',
  consultingTier: ConsultingTier | null,
): Array<{ label: string; amount: number }> {
  const rows: Array<{ label: string; amount: number }> = [];
  rows.push({ label: 'Builders site build', amount: BUILD_BUILDERS });
  rows.push({ label: 'Builders Web Management onboarding', amount: MGMT_TIERS[tier].onb });
  rows.push({ label: 'F3 Properties takeover onboarding', amount: F3_ONBOARDING });
  if (option === 'o2') {
    rows.push({ label: 'Tailwater micro-site build', amount: BUILD_TAILWATER });
    rows.push({ label: 'Tailwater multi-site onboarding addition', amount: MGMT_TIERS[tier].onb * 0.25 });
  }
  if (consulting === 'yes' && consultingTier) {
    rows.push({ label: `Marketing Consulting ${CONSULTING_TIERS[consultingTier].name} initial audit`, amount: CONSULTING_TIERS[consultingTier].audit });
  }
  return rows;
}

export const POST: APIRoute = async ({ locals, request }) => {
  const user = locals.user;
  if (!user) return json({ error: 'Not authenticated' }, 401);

  // Admin preview mode — admins can view the page but cannot accept the
  // proposal, otherwise an admin Send would email Jason and Kevin
  // confirmations without their real acceptance.
  if (user.role === 'admin') {
    return json({ error: 'Admin preview mode. The proposal must be accepted by a Raised Bar Group client user (Jason or Kevin).' }, 403);
  }
  const client = await getClientBySlug(CLIENT_SLUG);
  if (!client || user.client_id !== client.id) {
    return json({ error: 'Forbidden' }, 403);
  }

  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request body' }, 400); }

  const mgmtTier = String(body?.mgmt_tier || '').toLowerCase();
  const option = String(body?.option || '').toLowerCase();
  const consulting = String(body?.consulting || '').toLowerCase();
  const consultingTierRaw = String(body?.consulting_tier || '').toLowerCase();
  const jasonName = String(body?.jason_name || '').trim();
  const kevinName = String(body?.kevin_name || '').trim();

  if (!(mgmtTier in MGMT_TIERS)) return json({ error: 'Invalid mgmt_tier' }, 400);
  if (option !== 'o1' && option !== 'o2') return json({ error: 'Invalid option' }, 400);
  if (consulting !== 'yes' && consulting !== 'no') return json({ error: 'Invalid consulting' }, 400);
  let consultingTier: ConsultingTier | null = null;
  if (consulting === 'yes') {
    if (!(consultingTierRaw in CONSULTING_TIERS)) return json({ error: 'Consulting tier is required when consulting is yes' }, 400);
    consultingTier = consultingTierRaw as ConsultingTier;
  }
  if (!jasonName || jasonName.length > 120) return json({ error: 'Jason name is required' }, 400);
  if (!kevinName || kevinName.length > 120) return json({ error: 'Kevin name is required' }, 400);

  const t = mgmtTier as MgmtTier;
  const opt = option as Option;
  const breakdown = buildBreakdown(t, opt, consulting as 'yes' | 'no', consultingTier);
  const oneTime = breakdown.reduce((s, r) => s + r.amount, 0);
  const mgmtMo = mgmtMonthly(t, opt);
  const consultingMo = consulting === 'yes' && consultingTier ? CONSULTING_TIERS[consultingTier].monthly : 0;
  const monthly = mgmtMo + consultingMo;
  const acceptedAt = new Date().toISOString();
  const sigBy = `${user.name} (${user.email})`;

  await logActivity({
    clientId: client?.id || null,
    userId: user.id,
    action: 'accepted',
    entityType: 'proposal',
    entityId: 'raised-bar',
    summary: `Raised Bar accepted: mgmt=${mgmtTier}, option=${option}, consulting=${consulting}${consultingTier ? ' ' + consultingTier : ''}, one_time=${oneTime}, monthly=${monthly.toFixed(2)}, jason="${jasonName}", kevin="${kevinName}", sigBy=${sigBy}`,
  });

  const brevoKey = import.meta.env.BREVO_API_KEY;
  const sentTo: string[] = [];

  if (!brevoKey) {
    return json({ ok: true, confirmation_emails: '(email service not configured; acceptance logged)' });
  }

  function breakdownTable(): string {
    return breakdown.map(r =>
      `<tr><td style="padding: 4px 0; color: #6b6359;">${escapeHtml(r.label)}</td><td style="padding: 4px 0; text-align: right; color: #1a1814;">${escapeHtml(moneyInt(r.amount))}</td></tr>`
    ).join('');
  }

  // Cody notification.
  try {
    const codyHtml = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 32px 22px; color: #1a1814; line-height: 1.55;">
        <h2 style="font-size: 22px; margin: 0 0 16px;">Raised Bar engagement accepted</h2>
        <table style="width: 100%; border-collapse: collapse; font-size: 14px; margin-bottom: 20px;">
          <tr><td style="padding: 6px 0; color: #6b6359;">Web Management</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">${escapeHtml(MGMT_TIERS[t].name)}</td></tr>
          <tr><td style="padding: 6px 0; color: #6b6359;">Site setup</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">${opt === 'o1' ? 'Option 1: Single unified site (2 sites managed)' : 'Option 2: Split setup with micro-site (3 sites managed)'}</td></tr>
          <tr><td style="padding: 6px 0; color: #6b6359;">Marketing Consulting</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">${consulting === 'yes' && consultingTier ? CONSULTING_TIERS[consultingTier].name : 'Skipped'}</td></tr>
        </table>
        <p style="font-size: 12px; color: #6b6359; margin: 0 0 6px; letter-spacing: 0.06em; text-transform: uppercase;">One-time at signing</p>
        <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 16px;">
          ${breakdownTable()}
          <tr><td style="padding: 8px 0 0; border-top: 1px solid #d4cdc0; font-weight: 600;">Total</td><td style="padding: 8px 0 0; text-align: right; border-top: 1px solid #d4cdc0; font-weight: 600;">${escapeHtml(moneyInt(oneTime))}</td></tr>
        </table>
        <p style="font-size: 12px; color: #6b6359; margin: 18px 0 6px; letter-spacing: 0.06em; text-transform: uppercase;">Monthly recurring</p>
        <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 20px;">
          <tr><td style="padding: 4px 0; color: #6b6359;">Web Management (${escapeHtml(MGMT_TIERS[t].name)}, ${opt === 'o2' ? '3' : '2'} sites)</td><td style="padding: 4px 0; text-align: right; color: #1a1814;">${escapeHtml(money(mgmtMo))}</td></tr>
          ${consulting === 'yes' && consultingTier ? `<tr><td style="padding: 4px 0; color: #6b6359;">Marketing Consulting (${escapeHtml(CONSULTING_TIERS[consultingTier].name)})</td><td style="padding: 4px 0; text-align: right; color: #1a1814;">${escapeHtml(money(CONSULTING_TIERS[consultingTier].monthly))}</td></tr>` : ''}
          <tr><td style="padding: 8px 0 0; border-top: 1px solid #d4cdc0; font-weight: 600;">Total</td><td style="padding: 8px 0 0; text-align: right; border-top: 1px solid #d4cdc0; font-weight: 600;">${escapeHtml(money(monthly))}</td></tr>
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

  // Signer confirmations.
  for (const signerEmail of SIGNER_EMAILS) {
    try {
      const signerHtml = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 22px; color: #1a1814; line-height: 1.55;">
          <h2 style="font-size: 22px; margin: 0 0 16px;">Engagement confirmed</h2>
          <p style="font-size: 15px; color: #4a4239; margin: 0 0 16px;">Thanks for sending in your acceptance. Here is what you both picked:</p>
          <table style="width: 100%; border-collapse: collapse; font-size: 14px; margin-bottom: 20px;">
            <tr><td style="padding: 6px 0; color: #6b6359;">Web Management</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">${escapeHtml(MGMT_TIERS[t].name)}</td></tr>
            <tr><td style="padding: 6px 0; color: #6b6359;">Site setup</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">${opt === 'o1' ? 'Single unified site' : 'Split (with Tailwater micro-site)'}</td></tr>
            <tr><td style="padding: 6px 0; color: #6b6359;">Marketing Consulting</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">${consulting === 'yes' && consultingTier ? CONSULTING_TIERS[consultingTier].name : 'Skipped'}</td></tr>
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
