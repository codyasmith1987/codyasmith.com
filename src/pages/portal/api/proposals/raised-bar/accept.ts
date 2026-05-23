// Shared proposal draft + countersign endpoint for the Raised Bar
// engagement.
//
// GET  /portal/api/proposals/raised-bar/accept
//   Returns the current draft for the user's client, plus which signer
//   the calling user is (jason | kevin | admin).
//
// POST /portal/api/proposals/raised-bar/accept
//   Upserts the draft. Body fields:
//     - mgmt_tier, option, consulting, consulting_tier   (selections)
//     - signature                                         (typed name)
//   The signature is saved against jason_signature or kevin_signature
//   based on which user is signed in (email match). When both
//   signatures are present after this write, the endpoint:
//     1. marks the draft finalized,
//     2. logs activity,
//     3. sends Cody the decision summary,
//     4. sends Jason and Kevin individual confirmations.
//   If only one signature is present, returns status='waiting' so the
//   page can show a "signed, waiting for [other]" panel.
//
// Auth: portal-authenticated user (admin or Raised Bar Group client).
// Admin can preview selections and read state but cannot persist
// selections or sign, otherwise admin clicks would clobber the real
// signers' draft. CSRF enforced by middleware on POST.

import type { APIRoute } from 'astro';
import { getClientBySlug } from '../../../../../lib/auth';
import { logActivity } from '../../../../../lib/activity';
import { logger } from '../../../../../lib/logger';
import { escapeHtml, stripCRLF } from '../../../../../lib/email-safety';
import {
  getDraft,
  upsertDraft,
  markFinalized,
  identifySigner,
  type ProposalDraft,
} from '../../../../../lib/proposal-drafts';

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
const PROPOSAL_SLUG = 'raised-bar';

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

async function isAuthorized(user: any) {
  const client = await getClientBySlug(CLIENT_SLUG);
  if (!client) return { ok: false, client: null };
  if (user.role === 'admin') return { ok: true, client };
  if (user.client_id === client.id) return { ok: true, client };
  return { ok: false, client: null };
}

function pickPublicDraft(draft: ProposalDraft | null) {
  if (!draft) return null;
  return {
    mgmt_tier: draft.mgmt_tier,
    option: draft.option,
    consulting: draft.consulting,
    consulting_tier: draft.consulting_tier,
    jason_signature: draft.jason_signature,
    jason_signed_at: draft.jason_signed_at,
    kevin_signature: draft.kevin_signature,
    kevin_signed_at: draft.kevin_signed_at,
    finalized_at: draft.finalized_at,
  };
}

export const GET: APIRoute = async ({ locals }) => {
  const user = locals.user;
  if (!user) return json({ error: 'Not authenticated' }, 401);

  const { ok, client } = await isAuthorized(user);
  if (!ok || !client) return json({ error: 'Forbidden' }, 403);

  const draft = await getDraft(client.id, PROPOSAL_SLUG);
  const signer = user.role === 'admin' ? 'admin' : identifySigner(user.email);
  return json({ draft: pickPublicDraft(draft), signer });
};

