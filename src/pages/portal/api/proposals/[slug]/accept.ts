// Generic shared proposal draft + countersign endpoint.
//
// GET  /portal/api/proposals/[slug]/accept
//   Returns the current draft for the user's client, the signer
//   identification (matching signer object from config, or 'admin' for
//   the owner), and the proposal config blob (so the page caller can
//   compute things like totals against the same source of truth the
//   server uses).
//
// POST /portal/api/proposals/[slug]/accept
//   Upserts the draft. Body fields:
//     - selections: { [stepId: string]: string | null }   (per-step picks)
//     - signature: string                                  (typed name; signed under the calling user's identity)
//     - revoke: true                                       (clears the calling user's own signature)
//   The selections object is validated against the proposal's config:
//   every key must be a known step id, every value must be a known
//   option id under that step (or null to clear). Signature length
//   capped at 120 chars.
//
//   When both signatures are present and selections are complete, the
//   endpoint marks the draft finalized, logs activity, and sends the
//   email cycle (Cody summary + per-signer confirmation). When the
//   first signer signs, the other signer gets a 'your turn' email.
//   When a signer changes selections after the partner has signed, the
//   partner gets a 'selections changed' email. When a signer revokes,
//   the partner gets a 'revoked' email.
//
//   The pricing math is dispatched by config.pricing_formula. For now
//   only 'raised_bar_v1' is implemented, matching the legacy endpoint
//   exactly. New proposals would add their own formula here.
//
// Auth: portal-authenticated user, admin OR matching client. Admin can
// preview state but cannot persist selections or sign (otherwise admin
// previews would clobber the real signers' draft). CSRF enforced by
// middleware on POST.

import type { APIRoute } from 'astro';
import { logActivity } from '../../../../../lib/activity';
import { logger } from '../../../../../lib/logger';
import { escapeHtml, stripCRLF } from '../../../../../lib/email-safety';
import {
  getDraft,
  upsertDraftGeneric,
  markFinalized,
  identifySignerFromConfig,
  type ProposalDraft,
  type ProposalSigner,
} from '../../../../../lib/proposal-drafts';
import turso from '../../../../../lib/turso';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// Proposal row + parsed config shape. Loaded once per request from
// the proposals table; the config blob carries narrative, steps,
// signers, and pricing formula identifier.
type ProposalRow = {
  id: string;
  slug: string;
  client_id: string;
  title: string;
  config: any;
  status: string;
  finalized_at: string | null;
};

async function loadProposal(slug: string): Promise<ProposalRow | null> {
  const result = await turso.execute({
    sql: `SELECT id, slug, client_id, title, config, status, finalized_at
          FROM proposals WHERE slug = ?`,
    args: [slug],
  });
  if (result.rows.length === 0) return null;
  const row = result.rows[0] as any[];
  let config: any = {};
  try { config = JSON.parse(row[4] as string); } catch { /* defensive: leave empty */ }
  return {
    id: row[0] as string,
    slug: row[1] as string,
    client_id: row[2] as string,
    title: row[3] as string,
    config,
    status: row[5] as string,
    finalized_at: row[6] as string | null,
  };
}

// Auth gate matching the page: admin OR proposal-client. Returns the
// proposal row so the caller doesn't refetch.
async function authorize(user: any, slug: string): Promise<{ ok: boolean; proposal: ProposalRow | null }> {
  const proposal = await loadProposal(slug);
  if (!proposal) return { ok: false, proposal: null };
  if (user.role === 'admin') return { ok: true, proposal };
  if (user.client_id === proposal.client_id) return { ok: true, proposal };
  return { ok: false, proposal: null };
}

