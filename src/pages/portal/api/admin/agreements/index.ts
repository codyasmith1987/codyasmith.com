// GET  /portal/api/admin/agreements/   List all agreements with summary.
// POST /portal/api/admin/agreements/   Create a new agreement, optionally
//                                       pre-filling Schedule A from a finalized
//                                       proposal's selections + pricing.

import type { APIRoute } from 'astro';
import { nanoid } from 'nanoid';
import { logger } from '../../../../../lib/logger';
import { logActivity } from '../../../../../lib/activity';
import {
  createAgreement,
  addSigner,
  listAllAgreements,
} from '../../../../../lib/agreements';
import { getLatestContractTemplate } from '../../../../../lib/contract-templates';
import { buildScheduleA } from '../../../../../lib/contract-schedule';
import { listManagedSites } from '../../../../../lib/client-sites';
import { computePricing } from '../../../../../lib/proposal-pricing';
import { getDraft } from '../../../../../lib/proposal-drafts';
import turso from '../../../../../lib/turso';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export const GET: APIRoute = async ({ locals }) => {
  const user = locals.user;
  if (!user || user.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  const agreements = await listAllAgreements();
  // Enrich with client name + signer summary for the admin index list.
  const clientIds = Array.from(new Set(agreements.map(a => a.client_id)));
  const clientRows = clientIds.length > 0
    ? await turso.execute({
        sql: `SELECT id, name, slug FROM clients WHERE id IN (${clientIds.map(() => '?').join(',')})`,
        args: clientIds,
      })
    : { rows: [] as any[] };
  const clientById: Record<string, { name: string; slug: string }> = {};
  for (const row of clientRows.rows as any[]) {
    clientById[row[0]] = { name: row[1] as string, slug: row[2] as string };
  }

  return json({
    agreements: agreements.map(a => ({
      id: a.id,
      slug: a.slug,
      title: a.title,
      status: a.status,
      client_id: a.client_id,
      client_name: clientById[a.client_id]?.name || 'Unknown',
      client_slug: clientById[a.client_id]?.slug || '',
      proposal_id: a.proposal_id,
      template_slug: a.template_slug,
      template_version: a.template_version,
      created_at: a.created_at,
      issued_at: a.issued_at,
      finalized_at: a.finalized_at,
      cancelled_at: a.cancelled_at,
    })),
  });
};

export const POST: APIRoute = async ({ locals, request }) => {
  const user = locals.user;
  if (!user || user.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'Invalid body' }, 400); }

  const slug = String(body.slug || '').trim().toLowerCase();
  const title = String(body.title || '').trim();
  const clientId = String(body.client_id || '').trim();
  const proposalId = body.proposal_id ? String(body.proposal_id).trim() : null;
  const templateSlug = String(body.template_slug || 'standard').trim();
  const personalNote = body.personal_note ? String(body.personal_note).slice(0, 4000) : null;
  const signersInput: Array<{ role: string; name: string; email: string; user_id?: string }> = Array.isArray(body.signers) ? body.signers : [];

  if (!slug || !SLUG_RE.test(slug)) return json({ error: 'Invalid slug (lowercase letters, numbers, hyphens; not starting or ending with hyphen)' }, 400);
  if (!title) return json({ error: 'Title required' }, 400);
  if (!clientId) return json({ error: 'Client required' }, 400);
  if (signersInput.length === 0) return json({ error: 'At least one signer required' }, 400);

  // Resolve template (latest version of given slug).
  const template = await getLatestContractTemplate(templateSlug);
  if (!template) return json({ error: `Template "${templateSlug}" not found` }, 400);

  // Build Schedule A from the proposal, if one is referenced. Empty
  // template Schedule A otherwise; admin can patch later.
  let scheduleA: any = {
    effective_date: new Date().toISOString().slice(0, 10),
    designated_contacts: { client: { name: null, title: null, address: null, email: null, phone: null } },
    products_purchased: { web_management: false, marketing_consulting: false, build: false, other_sow: false },
    web_management: null,
    marketing_consulting: null,
    hours_and_rates: { included_hours: null, overage_buffer: 2, overage_rate: 100, rush_rate: 150, emergency_rate: 200 },
    day_one_access: { required_by: null, items: [] },
    pass_through_items: [],
    build_sow_ref: null,
    other_sow_ref: null,
  };

  if (proposalId) {
    const proposalRow = await turso.execute({
      sql: `SELECT id, slug, client_id, title, config FROM proposals WHERE id = ? LIMIT 1`,
      args: [proposalId],
    });
    const pr = proposalRow.rows[0];
    if (pr) {
      let config: any = {};
      try { config = JSON.parse(pr[4] as string); } catch { /* defensive */ }
      const proposalSlug = pr[1] as string;
      const proposalClientId = pr[2] as string;
      if (proposalClientId !== clientId) {
        return json({ error: 'Proposal client does not match requested client' }, 400);
      }
      const draft = await getDraft(proposalClientId, proposalSlug);
      const selections = draft?.selections || {};
      const pricing = computePricing(config?.pricing_formula || '', selections, config);
      const managedSites = (await listManagedSites(clientId)).map(s => ({
        domain: s.domain, label: s.label, is_primary: s.is_primary,
        page_count: s.page_count,
        monthly_override: s.monthly_override,
        onboarding_override: s.onboarding_override,
      }));
      scheduleA = buildScheduleA({
        proposalConfig: config,
        draftSelections: selections,
        pricing,
        clientMetadata: {},
        effectiveDate: new Date().toISOString().slice(0, 10),
        managedSites,
      });
    }
  }

  let agreement;
  try {
    agreement = await createAgreement({
      slug,
      client_id: clientId,
      proposal_id: proposalId,
      template_slug: template.slug,
      template_version: template.version,
      title,
      schedule_a: scheduleA,
      personal_note: personalNote,
      created_by: user.id,
    });
  } catch (err: any) {
    if (String(err?.message || '').includes('UNIQUE')) return json({ error: 'Slug already exists' }, 409);
    logger.error('agreement create failed', err);
    return json({ error: 'Failed to create agreement' }, 500);
  }

  for (const s of signersInput) {
    await addSigner({
      agreement_id: agreement.id,
      user_id: s.user_id || null,
      signer_role: String(s.role || 'client_primary').slice(0, 40),
      name_snapshot: String(s.name || '').slice(0, 200),
      email_snapshot: String(s.email || '').toLowerCase().slice(0, 200),
    });
  }

  try {
    await logActivity({
      clientId: clientId,
      userId: user.id,
      action: 'created',
      entityType: 'agreement',
      entityId: agreement.id,
      summary: `Admin created agreement ${agreement.title}${proposalId ? ` from proposal ${proposalId}` : ''}`,
    });
  } catch (err) {
    logger.error('agreement create activity log failed', err);
  }

  return json({ ok: true, agreement_id: agreement.id, slug: agreement.slug });
};