export const POST: APIRoute = async ({ locals, request }) => {
  const user = locals.user;
  if (!user) return json({ error: 'Not authenticated' }, 401);

  const { ok, client } = await isAuthorized(user);
  if (!ok || !client) return json({ error: 'Forbidden' }, 403);

  // Admin can preview but cannot persist draft changes or sign.
  if (user.role === 'admin') {
    return json({ error: 'Admin preview mode. The proposal must be filled out and signed by Jason or Kevin.' }, 403);
  }
  const signer = identifySigner(user.email);
  if (!signer) {
    return json({ error: 'Only Jason or Kevin can sign this proposal.' }, 403);
  }

  // Reject further mutations on a finalized draft so an admin
  // changing the spec or one signer revising after both signatures
  // never accidentally restarts the email cycle or rewrites the deal.
  const existingDraft = await getDraft(client.id, PROPOSAL_SLUG);
  if (existingDraft?.finalized_at) {
    return json({
      ok: true,
      status: 'finalized',
      draft: pickPublicDraft(existingDraft),
      signer,
      confirmation_emails: '',
    });
  }

  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request body' }, 400); }

  // Selections: only persist if present and valid. Allow empty body for a no-op fetch via GET equivalent.
  const update: any = {};

  if (body.mgmt_tier !== undefined) {
    const v = String(body.mgmt_tier || '').toLowerCase();
    if (v && !(v in MGMT_TIERS)) return json({ error: 'Invalid mgmt_tier' }, 400);
    update.mgmt_tier = v || null;
  }
  if (body.option !== undefined) {
    const v = String(body.option || '').toLowerCase();
    if (v && v !== 'o1' && v !== 'o2') return json({ error: 'Invalid option' }, 400);
    update.option = v || null;
  }
  if (body.consulting !== undefined) {
    const v = String(body.consulting || '').toLowerCase();
    if (v && v !== 'yes' && v !== 'no') return json({ error: 'Invalid consulting' }, 400);
    update.consulting = v || null;
    // If switching to 'no', null out the consulting tier
    if (v === 'no') update.consulting_tier = null;
  }
  if (body.consulting_tier !== undefined) {
    const v = String(body.consulting_tier || '').toLowerCase();
    if (v && !(v in CONSULTING_TIERS)) return json({ error: 'Invalid consulting_tier' }, 400);
    update.consulting_tier = v || null;
  }
  if (body.signature !== undefined) {
    const v = String(body.signature || '').trim();
    if (!v) return json({ error: 'Signature is required to sign' }, 400);
    if (v.length > 120) return json({ error: 'Signature is too long' }, 400);
    if (signer === 'jason') update.jason_signature = v;
    if (signer === 'kevin') update.kevin_signature = v;
  }

  const draft = await upsertDraft(client.id, PROPOSAL_SLUG, update);

  // If both signatures are present, finalize (send emails + mark in DB).
  // This guards on the draft being complete enough to email.
  const both = !!(draft.jason_signature && draft.kevin_signature);
  const ready = !!(draft.mgmt_tier && draft.option && draft.consulting
    && (draft.consulting !== 'yes' || draft.consulting_tier));

  let status: 'saved' | 'waiting' | 'finalized' = 'saved';
  let confirmationEmails: string[] = [];

  if (both && ready && !draft.finalized_at) {
    const t = draft.mgmt_tier as MgmtTier;
    const opt = draft.option as Option;
    const consulting = draft.consulting as 'yes' | 'no';
    const consultingTier = (draft.consulting_tier as ConsultingTier) || null;
    const breakdown = buildBreakdown(t, opt, consulting, consultingTier);
    const oneTime = breakdown.reduce((s, r) => s + r.amount, 0);
    const mgmtMo = mgmtMonthly(t, opt);
    const consultingMo = consulting === 'yes' && consultingTier ? CONSULTING_TIERS[consultingTier].monthly : 0;
    const monthly = mgmtMo + consultingMo;
    const acceptedAt = new Date().toISOString();

    await logActivity({
      clientId: client.id,
      userId: user.id,
      action: 'accepted',
      entityType: 'proposal',
      entityId: PROPOSAL_SLUG,
      summary: `Raised Bar accepted: mgmt=${t}, option=${opt}, consulting=${consulting}${consultingTier ? ' ' + consultingTier : ''}, one_time=${oneTime}, monthly=${monthly.toFixed(2)}, jason="${draft.jason_signature}", kevin="${draft.kevin_signature}"`,
    });

    const brevoKey = import.meta.env.BREVO_API_KEY;
    if (brevoKey) {
      const breakdownTable = breakdown.map(r =>
        `<tr><td style="padding: 4px 0; color: #6b6359;">${escapeHtml(r.label)}</td><td style="padding: 4px 0; text-align: right; color: #1a1814;">${escapeHtml(moneyInt(r.amount))}</td></tr>`
      ).join('');

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
              ${breakdownTable}
              <tr><td style="padding: 8px 0 0; border-top: 1px solid #d4cdc0; font-weight: 600;">Total</td><td style="padding: 8px 0 0; text-align: right; border-top: 1px solid #d4cdc0; font-weight: 600;">${escapeHtml(moneyInt(oneTime))}</td></tr>
            </table>
            <p style="font-size: 12px; color: #6b6359; margin: 18px 0 6px; letter-spacing: 0.06em; text-transform: uppercase;">Monthly recurring</p>
            <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 20px;">
              <tr><td style="padding: 4px 0; color: #6b6359;">Web Management (${escapeHtml(MGMT_TIERS[t].name)}, ${opt === 'o2' ? '3' : '2'} sites)</td><td style="padding: 4px 0; text-align: right; color: #1a1814;">${escapeHtml(money(mgmtMo))}</td></tr>
              ${consulting === 'yes' && consultingTier ? `<tr><td style="padding: 4px 0; color: #6b6359;">Marketing Consulting (${escapeHtml(CONSULTING_TIERS[consultingTier].name)})</td><td style="padding: 4px 0; text-align: right; color: #1a1814;">${escapeHtml(money(CONSULTING_TIERS[consultingTier].monthly))}</td></tr>` : ''}
              <tr><td style="padding: 8px 0 0; border-top: 1px solid #d4cdc0; font-weight: 600;">Total</td><td style="padding: 8px 0 0; text-align: right; border-top: 1px solid #d4cdc0; font-weight: 600;">${escapeHtml(money(monthly))}</td></tr>
            </table>
            <p style="font-size: 14px; color: #6b6359; margin: 0 0 8px;">Signed as Jason Roth: <strong style="color: #1a1814;">${escapeHtml(draft.jason_signature || '')}</strong> (${escapeHtml(draft.jason_signed_at || '')})</p>
            <p style="font-size: 14px; color: #6b6359; margin: 0 0 16px;">Signed as Kevin Adams: <strong style="color: #1a1814;">${escapeHtml(draft.kevin_signature || '')}</strong> (${escapeHtml(draft.kevin_signed_at || '')})</p>
            <p style="font-size: 12px; color: #a3a3a3; margin: 0;">Finalized ${escapeHtml(acceptedAt)}.</p>
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
        if (r1.ok) confirmationEmails.push('cody@codyasmith.com');
        else logger.error(`Brevo Cody notification failed: ${r1.status}`, await r1.text());
      } catch (err) {
        logger.error('Brevo Cody notification threw', err);
      }

      // Signer confirmations.
      for (const signerEmail of ['jasonroth1122@gmail.com', 'kevo.adams@gmail.com']) {
        try {
          const signerHtml = `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 22px; color: #1a1814; line-height: 1.55;">
              <h2 style="font-size: 22px; margin: 0 0 16px;">Engagement confirmed</h2>
              <p style="font-size: 15px; color: #4a4239; margin: 0 0 16px;">Both signatures are in. Here is what you both picked:</p>
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
          if (r2.ok) confirmationEmails.push(signerEmail);
          else logger.error(`Brevo confirmation to ${signerEmail} failed: ${r2.status}`, await r2.text());
        } catch (err) {
          logger.error(`Brevo confirmation to ${signerEmail} threw`, err);
        }
      }
    }

    await markFinalized(client.id, PROPOSAL_SLUG);
    status = 'finalized';
  } else if (body.signature !== undefined && !both) {
    status = 'waiting';

    // First-signer notification: ping the other signer that their partner has signed.
    const brevoKey = import.meta.env.BREVO_API_KEY;
    if (brevoKey) {
      const otherEmail = signer === 'jason' ? 'kevo.adams@gmail.com' : 'jasonroth1122@gmail.com';
      const otherName = signer === 'jason' ? 'Kevin' : 'Jason';
      const justSignedName = signer === 'jason' ? 'Jason' : 'Kevin';
      try {
        await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: { 'api-key': brevoKey, 'content-type': 'application/json' },
          body: JSON.stringify({
            sender: { name: 'Cody Smith', email: 'cody@codyasmith.com' },
            to: [{ email: otherEmail, name: otherName }],
            subject: stripCRLF(`${justSignedName} has signed the Raised Bar proposal. Your turn.`),
            htmlContent: `
              <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 22px; color: #1a1814; line-height: 1.55;">
                <h2 style="font-size: 22px; margin: 0 0 16px;">Hey ${escapeHtml(otherName)},</h2>
                <p style="font-size: 15px; color: #4a4239; margin: 0 0 12px;">
                  ${escapeHtml(justSignedName)} just signed the Raised Bar engagement proposal in the portal. The selections and ${escapeHtml(justSignedName)}'s signature are saved; the proposal is waiting on your countersign.
                </p>
                <p style="font-size: 15px; color: #4a4239; margin: 0 0 24px;">
                  Log in to the portal at codyasmith.com. The selections will already be in place. Review them, type your name in your signature field, and click countersign. Both confirmations send when you do.
                </p>
                <a href="https://codyasmith.com/portal/login" style="display: inline-block; background: #c47d5a; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">Log in and countersign</a>
                <p style="font-size: 13px; color: #6b6359; margin: 24px 0 0; padding-top: 16px; border-top: 1px solid #e6ddd0;">Cody Smith, Cody A Smith LLC &middot; codyasmith.com</p>
              </div>
            `,
          }),
        });
      } catch (err) {
        logger.error('Brevo first-signer-ping threw', err);
      }
    }
  }

  return json({
    ok: true,
    status,
    draft: pickPublicDraft(draft),
    signer,
    confirmation_emails: confirmationEmails.join(', '),
  });
};