// Trim the draft to only the public-safe fields. Legacy field names
// kept so the front-end (which already knows them) keeps working; the
// generic selections/signatures objects are also returned for callers
// that want to drive purely off the generic shape.
function pickPublicDraft(draft: ProposalDraft | null) {
  if (!draft) return null;
  return {
    selections: draft.selections,
    signatures: draft.signatures,
    // Legacy convenience aliases for the existing page JS. The Phase 2
    // page reads these names so it can share the same client-side
    // state shape with no churn.
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

// Build a flat map of valid option ids per step id from the config so
// we can validate incoming selections.
function buildOptionIndex(config: any): Record<string, Set<string>> {
  const index: Record<string, Set<string>> = {};
  if (!config || !Array.isArray(config.steps)) return index;
  for (const step of config.steps) {
    if (!step?.id || !Array.isArray(step.options)) continue;
    const ids = new Set<string>();
    for (const opt of step.options) {
      if (opt?.id) ids.add(String(opt.id));
    }
    index[step.id] = ids;
  }
  return index;
}

// raised_bar_v1 pricing formula. Mirrors the legacy accept endpoint
// math so the totals on the Cody-notification email and the activity
// log entry stay identical to what the hardcoded version emitted.
const RB_MGMT_TIERS = {
  good:   { name: 'Good',   base: 297,  onb: 800 },
  better: { name: 'Better', base: 497,  onb: 800 },
  best:   { name: 'Best',   base: 647,  onb: 1000 },
} as const;
const RB_CONSULTING_TIERS = {
  good:   { name: 'Good',   monthly: 497,  audit: 1500 },
  better: { name: 'Better', monthly: 997,  audit: 2500 },
  best:   { name: 'Best',   monthly: 1497, audit: 4000 },
} as const;
const RB_BUILD_BUILDERS = 5625;
const RB_BUILD_TAILWATER = 4500;
const RB_F3_ONBOARDING = 800;

type RbMgmtTier = keyof typeof RB_MGMT_TIERS;
type RbConsultingTier = keyof typeof RB_CONSULTING_TIERS;
type RbOption = 'o1' | 'o2';

function moneyInt(n: number): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function money(n: number): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

type PricingResult = {
  oneTime: number;
  monthly: number;
  breakdown: Array<{ label: string; amount: number }>;
  mgmtMonthly: number;
  consultingMonthly: number;
  // Display strings used in the email templates so we don't duplicate
  // formatting logic between the formula and the email builder.
  mgmtTierName: string;
  consultingTierName: string;
  siteSetupShortLabel: string;
  siteSetupLongLabel: string;
};

function computeRaisedBarV1(selections: Record<string, string | null>): PricingResult | null {
  const tier = (selections.mgmt_tier || '') as RbMgmtTier;
  const opt = (selections.site_setup || '') as RbOption;
  const consulting = (selections.consulting || '') as 'yes' | 'no' | '';
  const consultingTier = (selections.consulting_tier || '') as RbConsultingTier | '';

  if (!(tier in RB_MGMT_TIERS) || (opt !== 'o1' && opt !== 'o2')) return null;
  if (consulting !== 'yes' && consulting !== 'no') return null;
  if (consulting === 'yes' && !(consultingTier in RB_CONSULTING_TIERS)) return null;

  const sites = opt === 'o2' ? 3 : 2;
  const base = RB_MGMT_TIERS[tier].base;
  const mgmtMo = base + (sites - 1) * base * 0.80;
  const consultingMo = consulting === 'yes' && consultingTier ? RB_CONSULTING_TIERS[consultingTier as RbConsultingTier].monthly : 0;

  const breakdown: Array<{ label: string; amount: number }> = [];
  breakdown.push({ label: 'Builders site build', amount: RB_BUILD_BUILDERS });
  breakdown.push({ label: 'Builders Web Management onboarding', amount: RB_MGMT_TIERS[tier].onb });
  breakdown.push({ label: 'F3 Properties takeover onboarding', amount: RB_F3_ONBOARDING });
  if (opt === 'o2') {
    breakdown.push({ label: 'Tailwater micro-site build', amount: RB_BUILD_TAILWATER });
    breakdown.push({ label: 'Tailwater multi-site onboarding addition', amount: RB_MGMT_TIERS[tier].onb * 0.25 });
  }
  if (consulting === 'yes' && consultingTier) {
    breakdown.push({
      label: `Marketing Consulting ${RB_CONSULTING_TIERS[consultingTier as RbConsultingTier].name} initial audit`,
      amount: RB_CONSULTING_TIERS[consultingTier as RbConsultingTier].audit,
    });
  }
  const oneTime = breakdown.reduce((s, r) => s + r.amount, 0);
  const monthly = mgmtMo + consultingMo;

  return {
    oneTime,
    monthly,
    breakdown,
    mgmtMonthly: mgmtMo,
    consultingMonthly: consultingMo,
    mgmtTierName: RB_MGMT_TIERS[tier].name,
    consultingTierName: consulting === 'yes' && consultingTier ? RB_CONSULTING_TIERS[consultingTier as RbConsultingTier].name : '',
    siteSetupShortLabel: opt === 'o1' ? 'Single unified site' : 'Split (with Tailwater micro-site)',
    siteSetupLongLabel: opt === 'o1'
      ? 'Option 1: Single unified site (2 sites managed)'
      : 'Option 2: Split setup with micro-site (3 sites managed)',
  };
}

// Dispatch by config.pricing_formula. New formulas plug in here.
function computePricing(formula: string, selections: Record<string, string | null>): PricingResult | null {
  if (formula === 'raised_bar_v1') return computeRaisedBarV1(selections);
  return null;
}

// Helper: check whether the draft has all the selections it needs to
// finalize. Walks the steps in the config and verifies each non-
// conditional step has a value, and each conditional step (`show_when`
// matched) also has a value.
function selectionsComplete(config: any, selections: Record<string, string | null>): boolean {
  if (!config || !Array.isArray(config.steps)) return false;
  for (const step of config.steps) {
    if (!step?.id) continue;
    if (step.show_when) {
      const [whenKey, whenVal] = Object.entries(step.show_when)[0] as [string, string];
      if (selections[whenKey] !== whenVal) continue; // step not shown, skip
    }
    if (!selections[step.id]) return false;
  }
  return true;
}

// Identify all configured signers as an array, with current signature
// state from the draft attached. Used by the email-flow logic that
// asks 'has any signer signed?', 'has the partner of the current
// signer signed?', etc.
function describeSigners(config: any, draft: ProposalDraft | null) {
  const list: Array<ProposalSigner & {
    signed: boolean;
    signature: string | null;
    signed_at: string | null;
  }> = [];
  const signers: ProposalSigner[] = Array.isArray(config?.signers) ? config.signers : [];
  for (const s of signers) {
    const sig = draft?.signatures?.[s.id];
    list.push({
      ...s,
      signed: !!sig?.signature,
      signature: sig?.signature ?? null,
      signed_at: sig?.signed_at ?? null,
    });
  }
  return list;
}

// Build the per-row HTML used inside an email summary table. Keeps
// the look-and-feel identical to the legacy emails.
function summaryRowsHtml(pricing: PricingResult | null, selections: Record<string, string | null>): string {
  const mgmtName = pricing?.mgmtTierName || (selections.mgmt_tier || '?');
  const siteLabel = pricing?.siteSetupShortLabel || (selections.site_setup === 'o1' ? 'Option 1: Single unified site' : selections.site_setup === 'o2' ? 'Option 2: Split (with micro-site)' : '?');
  const consulting = selections.consulting;
  const consultingLabel = consulting === 'yes' && pricing?.consultingTierName
    ? pricing.consultingTierName
    : consulting === 'yes'
      ? '(level pending)'
      : 'Skipped';
  return `
    <tr><td style="padding: 6px 0; color: #6b6359;">Web Management</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">${escapeHtml(mgmtName)}</td></tr>
    <tr><td style="padding: 6px 0; color: #6b6359;">Site setup</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">${escapeHtml(siteLabel)}</td></tr>
    <tr><td style="padding: 6px 0; color: #6b6359;">Marketing Consulting</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">${escapeHtml(consultingLabel)}</td></tr>
  `;
}

// ============================================================
// Route handlers
// ============================================================

export const GET: APIRoute = async ({ locals, params }) => {
  const user = locals.user;
  if (!user) return json({ error: 'Not authenticated' }, 401);

  const slug = params.slug || '';
  if (!slug) return json({ error: 'Missing slug' }, 400);

  const { ok, proposal } = await authorize(user, slug);
  if (!ok || !proposal) return json({ error: 'Forbidden' }, 403);

  const draft = await getDraft(proposal.client_id, slug);
  const matched = user.role === 'admin'
    ? 'admin'
    : identifySignerFromConfig(user.email || '', proposal.config?.signers || []);

  // Signer value: 'admin' string for the owner preview, the matched
  // signer object for real signers, null for any other authorized
  // user (shouldn't happen given the client-level auth gate, but the
  // null branch keeps the page resilient).
  return json({
    draft: pickPublicDraft(draft),
    signer: matched,
    config: proposal.config,
  });
};

export const POST: APIRoute = async ({ locals, request, params }) => {
  const user = locals.user;
  if (!user) return json({ error: 'Not authenticated' }, 401);

  const slug = params.slug || '';
  if (!slug) return json({ error: 'Missing slug' }, 400);

  const { ok, proposal } = await authorize(user, slug);
  if (!ok || !proposal) return json({ error: 'Forbidden' }, 403);

  // Admin can preview but cannot persist or sign.
  if (user.role === 'admin') {
    return json({ error: 'Admin preview mode. The proposal must be filled out and signed by an authorized signer.' }, 403);
  }
  const signer = identifySignerFromConfig(user.email || '', proposal.config?.signers || []);
  if (!signer) {
    return json({ error: 'You are not an authorized signer on this proposal.' }, 403);
  }

  // Reject further mutations on a finalized draft. The legacy endpoint
  // returns ok with the existing draft rather than erroring; mirror
  // that so the front-end re-renders cleanly on a stale tab.
  const existingDraft = await getDraft(proposal.client_id, slug);
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

  // Validate selections payload against the config. Accept either the
  // generic { selections: { stepId: value } } shape OR the legacy
  // flat fields (mgmt_tier, option, consulting, consulting_tier) so
  // both clients can talk to this endpoint.
  const optionIndex = buildOptionIndex(proposal.config);
  const selectionsPatch: Record<string, string | null> = {};

  function ingestSelection(stepId: string, raw: any) {
    const v = raw === null || raw === undefined ? null : String(raw || '').toLowerCase().trim();
    if (v === '' || v === null) {
      selectionsPatch[stepId] = null;
      return null;
    }
    const allowed = optionIndex[stepId];
    if (allowed && !allowed.has(v)) {
      return `Invalid value for ${stepId}: ${v}`;
    }
    selectionsPatch[stepId] = v;
    return null;
  }

  if (body && typeof body.selections === 'object' && body.selections) {
    for (const stepId of Object.keys(body.selections)) {
      if (!(stepId in optionIndex)) return json({ error: `Unknown step id: ${stepId}` }, 400);
      const err = ingestSelection(stepId, body.selections[stepId]);
      if (err) return json({ error: err }, 400);
    }
  }
  // Legacy field names for backward compatibility (the Phase 2 page
  // also sends these so the data shape stays familiar to anyone
  // reading the network tab).
  if (body && body.mgmt_tier !== undefined) {
    const err = ingestSelection('mgmt_tier', body.mgmt_tier);
    if (err) return json({ error: err }, 400);
  }
  if (body && body.option !== undefined) {
    const err = ingestSelection('site_setup', body.option);
    if (err) return json({ error: err }, 400);
  }
  if (body && body.consulting !== undefined) {
    const err = ingestSelection('consulting', body.consulting);
    if (err) return json({ error: err }, 400);
    // Switching to 'no' clears the consulting tier so the draft stays
    // internally consistent.
    if (selectionsPatch.consulting === 'no') selectionsPatch.consulting_tier = null;
  }
  if (body && body.consulting_tier !== undefined) {
    const err = ingestSelection('consulting_tier', body.consulting_tier);
    if (err) return json({ error: err }, 400);
  }

  // Signature
  const signaturePatch: Record<string, { signature: string } | null> = {};
  let isRevoke = false;
  if (body && body.signature !== undefined) {
    const v = String(body.signature || '').trim();
    if (!v) return json({ error: 'Signature is required to sign' }, 400);
    if (v.length > 120) return json({ error: 'Signature is too long' }, 400);
    signaturePatch[signer.id] = { signature: v };
  }
  if (body && body.revoke === true) {
    isRevoke = true;
    signaturePatch[signer.id] = null;
  }

  // Detect selection changes so we can notify any partner who has
  // already signed. Signatures are NOT cleared automatically; the
  // partner stays on the hook and gets an email letting them know
  // what changed (with a revoke link if they want to re-review).
  function selectionChanged(stepId: string): boolean {
    if (!(stepId in selectionsPatch)) return false;
    const oldVal = existingDraft?.selections?.[stepId] ?? null;
    return oldVal !== selectionsPatch[stepId];
  }
  const changedStepLabels: string[] = [];
  if (selectionChanged('mgmt_tier')) changedStepLabels.push('Web Management level');
  if (selectionChanged('site_setup')) changedStepLabels.push('Site setup');
  if (selectionChanged('consulting')) changedStepLabels.push('Marketing Consulting yes/no');
  if (selectionChanged('consulting_tier')) changedStepLabels.push('Marketing Consulting level');

  // Apply the upsert with both selections and signatures patches.
  const draft = await upsertDraftGeneric(proposal.client_id, slug, {
    selections: selectionsPatch,
    signatures: Object.keys(signaturePatch).length ? signaturePatch : undefined,
  });

  const signersWithState = describeSigners(proposal.config, draft);
  const signerCount = signersWithState.length;
  const allSigned = signerCount > 0 && signersWithState.every(s => s.signed);
  const ready = selectionsComplete(proposal.config, draft.selections);

  // Identify the partner who has already signed (used for the
  // 'selections changed' email). Only meaningful in a two-signer
  // setup; the generic find still works for one-signer proposals
  // (no partner found, no email sent).
  const partnerAlreadySigned = signersWithState.find(s => s.id !== signer.id && s.signed && existingDraft?.signatures?.[s.id]?.signature);
  const partnerToNotify = changedStepLabels.length > 0 && partnerAlreadySigned ? partnerAlreadySigned : null;

  let status: 'saved' | 'waiting' | 'finalized' = 'saved';
  let confirmationEmails: string[] = [];

  // Finalize cycle
  if (allSigned && ready && !draft.finalized_at) {
    const pricing = computePricing(proposal.config?.pricing_formula || '', draft.selections);
    const acceptedAt = new Date().toISOString();

    const oneTime = pricing?.oneTime ?? 0;
    const monthly = pricing?.monthly ?? 0;

    // Activity log. Mirror the legacy summary so historical scans
    // looking for "Raised Bar accepted:" continue to find the row.
    const signatureSummaryParts: string[] = [];
    for (const s of signersWithState) {
      signatureSummaryParts.push(`${s.id}="${s.signature || ''}"`);
    }
    await logActivity({
      clientId: proposal.client_id,
      userId: user.id,
      action: 'accepted',
      entityType: 'proposal',
      entityId: slug,
      summary: `${proposal.title} accepted: ${Object.entries(draft.selections).map(([k, v]) => `${k}=${v ?? '-'}`).join(', ')}, one_time=${oneTime}, monthly=${monthly.toFixed(2)}, ${signatureSummaryParts.join(', ')}`,
    });

    const brevoKey = import.meta.env.BREVO_API_KEY;
    if (brevoKey) {
      // Cody notification — full breakdown table with totals.
      const breakdownTable = (pricing?.breakdown || []).map(r =>
        `<tr><td style="padding: 4px 0; color: #6b6359;">${escapeHtml(r.label)}</td><td style="padding: 4px 0; text-align: right; color: #1a1814;">${escapeHtml(moneyInt(r.amount))}</td></tr>`
      ).join('');
      const signedAsRows = signersWithState.map(s =>
        `<p style="font-size: 14px; color: #6b6359; margin: 0 0 8px;">Signed as ${escapeHtml(s.name)}: <strong style="color: #1a1814;">${escapeHtml(s.signature || '')}</strong> (${escapeHtml(s.signed_at || '')})</p>`
      ).join('');
      try {
        const codyHtml = `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 32px 22px; color: #1a1814; line-height: 1.55;">
            <h2 style="font-size: 22px; margin: 0 0 16px;">${escapeHtml(proposal.title)} accepted</h2>
            <table style="width: 100%; border-collapse: collapse; font-size: 14px; margin-bottom: 20px;">
              <tr><td style="padding: 6px 0; color: #6b6359;">Web Management</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">${escapeHtml(pricing?.mgmtTierName || '?')}</td></tr>
              <tr><td style="padding: 6px 0; color: #6b6359;">Site setup</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">${escapeHtml(pricing?.siteSetupLongLabel || '?')}</td></tr>
              <tr><td style="padding: 6px 0; color: #6b6359;">Marketing Consulting</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">${escapeHtml(pricing?.consultingTierName || 'Skipped')}</td></tr>
            </table>
            <p style="font-size: 12px; color: #6b6359; margin: 0 0 6px; letter-spacing: 0.06em; text-transform: uppercase;">One-time at signing</p>
            <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 16px;">
              ${breakdownTable}
              <tr><td style="padding: 8px 0 0; border-top: 1px solid #d4cdc0; font-weight: 600;">Total</td><td style="padding: 8px 0 0; text-align: right; border-top: 1px solid #d4cdc0; font-weight: 600;">${escapeHtml(moneyInt(oneTime))}</td></tr>
            </table>
            <p style="font-size: 12px; color: #6b6359; margin: 18px 0 6px; letter-spacing: 0.06em; text-transform: uppercase;">Monthly recurring</p>
            <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 20px;">
              <tr><td style="padding: 4px 0; color: #6b6359;">Web Management (${escapeHtml(pricing?.mgmtTierName || '?')}, ${draft.selections.site_setup === 'o2' ? '3' : '2'} sites)</td><td style="padding: 4px 0; text-align: right; color: #1a1814;">${escapeHtml(money(pricing?.mgmtMonthly || 0))}</td></tr>
              ${pricing && pricing.consultingMonthly > 0 ? `<tr><td style="padding: 4px 0; color: #6b6359;">Marketing Consulting (${escapeHtml(pricing.consultingTierName)})</td><td style="padding: 4px 0; text-align: right; color: #1a1814;">${escapeHtml(money(pricing.consultingMonthly))}</td></tr>` : ''}
              <tr><td style="padding: 8px 0 0; border-top: 1px solid #d4cdc0; font-weight: 600;">Total</td><td style="padding: 8px 0 0; text-align: right; border-top: 1px solid #d4cdc0; font-weight: 600;">${escapeHtml(money(monthly))}</td></tr>
            </table>
            ${signedAsRows}
            <p style="font-size: 12px; color: #a3a3a3; margin: 0;">Finalized ${escapeHtml(acceptedAt)}.</p>
          </div>
        `;
        const r1 = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: { 'api-key': brevoKey, 'content-type': 'application/json' },
          body: JSON.stringify({
            sender: { name: 'Cody A Smith Portal', email: 'cody@codyasmith.com' },
            to: [{ email: 'cody@codyasmith.com', name: 'Cody Smith' }],
            subject: stripCRLF(`${proposal.title} accepted`),
            htmlContent: codyHtml,
          }),
        });
        if (r1.ok) confirmationEmails.push('cody@codyasmith.com');
        else logger.error(`Brevo Cody notification failed: ${r1.status}`, await r1.text());
      } catch (err) {
        logger.error('Brevo Cody notification threw', err);
      }

      // Per-signer confirmations.
      for (const s of signersWithState) {
        try {
          const signerHtml = `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 22px; color: #1a1814; line-height: 1.55;">
              <h2 style="font-size: 22px; margin: 0 0 16px;">Engagement confirmed</h2>
              <p style="font-size: 15px; color: #4a4239; margin: 0 0 16px;">Both signatures are in. Here is what you both picked:</p>
              <table style="width: 100%; border-collapse: collapse; font-size: 14px; margin-bottom: 20px;">
                <tr><td style="padding: 6px 0; color: #6b6359;">Web Management</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">${escapeHtml(pricing?.mgmtTierName || '?')}</td></tr>
                <tr><td style="padding: 6px 0; color: #6b6359;">Site setup</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">${escapeHtml(pricing?.siteSetupShortLabel || '?')}</td></tr>
                <tr><td style="padding: 6px 0; color: #6b6359;">Marketing Consulting</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">${escapeHtml(pricing?.consultingTierName || 'Skipped')}</td></tr>
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
              to: [{ email: s.email }],
              subject: stripCRLF(`${proposal.title} confirmed`),
              htmlContent: signerHtml,
            }),
          });
          if (r2.ok) confirmationEmails.push(s.email);
          else logger.error(`Brevo confirmation to ${s.email} failed: ${r2.status}`, await r2.text());
        } catch (err) {
          logger.error(`Brevo confirmation to ${s.email} threw`, err);
        }
      }
    }

    await markFinalized(proposal.client_id, slug);
    status = 'finalized';
  } else if (body && body.signature !== undefined && !isRevoke && !allSigned) {
    // First-signer notification: ping the other signer(s) that someone just signed.
    status = 'waiting';
    const brevoKey = import.meta.env.BREVO_API_KEY;
    if (brevoKey) {
      const others = signersWithState.filter(s => s.id !== signer.id);
      const justSignedName = signer.name?.split(' ')[0] || signer.name || signer.id;
      const pricing = computePricing(proposal.config?.pricing_formula || '', draft.selections);
      const summaryRows = summaryRowsHtml(pricing, draft.selections);
      for (const other of others) {
        const otherFirst = other.name?.split(' ')[0] || other.name || other.id;
        try {
          await fetch('https://api.brevo.com/v3/smtp/email', {
            method: 'POST',
            headers: { 'api-key': brevoKey, 'content-type': 'application/json' },
            body: JSON.stringify({
              sender: { name: 'Cody Smith', email: 'cody@codyasmith.com' },
              to: [{ email: other.email, name: other.name }],
              subject: stripCRLF(`${justSignedName} signed the ${proposal.title}. Your turn.`),
              htmlContent: `
                <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 22px; color: #1a1814; line-height: 1.55;">
                  <h2 style="font-size: 22px; margin: 0 0 16px;">Hey ${escapeHtml(otherFirst)},</h2>
                  <p style="font-size: 15px; color: #4a4239; margin: 0 0 16px;">
                    ${escapeHtml(justSignedName)} just signed the ${escapeHtml(proposal.title)}. Here is what they picked:
                  </p>
                  <table style="width: 100%; border-collapse: collapse; font-size: 14px; margin: 0 0 20px;">${summaryRows}</table>
                  <p style="font-size: 15px; color: #4a4239; margin: 0 0 24px;">
                    Log in to the portal to review the selections, change anything you want, and countersign. Both confirmations send when you click countersign.
                  </p>
                  <a href="https://codyasmith.com/portal/proposals/${escapeHtml(slug)}" style="display: inline-block; background: #c47d5a; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">Log in and countersign</a>
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
  }

  // 'Selections changed' email to a partner who has already signed.
  // Skip in finalize/waiting/revoke flows; this fires only on a pure
  // selection edit by the current signer after the partner is in.
  const brevoKey = import.meta.env.BREVO_API_KEY;
  if (partnerToNotify && !isRevoke && status !== 'finalized' && (!body || body.signature === undefined) && brevoKey) {
    const changerFirst = signer.name?.split(' ')[0] || signer.name || signer.id;
    const partnerFirst = partnerToNotify.name?.split(' ')[0] || partnerToNotify.name || partnerToNotify.id;
    const pricing = computePricing(proposal.config?.pricing_formula || '', draft.selections);
    const summaryRows = summaryRowsHtml(pricing, draft.selections);
    try {
      await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': brevoKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          sender: { name: 'Cody Smith', email: 'cody@codyasmith.com' },
          to: [{ email: partnerToNotify.email, name: partnerToNotify.name }],
          subject: stripCRLF(`${changerFirst} changed selections on the ${proposal.title}`),
          htmlContent: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 22px; color: #1a1814; line-height: 1.55;">
              <h2 style="font-size: 22px; margin: 0 0 16px;">Hey ${escapeHtml(partnerFirst)},</h2>
              <p style="font-size: 15px; color: #4a4239; margin: 0 0 16px;">
                ${escapeHtml(changerFirst)} changed selections on the ${escapeHtml(proposal.title)} you already signed. Your signature stays in place by default. Here is the current state:
              </p>
              <table style="width: 100%; border-collapse: collapse; font-size: 14px; margin: 0 0 20px;">${summaryRows}</table>
              <p style="font-size: 15px; color: #4a4239; margin: 0 0 16px;">
                If you want to revoke your signature so you can re-review before agreeing, log in and click 'Revoke my signature' on the proposal page. Otherwise this stands and I will be in touch shortly with your contract details.
              </p>
              <a href="https://codyasmith.com/portal/proposals/${escapeHtml(slug)}" style="display: inline-block; background: #c47d5a; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">Review the proposal</a>
              <p style="font-size: 13px; color: #6b6359; margin: 24px 0 0; padding-top: 16px; border-top: 1px solid #e6ddd0;">Cody Smith, Cody A Smith LLC &middot; codyasmith.com</p>
            </div>
          `,
        }),
      });
    } catch (err) {
      logger.error('Brevo change-notification threw', err);
    }
  }

  // Revoke notification: ping any signer who is still on the hook so
  // they know their partner just walked back.
  if (isRevoke && brevoKey) {
    const revokerFirst = signer.name?.split(' ')[0] || signer.name || signer.id;
    // Look at the EXISTING draft (pre-revoke) to find partners that
    // were signed at the moment of revoke. Iterating draft.signatures
    // after the revoke would miss them.
    const stillSignedBeforeRevoke = (existingDraft ? describeSigners(proposal.config, existingDraft) : [])
      .filter(s => s.id !== signer.id && s.signed);
    for (const partner of stillSignedBeforeRevoke) {
      const partnerFirst = partner.name?.split(' ')[0] || partner.name || partner.id;
      try {
        await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: { 'api-key': brevoKey, 'content-type': 'application/json' },
          body: JSON.stringify({
            sender: { name: 'Cody Smith', email: 'cody@codyasmith.com' },
            to: [{ email: partner.email, name: partner.name }],
            subject: stripCRLF(`${revokerFirst} revoked their signature on the ${proposal.title}`),
            htmlContent: `
              <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 22px; color: #1a1814; line-height: 1.55;">
                <h2 style="font-size: 22px; margin: 0 0 16px;">Hey ${escapeHtml(partnerFirst)},</h2>
                <p style="font-size: 15px; color: #4a4239; margin: 0 0 16px;">
                  ${escapeHtml(revokerFirst)} revoked their signature on the ${escapeHtml(proposal.title)}. They likely want to re-review or change something. Your signature stays in place.
                </p>
                <p style="font-size: 15px; color: #4a4239; margin: 0 0 24px;">
                  Nothing to do right now. They will re-sign when they are ready; you will get the standard confirmation email when both signatures are back in place.
                </p>
                <p style="font-size: 13px; color: #6b6359; margin: 24px 0 0; padding-top: 16px; border-top: 1px solid #e6ddd0;">Cody Smith, Cody A Smith LLC &middot; codyasmith.com</p>
              </div>
            `,
          }),
        });
      } catch (err) {
        logger.error('Brevo revoke-notification threw', err);
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
