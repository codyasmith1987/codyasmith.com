// POST /portal/api/contracts/[slug]/intake
//
// Upserts client_metadata for the agreement's client, rebuilds the
// agreement's schedule_a from the proposal's pricing + the new
// metadata, and (if any signer has already signed) sends them a
// Schedule-A-changed email with a revoke link.

import type { APIRoute } from 'astro';
import { logActivity } from '../../../../../lib/activity';
import { logger } from '../../../../../lib/logger';
import {
  getAgreementBySlug,
  upsertClientMetadata,
  updateAgreementScheduleA,
  updateAgreementTemplateVersion,
  getSignersForAgreement,
  getActiveSignatureForSigner,
} from '../../../../../lib/agreements';
import { getDraft } from '../../../../../lib/proposal-drafts';
import { getLatestContractTemplate } from '../../../../../lib/contract-templates';
import { buildScheduleA } from '../../../../../lib/contract-schedule';
import { listManagedSites } from '../../../../../lib/client-sites';
import { computePricing } from '../../../../../lib/proposal-pricing';
import { sendScheduleChangedEmail } from '../../../../../lib/contract-emails';
import turso from '../../../../../lib/turso';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const MAX_FIELD = 240;
const MAX_ADDRESS = 600;

function clean(s: any, max: number = MAX_FIELD): string | null {
  if (s === null || s === undefined) return null;
  const t = String(s).trim();
  if (!t) return null;
  return t.slice(0, max);
}

export const POST: APIRoute = async ({ locals, request, params }) => {
  const user = locals.user;
  if (!user) return json({ error: 'Not authenticated' }, 401);

  const slug = params.slug || '';
  if (!slug) return json({ error: 'Missing slug' }, 400);

  const agreement = await getAgreementBySlug(slug);
  if (!agreement) return json({ error: 'Not found' }, 404);
  if (user.role !== 'admin' && user.client_id !== agreement.client_id) {
    return json({ error: 'Forbidden' }, 403);
  }

  if (agreement.status === 'voided' || agreement.status === 'executed') {
    return json({ error: 'Cannot edit intake on a closed agreement' }, 409);
  }

  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'Invalid body' }, 400); }

  const metaPayload = {
    client_id: agreement.client_id,
    legal_entity_name: clean(body.legal_entity_name),
    entity_type: clean(body.entity_type),
    state_of_organization: clean(body.state_of_organization),
    ein: clean(body.ein),
    principal_address: clean(body.principal_address, MAX_ADDRESS),
    notice_address: clean(body.notice_address, MAX_ADDRESS),
    primary_contact_name: clean(body.primary_contact_name),
    primary_contact_title: clean(body.primary_contact_title),
    primary_contact_email: clean(body.primary_contact_email),
    primary_contact_phone: clean(body.primary_contact_phone),
  };

  const metadata = await upsertClientMetadata(metaPayload);

  // Rebuild Schedule A so any tier-dependent or contact-dependent
  // fields reflect the new metadata.
  let scheduleARebuilt = false;
  if (agreement.proposal_id) {
    const proposalRow = await turso.execute({
      sql: `SELECT id, slug, client_id, title, config FROM proposals WHERE id = ? LIMIT 1`,
      args: [agreement.proposal_id],
    });
    const pr = proposalRow.rows[0];
    if (pr) {
      let config: any = {};
      try { config = JSON.parse(pr[4] as string); } catch { /* defensive */ }
      const draft = await getDraft(agreement.client_id, pr[1] as string);
      const selections = draft?.selections || {};
      const pricing = computePricing(config?.pricing_formula || '', selections, config);
      const managedSites = (await listManagedSites(agreement.client_id)).map(s => ({
        domain: s.domain, label: s.label, is_primary: s.is_primary,
        page_count: s.page_count,
        monthly_override: s.monthly_override,
        onboarding_override: s.onboarding_override,
      }));
      const newScheduleA = buildScheduleA({
        proposalConfig: config,
        draftSelections: selections,
        pricing,
        clientMetadata: metadata,
        effectiveDate: agreement.schedule_a?.effective_date || new Date().toISOString().slice(0, 10),
        managedSites,
        billingAnchorDay: agreement.billing_anchor_day,
      });
      await updateAgreementScheduleA(agreement.id, newScheduleA);
      scheduleARebuilt = true;

      // Keep the template body in sync with the freshly rebuilt Schedule A.
      // template_version is pinned at agreement creation, so an agreement
      // drafted before a template bump (e.g. v3 -> v4, build 50/50 ->
      // 100% at signing) would render an old body against a new Schedule A.
      // Since intake already rebuilds the schedule and invalidates
      // signatures, bump to the latest version of the same template here so
      // the two stay a matched set. Guarded to non-executed agreements.
      const latestTemplate = await getLatestContractTemplate(agreement.template_slug);
      if (latestTemplate && latestTemplate.version > agreement.template_version) {
        await updateAgreementTemplateVersion(agreement.id, latestTemplate.version);
      }
    }
  }

  // Notify any currently-signed signer that the underlying data changed,
  // so they can re-review and re-sign or revoke their signature.
  const signers = await getSignersForAgreement(agreement.id);
  const baseUrl = (import.meta.env.PUBLIC_BASE_URL || 'https://codyasmith.com').replace(/\/$/, '');
  const agreementUrl = `${baseUrl}/portal/contracts/${agreement.slug}`;
  for (const signer of signers) {
    const active = await getActiveSignatureForSigner(agreement.id, signer.id);
    if (active) {
      try {
        await sendScheduleChangedEmail({
          recipient: signer,
          agreement,
          agreementUrl,
          changeSummary: 'Client intake fields were updated. Your signature is paused until you confirm the updated Schedule A.',
        });
      } catch (err) {
        logger.error('schedule-changed email failed', err);
      }
    }
  }

  try {
    await logActivity({
      clientId: agreement.client_id,
      userId: user.id,
      action: 'intake_submitted',
      entityType: 'agreement',
      entityId: agreement.id,
      summary: `Intake updated for ${agreement.title}`,
    });
  } catch (err) {
    logger.error('intake activity log failed', err);
  }

  return json({ ok: true, schedule_a_rebuilt: scheduleARebuilt, client_metadata: metadata });
};
