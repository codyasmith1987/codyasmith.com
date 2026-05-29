// Admin endpoint: create a proposal row from the wizard at
// /portal/admin/proposals/new.
//
// Two payload shapes are accepted:
//
// 1. Compose payload (new, preferred): {
//      client_id, status,
//      compose: { products, product_vars, narrative_variables, signers, overrides }
//    }
//    The endpoint calls composeProposal() from src/lib/products/index.ts to
//    build the full proposal config from canonical product definitions, then
//    persists it. Slug and title derive from the client and signer rows
//    (overrideable via compose.overrides).
//
// 2. Raw config payload (legacy): {
//      slug, client_id, title, config, status
//    }
//    The endpoint validates and stores the config verbatim. Used by older
//    callers and any direct API tooling that wants full control.
//
// Both paths share the same INSERT path and activity-log emission.

import type { APIRoute } from 'astro';
import { nanoid } from 'nanoid';
import turso from '../../../../../lib/turso';
import { logActivity } from '../../../../../lib/activity';
import { logger } from '../../../../../lib/logger';
import { composeProposal } from '../../../../../lib/products';
import { computeBuildTotal, routeBuildSize } from '../../../../../lib/products/build';
import { listManagedSites } from '../../../../../lib/client-sites';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function computeOptionBuildCost(sites: Array<{ page_count_estimate: number }>): number {
  if (sites.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < sites.length; i++) {
    const size = routeBuildSize({ build_total_pages: sites[i].page_count_estimate });
    const siteCost = computeBuildTotal(size, 1);
    total += i === 0 ? siteCost : siteCost * 0.80;
  }
  return Math.round(total * 100) / 100;
}

function normalizeBuildOptions(productVars: Record<string, any>): string | null {
  const buildVars = productVars['build'];
  if (!buildVars || !Array.isArray(buildVars.build_options)) return null;
  const baseSize = routeBuildSize(buildVars);
  const baseBuildCost = computeBuildTotal(baseSize, 1);
  for (const opt of buildVars.build_options) {
    if (!opt || typeof opt !== 'object') continue;
    delete opt.wm_monthly_delta;
    delete opt.wm_onboarding_delta;

    const optionName = typeof opt.name === 'string' && opt.name.trim()
      ? opt.name.trim()
      : 'A build option';

    const cleanedSites: Array<{ domain: string; label: string; page_count_estimate: number }> = [];
    const rawSites = Array.isArray(opt.wm_sites_added) ? opt.wm_sites_added : [];
    for (const site of rawSites) {
      const domain = typeof site?.domain === 'string' ? site.domain.trim().toLowerCase() : '';
      const label = typeof site?.label === 'string' ? site.label.trim() : '';
      const pages = typeof site?.page_count_estimate === 'number' && Number.isFinite(site.page_count_estimate)
        ? site.page_count_estimate
        : null;
      const hasAny = !!domain || !!label || pages !== null;
      if (!hasAny) continue;
      if (pages === null || pages < 1) {
        return `${optionName} has a new site without a page estimate.`;
      }
      cleanedSites.push({ domain, label, page_count_estimate: pages });
    }
    opt.wm_sites_added = cleanedSites;
    const optionBuildCost = cleanedSites.length > 0
      ? computeOptionBuildCost(cleanedSites)
      : baseBuildCost;
    opt.pricing_delta = Math.round((optionBuildCost - baseBuildCost) * 100) / 100;

    const cleanedMods: Array<{ site_domain: string; new_page_count: number; note?: string }> = [];
    const rawMods = Array.isArray(opt.wm_site_modifications) ? opt.wm_site_modifications : [];
    for (const mod of rawMods) {
      const siteDomain = typeof mod?.site_domain === 'string' ? mod.site_domain.trim().toLowerCase() : '';
      const pages = typeof mod?.new_page_count === 'number' && Number.isFinite(mod.new_page_count)
        ? mod.new_page_count
        : null;
      const note = typeof mod?.note === 'string' ? mod.note.trim() : '';
      const hasAny = !!siteDomain || pages !== null || !!note;
      if (!hasAny) continue;
      if (!siteDomain || pages === null || pages < 1) {
        return `${optionName} has an existing-site change without both site and new page count.`;
      }
      cleanedMods.push({ site_domain: siteDomain, new_page_count: pages, note });
    }
    opt.wm_site_modifications = cleanedMods;
  }
  return null;
}

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const client_id = (body?.client_id || '').toString().trim();
  const status = (body?.status || 'draft').toString().trim();

  if (!client_id) return json({ error: 'Client is required' }, 400);
  if (status !== 'draft' && status !== 'published') return json({ error: 'Status must be draft or published' }, 400);

  // Confirm the client exists, and pull the row for compose pre-fill.
  const clientCheck = await turso.execute({
    sql: 'SELECT id, name, slug, discount_rate FROM clients WHERE id = ?',
    args: [client_id],
  });
  if (clientCheck.rows.length === 0) return json({ error: 'Client not found' }, 404);
  const clientRow = clientCheck.rows[0] as any;
  const clientName = clientRow[1] as string;
  const clientSlug = clientRow[2] as string;
  const clientDiscount = typeof clientRow[3] === 'number' ? clientRow[3] : 0;

  // Decide which payload shape to use.
  let slug: string;
  let title: string;
  let config: any;

  if (body?.compose && typeof body.compose === 'object') {
    // Compose payload: build the config server-side.
    const c = body.compose;
    const products = Array.isArray(c.products) ? c.products : [];
    if (products.length === 0) {
      return json({ error: 'At least one product is required' }, 400);
    }
    const product_vars = (c.product_vars && typeof c.product_vars === 'object') ? c.product_vars : {};
    const buildOptionError = normalizeBuildOptions(product_vars);
    if (buildOptionError) return json({ error: buildOptionError }, 400);
    const narrative_variables = (c.narrative_variables && typeof c.narrative_variables === 'object') ? c.narrative_variables : {};
    const rawSigners = Array.isArray(c.signers) ? c.signers : [];
    if (rawSigners.length === 0) {
      return json({ error: 'At least one signer is required' }, 400);
    }
    const signers = rawSigners.map((s: any, i: number) => {
      const name = (s?.name || '').toString().trim();
      const email = (s?.email || '').toString().trim().toLowerCase();
      const localPart = email.split('@')[0] || '';
      const id = localPart.replace(/[^a-z0-9]+/g, '_').slice(0, 24) || `s${i + 1}`;
      return { id, name, email };
    });
    for (const s of signers) {
      if (!s.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.email)) {
        return json({ error: `Signer "${s.name || '(unnamed)'}" needs a valid email` }, 400);
      }
    }
    const overrides = (c.overrides && typeof c.overrides === 'object') ? c.overrides : {};
    // Reissue / already-onboarded: waive the one-time setup fees (WM
    // onboarding + MC initial audit). Admin checkbox in the wizard.
    const waive_onboarding = c.waive_onboarding === true;
    // Bundle mode: fuse WM + MC into one Good/Better/Best card. Admin
    // checkbox in the wizard.
    const bundle_mode = c.bundle_mode === true;

    // Voice-lint admin-typed strings before persist. Catches em or en
    // dashes, AI-template language, overclaim, drop-cap patterns,
    // dangling tier references, etc. Same rules the snippet matrix
    // editor enforces. Cross-cutting D from
    // docs/audits/proposal-chain-ui-ux-audit-2026-05-25.md.
    const { lintSnippet } = await import('../../../../../lib/proposal-ai/voice-lint');
    type Violation = { field: string; text: string; violations: Array<{ rule: string; matched: string }> };
    const voiceViolations: Violation[] = [];
    const lintField = (label: string, value: any) => {
      if (typeof value !== 'string') return;
      const trimmed = value.trim();
      if (!trimmed) return;
      const result = lintSnippet(trimmed);
      if (!result.ok) {
        voiceViolations.push({ field: label, text: trimmed.slice(0, 200), violations: result.violations });
      }
    };
    lintField('overrides.title', overrides.title);
    lintField('overrides.prepared_for', overrides.prepared_for);
    // narrative_variables.industry / urgency are picked from fixed
    // lists so they don't need lint. Custom strings (if any field is
    // free-text in narrative_variables) would lint here.
    if (voiceViolations.length > 0) {
      return json({
        error: 'Voice-lint violations. Fix and re-submit.',
        voice_violations: voiceViolations,
      }, 400);
    }
    // Engagement-strategy synthesis from the wizard's research panel
    // (subset of ClientResearchResult). Optional; absent on manual
    // composes that bypass the research step. Validated lightly here:
    // only sales_angles, clv_horizon, cody_time_intensity survive; any
    // unexpected fields are ignored. The downstream composer is also
    // defensive.
    let engagement_strategy: any = null;
    if (c.engagement_strategy && typeof c.engagement_strategy === 'object') {
      const es = c.engagement_strategy as Record<string, unknown>;
      // Per audit move 9: carry product_implication through so the
      // composer can thread each angle into the matching in-scope
      // product's section. Validate against the closed product set.
      const angleProductSet = new Set(['web_management', 'marketing_consulting', 'build', 'training', 'none']);
      const sales_angles = Array.isArray(es.sales_angles)
        ? es.sales_angles
            .filter((a: any) => a && typeof a === 'object' && typeof a.angle === 'string')
            .map((a: any) => ({
              angle: String(a.angle).trim(),
              supporting_evidence: typeof a.supporting_evidence === 'string'
                ? a.supporting_evidence.trim()
                : '',
              product_implication: angleProductSet.has(a.product_implication) ? a.product_implication : undefined,
            }))
            .filter((a: any) => a.angle.length > 0)
        : [];
      const clvSet = new Set(['long-term-stable', 'medium-term', 'churn-risk', 'unknown']);
      const intSet = new Set(['low', 'medium', 'high']);
      const tierSet = new Set(['good', 'better', 'best']);
      const synthProductSet = new Set(['web_management', 'marketing_consulting', 'build', 'training']);
      // Per-prospect tier recommendation: validate the shape, drop
      // unrecognized product ids and unrecognized tier values. Empty
      // object stays null so downstream falls back to product defaults.
      let recommended_tier_per_product: any = null;
      if (es.recommended_tier_per_product && typeof es.recommended_tier_per_product === 'object') {
        const cleaned: Record<string, any> = {};
        for (const [k, v] of Object.entries(es.recommended_tier_per_product as Record<string, any>)) {
          if (!synthProductSet.has(k)) continue;
          if (!v || typeof v !== 'object') continue;
          if (!tierSet.has(v.tier)) continue;
          cleaned[k] = {
            tier: v.tier,
            rationale: typeof v.rationale === 'string' ? v.rationale : undefined,
          };
        }
        if (Object.keys(cleaned).length > 0) recommended_tier_per_product = cleaned;
      }
      // internal_gaps: concrete things broken or under-served on the
      // prospect's current site. Validate shape, drop low-severity by
      // default (the section keeps focus on high/medium), require
      // gap text + valid severity, attach product_implication if
      // it's a known product id. Per audit move 1.
      const severitySet = new Set(['low', 'medium', 'high']);
      const gapProductSet = new Set([...synthProductSet, 'none']);
      const internal_gaps = Array.isArray(es.internal_gaps)
        ? es.internal_gaps
            .filter((g: any) => g && typeof g === 'object' && typeof g.gap === 'string' && g.gap.trim().length > 0)
            .filter((g: any) => severitySet.has(g.severity))
            .map((g: any) => ({
              gap: String(g.gap).trim(),
              evidence: typeof g.evidence === 'string' ? g.evidence.trim() : '',
              severity: g.severity,
              product_implication: gapProductSet.has(g.product_implication) ? g.product_implication : undefined,
            }))
        : [];
      // Per audit move 8: recommended_product_mix carries per-product
      // rationale + confidence from the AI synthesis. Validate shape,
      // drop unrecognized product ids, surface rationale to the
      // composer so it can render the "Why each piece" paragraphs.
      let recommended_product_mix: any = null;
      if (es.recommended_product_mix && typeof es.recommended_product_mix === 'object') {
        const confSet = new Set(['low', 'medium', 'high']);
        const cleaned: Record<string, any> = {};
        for (const [k, v] of Object.entries(es.recommended_product_mix as Record<string, any>)) {
          if (!synthProductSet.has(k)) continue;
          if (!v || typeof v !== 'object') continue;
          cleaned[k] = {
            recommended: !!v.recommended,
            rationale: typeof v.rationale === 'string' ? v.rationale.trim() : undefined,
            confidence: confSet.has(v.confidence) ? v.confidence : undefined,
          };
        }
        if (Object.keys(cleaned).length > 0) recommended_product_mix = cleaned;
      }
      engagement_strategy = {
        sales_angles,
        clv_horizon: typeof es.clv_horizon === 'string' && clvSet.has(es.clv_horizon) ? es.clv_horizon : null,
        cody_time_intensity: typeof es.cody_time_intensity === 'string' && intSet.has(es.cody_time_intensity) ? es.cody_time_intensity : null,
        recommended_tier_per_product,
        recommended_product_mix,
        internal_gaps,
      };
    }

    // Per-product tier overrides from the wizard (audit Finding 3 UI).
    // Admin can pin a tier different from the AI's recommendation;
    // composeProposal applies overrides on top of engagement_strategy.
    // Validate: only known product ids + known tier ids (good/better/best);
    // drop the rest silently.
    const wizardProductSet = new Set(['web-management', 'marketing-consulting', 'build', 'training', 'other-sow']);
    const tierIdSet = new Set(['good', 'better', 'best']);
    let tier_overrides: Record<string, string> | undefined;
    if (c.tier_overrides && typeof c.tier_overrides === 'object') {
      const cleaned: Record<string, string> = {};
      for (const [k, v] of Object.entries(c.tier_overrides as Record<string, any>)) {
        if (!wizardProductSet.has(k)) continue;
        if (typeof v !== 'string' || !tierIdSet.has(v)) continue;
        cleaned[k] = v;
      }
      if (Object.keys(cleaned).length > 0) tier_overrides = cleaned;
    }

    // Per audit move 3: join lead_personas by signer email so a
    // prospect who took the personalization quiz before becoming a
    // lead has their persona axes carried into the engagement
    // strategy. The composer (and snippet authors) can branch on
    // these to shape voice. First signer with a non-empty email
    // wins; absent persona = strategy gets no persona_axes field
    // and downstream code falls through silently.
    if (Array.isArray(signers) && signers.length > 0) {
      const firstEmail = signers
        .map(s => (typeof s?.email === 'string' ? s.email.trim().toLowerCase() : ''))
        .find(e => e && e.length > 0);
      if (firstEmail) {
        try {
          const personaRow = await turso.execute({
            sql: `SELECT email, name, sun_moon, beach_mountain, spring_fall, stars_clouds
                  FROM lead_personas WHERE email = ?`,
            args: [firstEmail],
          });
          if (personaRow.rows.length > 0) {
            const r = personaRow.rows[0];
            const personaAxes = {
              email: r[0] as string,
              name: (r[1] as string) || null,
              sun_moon: (r[2] as 'sun' | 'moon' | null) || null,
              beach_mountain: (r[3] as 'beach' | 'mountain' | null) || null,
              spring_fall: (r[4] as 'spring' | 'fall' | null) || null,
              stars_clouds: (r[5] as 'stars' | 'clouds' | null) || null,
            };
            if (engagement_strategy) {
              engagement_strategy.persona_axes = personaAxes;
            } else {
              engagement_strategy = {
                sales_angles: [],
                internal_gaps: [],
                persona_axes: personaAxes,
              };
            }
          }
        } catch (err) {
          logger.warn('Persona join failed; composing without persona axes', err);
        }
      }
    }

    // Pull managed sites with their per-site page counts so the
    // composer can route each site to its own ecosystem at the
    // engagement tier (2026-05-24 locked formula). The proposal-page
    // tier cards and Schedule A both use this data; without it the
    // composer falls back to single-ecosystem pricing.
    let managedSites: Array<{
      domain: string; label: string | null; is_primary: boolean;
      page_count: number | null;
      monthly_override: number | null;
      onboarding_override: number | null;
    }> = [];
    try {
      managedSites = (await listManagedSites(client_id)).map(s => ({
        domain: s.domain,
        label: s.label,
        is_primary: s.is_primary,
        page_count: s.page_count,
        monthly_override: s.monthly_override,
        onboarding_override: s.onboarding_override,
      }));
    } catch (err) {
      logger.warn('Failed to load managed sites for compose; proceeding with single-ecosystem fallback', err);
    }

    try {
      config = composeProposal({
        client: { id: client_id, name: clientName, slug: clientSlug, discount_rate: clientDiscount },
        signers,
        products,
        product_vars,
        narrative_variables,
        overrides,
        engagement_strategy,
        tier_overrides: tier_overrides as any,
        managedSites,
        waive_onboarding,
        bundle_mode,
      });
    } catch (err) {
      logger.error('composeProposal failed', err);
      return json({ error: 'Failed to compose proposal from product definitions' }, 500);
    }
    title = config.title;
    slug = overrides.slug && SLUG_RE.test(overrides.slug) ? overrides.slug : clientSlug;

    // Slug collision: if the client slug is already taken by another
    // proposal, append today's date so the admin gets a clean unique slug
    // without having to hand-edit.
    const existing = await turso.execute({
      sql: 'SELECT id FROM proposals WHERE slug = ?',
      args: [slug],
    });
    if (existing.rows.length > 0) {
      const datePart = new Date().toISOString().slice(0, 10);
      slug = `${slug}-${datePart}`;
      const reCheck = await turso.execute({
        sql: 'SELECT id FROM proposals WHERE slug = ?',
        args: [slug],
      });
      if (reCheck.rows.length > 0) {
        return json({ error: 'Slug collision; supply an explicit slug override' }, 409);
      }
    }
  } else {
    // Legacy raw-config payload.
    slug = (body?.slug || '').toString().trim();
    title = (body?.title || '').toString().trim();
    config = body?.config;
    if (!slug) return json({ error: 'Slug is required' }, 400);
    if (!SLUG_RE.test(slug)) return json({ error: 'Slug must be lowercase letters, numbers, and hyphens (no leading or trailing hyphen)' }, 400);
    if (!title) return json({ error: 'Title is required' }, 400);
    if (!config || typeof config !== 'object') return json({ error: 'Config is required' }, 400);
    const existing = await turso.execute({
      sql: 'SELECT id FROM proposals WHERE slug = ?',
      args: [slug],
    });
    if (existing.rows.length > 0) {
      return json({ error: 'A proposal with that slug already exists' }, 409);
    }
  }

  const id = nanoid();
  const configText = JSON.stringify(config);

  try {
    await turso.execute({
      sql: `INSERT INTO proposals (id, slug, client_id, title, config, status, created_by, published_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ${status === 'published' ? "datetime('now')" : 'NULL'})`,
      args: [id, slug, client_id, title, configText, status, locals.user!.id],
    });
  } catch (err: any) {
    if (err?.message?.includes('UNIQUE constraint')) {
      return json({ error: 'A proposal with that slug already exists' }, 409);
    }
    logger.error('Create proposal error', err);
    return json({ error: 'Failed to create proposal' }, 500);
  }

  // Client legal-entity metadata (legal_entity_name, entity_type,
  // principal_address, etc.) is NOT collected here. The proposal wizard
  // captures product picks and routing variables only. Clients supply
  // legal-entity details at contract intake after they accept the LOI.
  // See src/pages/portal/api/contracts/[slug]/intake.ts.

  await logActivity({
    clientId: client_id,
    userId: locals.user!.id,
    action: 'created',
    entityType: 'proposal',
    entityId: id,
    summary: `${locals.user!.name} created proposal "${title}" (${status})`,
  });

  return json({ ok: true, id, slug }, 201);
};
