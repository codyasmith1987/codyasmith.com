// Product registry and proposal composer.
//
// The wizard at /portal/admin/proposals/new calls composeProposal()
// with: which client, which products are in scope, per-product
// variables, narrative variables, and any overrides. The composer
// produces a complete ProposalConfig the wizard POSTs to the create
// endpoint. The downstream (renderer, accept, contract Schedule A)
// reads the same shape it has read for the live Raised Bar proposal.

import { webManagementProduct, extractTakeoverSites, deriveEcosystemCeilings } from './web-management';
import { marketingConsultingProduct } from './marketing-consulting';
import { buildProduct } from './build';
import { trainingProduct } from './training';
import { otherSowProduct } from './other-sow';
import { lookupSnippetOverrideWithKey } from './narrative-snippets';
import type {
  ProductDefinition,
  ProductId,
  ProductContext,
  ProductVariables,
  ProposalConfig,
  ComposeArgs,
  NarrativeSection,
  ProposalStep,
  ProposalStepOption,
  BundleConfig,
  TierId,
  NarrativeSnippetSet,
  NarrativePhase,
  EngagementStrategy,
  EngagementStrategySynthProductId,
} from './types';

// =========================================================================
// Registry
// =========================================================================

export const PRODUCT_REGISTRY: Record<ProductId, ProductDefinition> = {
  'web-management': webManagementProduct,
  'marketing-consulting': marketingConsultingProduct,
  'build': buildProduct,
  'training': trainingProduct,
  'other-sow': otherSowProduct,
};

// Order matters: the composed proposal lists products in this order in
// narrative and on the page. Matches the priority Cody sells.
export const PRODUCT_ORDER: ProductId[] = [
  'web-management',
  'marketing-consulting',
  'build',
  'training',
  'other-sow',
];

export function getProduct(id: ProductId): ProductDefinition | null {
  return PRODUCT_REGISTRY[id] || null;
}

export function listProducts(): ProductDefinition[] {
  return PRODUCT_ORDER.map(id => PRODUCT_REGISTRY[id]).filter(Boolean);
}

// =========================================================================
// composeProposal: wizard -> ProposalConfig
// =========================================================================

// Whole dollars when whole, cents when not (multi-site / discounted).
function bundleMoney(n: number): string {
  const hasCents = Math.round(n * 100) % 100 !== 0;
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: hasCents ? 2 : 0, maximumFractionDigits: hasCents ? 2 : 0 });
}

// Build the bundle config from wizard args when bundle mode is on. The GBB
// mapping is symmetric (good->WM good + MC good, etc.) per the Raised Bar
// shape. If a build with 2+ build_options is in scope, the first option is
// the baseline (skip) and the second is the optional add-on (add).
function buildBundleConfig(args: ComposeArgs): BundleConfig {
  const tiers: BundleConfig['tiers'] = {
    good: { wm: 'good', mc: 'good' },
    better: { wm: 'better', mc: 'better' },
    best: { wm: 'best', mc: 'best' },
  };
  const buildVars: any = args.product_vars?.['build'];
  const opts: any[] = buildVars && Array.isArray(buildVars.build_options) ? buildVars.build_options : [];
  if (opts.length >= 2 && opts[0]?.id && opts[1]?.id) {
    return { tiers, addon: { skip_option_id: opts[0].id, build_option_id: opts[1].id, label: opts[1].name || 'Optional add-on' } };
  }
  return { tiers };
}

// Generate the single fused Good/Better/Best card (+ optional add-on step)
// for a bundle. Each card's monthly + to-start come straight from the
// registry (composePricing on the expanded selections) so they can never
// drift from the contract; the feature lists are pulled from the canonical
// WM + MC tier cards (so waiver-awareness etc. carries through). Buyer-facing
// copy here is drafted for Cody to tweak.
function generateBundleSteps(bundle: BundleConfig, contexts: Record<ProductId, ProductContext>, pricingConfig: any): ProposalStep[] {
  const wmStep = PRODUCT_REGISTRY['web-management'].generateSteps(contexts['web-management']).find(s => s.id === 'wm_tier');
  const mcStep = PRODUCT_REGISTRY['marketing-consulting'].generateSteps(contexts['marketing-consulting']).find(s => s.id === 'mc_tier');
  const levels: Array<'good' | 'better' | 'best'> = ['good', 'better', 'best'];

  const options: ProposalStepOption[] = levels.map(level => {
    const map = bundle.tiers[level];
    const expanded = expandBundleSelections(pricingConfig, { bundle_tier: level, bundle_addon: bundle.addon ? 'skip' : null });
    const pricing = composePricing({ config: pricingConfig, selections: expanded });
    const wmOpt = wmStep?.options.find(o => o.id === map.wm);
    const mcOpt = mcStep?.options.find(o => o.id === map.mc);
    const features = [...(wmOpt?.features || []), ...(mcOpt?.features || [])];
    return {
      id: level,
      name: level.charAt(0).toUpperCase() + level.slice(1),
      tagline: wmOpt?.tagline,
      recommended: level === 'better',
      price_label: pricing ? bundleMoney(pricing.monthly) : undefined,
      price_suffix: '/ month',
      price_subline: pricing ? `${bundleMoney(pricing.oneTime)} to start` : undefined,
      included_hours: wmOpt?.included_hours,
      features,
    };
  });

  const steps: ProposalStep[] = [{
    id: 'bundle_tier',
    type: 'tier_picker',
    h2: 'Pick your engagement level',
    prompt: 'Each level sets both your web management and your marketing consulting in one number. Better is the recommendation.',
    options,
  }];

  if (bundle.addon) {
    steps.push({
      id: 'bundle_addon',
      type: 'binary_picker',
      h2: bundle.addon.label,
      prompt: 'An optional add-on, on top of the level you pick above.',
      options: [
        { id: 'skip', name: 'Not now', html: 'Keep the unified setup. You can add this later without re-papering.' },
        { id: 'add', name: `Add ${bundle.addon.label}`, html: 'Splits this into its own dedicated site with its own build. Adds to your to-start and your monthly while it runs.' },
      ],
    });
  }
  return steps;
}

// For Web Management on a PROSPECT, the page count that routes the primary
// ecosystem usually lives in the build options (wm_sites_added), not in WM's
// own product_vars. Without it, routeEcosystem returns null and computePricing
// zeroes the monthly. Derive the primary site's page count from the first
// build option that carries one. Per-site routing at pricing time still routes
// each site by its own count; this just sets the base ecosystem so pricing runs.
function synthesizeWmPageCount(
  id: ProductId,
  variables: Record<string, any>,
  allProductVars: Record<string, any> | undefined,
): Record<string, any> {
  if (id !== 'web-management' || variables.page_count != null) return variables;
  const buildVars: any = allProductVars?.['build'];
  // Prefer the base build's total page count: that's the primary site's size.
  const totalRaw = buildVars?.build_total_pages;
  const total = typeof totalRaw === 'number' ? totalRaw
    : (typeof totalRaw === 'string' ? parseInt(totalRaw, 10) : NaN);
  if (Number.isFinite(total) && total > 0) return { ...variables, page_count: total };
  // Fall back to the first build option that carries a primary added site.
  const opts: any[] = buildVars && Array.isArray(buildVars.build_options) ? buildVars.build_options : [];
  for (const opt of opts) {
    const added: any[] = Array.isArray(opt?.wm_sites_added) ? opt.wm_sites_added : [];
    const primary = added.find((s: any) => typeof s?.page_count_estimate === 'number' && s.page_count_estimate > 0);
    if (primary) return { ...variables, page_count: primary.page_count_estimate };
  }
  // Last resort: a proposed takeover site's real page count (pure-takeover
  // proposals with no build product still need an ecosystem to route).
  const takeovers: any[] = Array.isArray(allProductVars?.['web-management']?.takeover_sites)
    ? allProductVars!['web-management'].takeover_sites : [];
  // Prefer the admin-marked primary takeover so the tier-card ecosystem
  // (derived from this page_count) matches what buildPerSiteBases /
  // buildScheduleAContribution use as the pricing primary (they sort by
  // is_primary). Falling back to first-with-a-count only when none is marked.
  const takeoverPrimary = takeovers.find((s: any) => s?.is_primary === true && typeof s?.page_count === 'number' && s.page_count > 0)
    ?? takeovers.find((s: any) => typeof s?.page_count === 'number' && s.page_count > 0);
  if (takeoverPrimary) return { ...variables, page_count: takeoverPrimary.page_count };
  return variables;
}

export function composeProposal(args: ComposeArgs): ProposalConfig {
  // Order products by PRODUCT_ORDER so the composed output is stable.
  const orderedProducts = PRODUCT_ORDER.filter(id => args.products.includes(id));

  // Build a ProductContext for each in-scope product. tierId is null
  // at compose time (the prospect picks tiers on the proposal page).
  // otherProducts is each product's view of the rest of the mix; used
  // for narrative composition.
  //
  // Variables are augmented with client_name, industry, and urgency
  // pulled from compose-level fields so the snippet registry helpers
  // can read them off the context without a wider type change. Each
  // value is only added when not already present (real per-product
  // variables win).
  // Apply admin tier overrides on top of the AI's recommended_tier_per_product.
  // Audit Finding 3 UI piece — admin's explicit pick beats AI rec. We mutate
  // a copy of engagementStrategy so downstream code reads the effective tier
  // from a single source (recommended_tier_per_product) without needing a
  // separate override-aware code path. PR #101 already wired the static
  // composer to honor recommended_tier_per_product; this just changes what's
  // in that field when admin overrode.
  const WIZARD_TO_SYNTH_TIER_KEY: Partial<Record<ProductId, EngagementStrategySynthProductId>> = {
    'web-management': 'web_management',
    'marketing-consulting': 'marketing_consulting',
    'build': 'build',
    'training': 'training',
  };
  let engagementStrategy = args.engagement_strategy || null;
  if (args.tier_overrides && Object.keys(args.tier_overrides).length > 0) {
    const merged = engagementStrategy ? { ...engagementStrategy } : {
      sales_angles: [],
      internal_gaps: [],
      risk_signals: [],
    } as EngagementStrategy;
    const existingTiers = (engagementStrategy?.recommended_tier_per_product) || {};
    const nextTiers = { ...existingTiers };
    for (const [productId, tier] of Object.entries(args.tier_overrides)) {
      if (!tier) continue;
      const synthKey = WIZARD_TO_SYNTH_TIER_KEY[productId as ProductId];
      if (!synthKey) continue;
      nextTiers[synthKey] = {
        tier,
        rationale: 'Admin override (set in wizard, beats AI recommendation)',
      };
    }
    merged.recommended_tier_per_product = nextTiers;
    engagementStrategy = merged;
  }
  const narrativeVariables = args.narrative_variables || {};
  const composeLevelVars: Record<string, string | number | boolean | null> = {
    client_name: args.client.name,
  };
  if (narrativeVariables.industry) composeLevelVars.industry = narrativeVariables.industry;
  if (narrativeVariables.urgency) composeLevelVars.urgency = narrativeVariables.urgency;

  const contexts: Record<ProductId, ProductContext> = {} as any;
  for (const id of orderedProducts) {
    const product = PRODUCT_REGISTRY[id];
    const variables = synthesizeWmPageCount(id, { ...composeLevelVars, ...(args.product_vars[id] || {}) }, args.product_vars);
    const ecosystemId = product.routeEcosystem(variables);
    const otherProducts = orderedProducts
      .filter(other => other !== id)
      .map(other => ({ id: other, tierId: null as TierId | null }));
    contexts[id] = {
      ecosystemId,
      tierId: null,
      variables,
      otherProducts,
      engagementStrategy,
      managedSites: args.managedSites,
      // Reissue waiver: products read this to keep step copy (tier-card
      // features) and narrative consistent with the $0 setup pricing.
      waiveOnboarding: args.waive_onboarding === true,
    };
  }

  // Bundle mode: fuse WM + MC into one Good/Better/Best card. Only when
  // both are in scope. Builds a symmetric bundle config + the per-tier
  // card prices straight from the registry.
  const discountRate = typeof args.client.discount_rate === 'number'
    ? Math.max(0, Math.min(1, args.client.discount_rate))
    : 0;
  const bundleMode = args.bundle_mode === true
    && orderedProducts.includes('web-management')
    && orderedProducts.includes('marketing-consulting');
  const bundleConfig = bundleMode ? buildBundleConfig(args) : undefined;
  const pricingConfig = {
    products: orderedProducts,
    product_vars: args.product_vars,
    managed_sites: args.managedSites,
    discount_rate: discountRate,
    waive_onboarding: args.waive_onboarding === true,
    bundle: bundleConfig,
  };

  // Steps. In bundle mode the single GBB card (+ optional add-on) replaces
  // the separate WM / MC / build pickers; other products keep their steps.
  const composedSteps: ProposalStep[] = [];
  if (bundleMode && bundleConfig) {
    composedSteps.push(...generateBundleSteps(bundleConfig, contexts, pricingConfig));
    for (const id of orderedProducts) {
      if (id === 'web-management' || id === 'marketing-consulting' || id === 'build') continue;
      composedSteps.push(...PRODUCT_REGISTRY[id].generateSteps(contexts[id]));
    }
  } else {
    for (const id of orderedProducts) {
      composedSteps.push(...PRODUCT_REGISTRY[id].generateSteps(contexts[id]));
    }
  }

  // Narrative: merge per-product NarrativeSnippetSets into the
  // ProposalConfig.narrative shape. The strategy drives the opener
  // (The Situation) and informs per-product paragraphs through
  // ctx.engagementStrategy.
  const narrative = composeNarrative({
    orderedProducts,
    contexts,
    clientName: args.client.name,
    clientId: args.client.id,
    narrativeVariables: args.narrative_variables || {},
    engagementStrategy,
    waiveOnboarding: args.waive_onboarding === true,
  });

  // Signers
  const signers = args.signers.map(s => ({ id: s.id, email: s.email, name: s.name }));

  // Title and slug auto-derivation (overrideable below).
  const signerFirstNames = signers.map(s => s.name.split(' ')[0]).filter(Boolean);
  const preparedForDefault = signerFirstNames.length > 0
    ? joinNames(signerFirstNames)
    : args.client.name;
  const titleDefault = signerFirstNames.length > 0
    ? `Engagement Proposal for ${joinNames(signerFirstNames)}`
    : `Engagement Proposal for ${args.client.name}`;
  const preparedOnDefault = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  // Apply overrides at the field level. Override wins.
  const overrides = args.overrides || {};
  const title = overrides.title || titleDefault;
  const prepared_for = overrides.prepared_for || preparedForDefault;
  const prepared_on = overrides.prepared_on || preparedOnDefault;
  const intro = overrides.intro || narrative.intro;
  const sections = overrides.sections || narrative.sections;
  let rollout = overrides.rollout || narrative.rollout;
  // In bundle mode the build's own option picker is replaced by the bundle
  // add-on step (id 'bundle_addon', options 'skip'/'add'). The build narrative
  // keyed its rollout scenarios to the build_options step ids (o1/o2); remap
  // them to the add-on step so the "how it rolls out" phases actually render
  // (otherwise the scenario_step never matches a real step and the rollout,
  // i.e. the build/options section, silently disappears).
  if (
    bundleMode && bundleConfig?.addon
    && rollout && (rollout as any).scenario_step === 'build_options'
    && (rollout as any).scenarios
  ) {
    const addon = bundleConfig.addon;
    const srcScenarios = (rollout as any).scenarios as Record<string, any>;
    const remapped: Record<string, any> = {};
    if (srcScenarios[addon.skip_option_id]) remapped['skip'] = srcScenarios[addon.skip_option_id];
    if (srcScenarios[addon.build_option_id]) remapped['add'] = srcScenarios[addon.build_option_id];
    rollout = { ...(rollout as any), scenario_step: 'bundle_addon', scenarios: remapped };
  }
  const steps = overrides.steps || composedSteps;

  // Domains the proposal proposes to TAKE OVER (existing unmanaged sites).
  // Carried on the config so the contract-finalize flow can flip these to
  // is_managed=1 when the engagement goes live.
  const takeoverDomains: string[] = Array.isArray((args.product_vars['web-management'] as any)?.takeover_sites)
    ? (args.product_vars['web-management'] as any).takeover_sites
        .map((s: any) => (typeof s?.domain === 'string' ? s.domain.trim().toLowerCase() : ''))
        .filter((d: string) => d.length > 0)
    : [];

  // Ecosystem page-ceiling disclosure (proposal notice). Derived from every
  // site the engagement could manage -- existing managed sites, proposed
  // takeovers, and every build option's added sites -- so the notice discloses
  // each ecosystem the engagement touches even when managed_sites is empty
  // (pure-takeover/prospect proposals). "Pages" = real navigable count
  // (takeover crawl count; build estimate). Emitted only when WM is in scope.
  const disclosureSites: Array<{ domain: string; label?: string | null; page_count?: number | null }> = [];
  if (Array.isArray(args.managedSites)) {
    for (const s of args.managedSites) disclosureSites.push({ domain: s.domain, label: s.label, page_count: s.page_count });
  }
  for (const t of extractTakeoverSites(args.product_vars)) {
    disclosureSites.push({ domain: t.domain, label: t.label, page_count: t.page_count });
  }
  const disclosureBuildOpts = (args.product_vars['build'] as any)?.build_options;
  if (Array.isArray(disclosureBuildOpts)) {
    for (const o of disclosureBuildOpts) {
      const added = Array.isArray(o?.wm_sites_added) ? o.wm_sites_added : [];
      for (const s of added) {
        const dom = typeof s?.domain === 'string' ? s.domain.trim().toLowerCase() : '';
        const pc = typeof s?.page_count_estimate === 'number' ? s.page_count_estimate : null;
        if (dom || pc != null) disclosureSites.push({ domain: dom, label: s?.label ?? null, page_count: pc });
      }
    }
  }
  const seenDisclosureDomains = new Set<string>();
  const dedupedDisclosureSites = disclosureSites.filter(s => {
    const d = (s.domain || '').trim().toLowerCase();
    if (d && seenDisclosureDomains.has(d)) return false;
    if (d) seenDisclosureDomains.add(d);
    return true;
  });
  const ecosystemCeilings = orderedProducts.includes('web-management')
    ? deriveEcosystemCeilings(dedupedDisclosureSites)
    : [];

  return {
    version: 1,
    prepared_for,
    prepared_on,
    title,
    takeover_site_domains: takeoverDomains.length > 0 ? takeoverDomains : undefined,
    ecosystem_ceilings: ecosystemCeilings.length > 0 ? ecosystemCeilings : undefined,
    discount_rate: typeof args.client.discount_rate === 'number'
      ? Math.max(0, Math.min(1, args.client.discount_rate))
      : 0,
    // Reissue / already-onboarded waiver, set by the admin in the wizard.
    waive_onboarding: args.waive_onboarding === true ? true : undefined,
    // Bundle config (symmetric GBB + optional add-on) when bundle mode is on.
    bundle: bundleConfig,
    narrative: {
      intro,
      sections,
      rollout,
    },
    steps,
    signers,
    pricing_formula: args.pricing_formula || 'product_driven_v1',
    products: orderedProducts,
    product_vars: args.product_vars,
    narrative_variables: args.narrative_variables,
    overrides,
    // Persist the engagement strategy alongside the composed config so
    // downstream consumers (proposal page renderer, future
    // persona-aware variants, admin re-render, analytics) can read
    // the structured per-prospect signals that drove this proposal:
    // sales_angles, internal_gaps, recommended_tier_per_product,
    // persona_axes (from move 3 lead_personas join), and the like.
    // Per audit move 3.
    engagement_strategy: engagementStrategy || undefined,
    // Per ClickUp 86ba3ww35 fix: snapshot managedSites at compose time
    // so composePricing (proposal-page price path) routes each site to
    // its own ecosystem the same way Schedule A does. Without this,
    // multi-site WM totals diverged between proposal page and contract.
    managed_sites: args.managedSites && args.managedSites.length > 0 ? args.managedSites : undefined,
  };
}

// =========================================================================
// Narrative composition helpers
// =========================================================================

interface ComposeNarrativeArgs {
  orderedProducts: ProductId[];
  contexts: Record<ProductId, ProductContext>;
  clientName: string;
  // Per audit move 7: snippet lookup uses this to prefer
  // client-scoped overrides over global ones at the same key.
  clientId?: string;
  narrativeVariables: { industry?: string; urgency?: string; focus?: string[] };
  engagementStrategy?: EngagementStrategy | null;
  // Reissue / already-onboarded waiver: when true, the "how it works"
  // closer drops the month-one onboarding/audit framing (already done on
  // the prior engagement) so the narrative does not contradict the $0
  // setup pricing.
  waiveOnboarding?: boolean;
}

function composeNarrative(args: ComposeNarrativeArgs): {
  intro: string;
  sections: NarrativeSection[];
  rollout?: ProposalConfig['narrative']['rollout'];
} {
  // Gather each product's inline default contribution. These get
  // concatenated for any bucket the registry-level snippet does not
  // override.
  const inlineContributions: Array<{ id: ProductId; set: NarrativeSnippetSet }> = [];
  for (const id of args.orderedProducts) {
    const product = PRODUCT_REGISTRY[id];
    const ctx = args.contexts[id];
    inlineContributions.push({ id, set: product.generateNarrativeSnippets(ctx) });
  }

  // Look up a combo-level snippet from the registry. The lookup key
  // is `${product_combo}::${ecosystem}::${urgency}` where ecosystem
  // is WM's when WM is in scope, else the first product's. The
  // helper tries six candidate keys most-specific to least-specific.
  let contributions: Array<{ id: ProductId; set: NarrativeSnippetSet }> = inlineContributions;
  if (args.orderedProducts.length > 0) {
    const primary = args.orderedProducts[0];
    const others = args.orderedProducts.slice(1);
    let lookupEco: string | null = null;
    if (args.orderedProducts.includes('web-management')) {
      lookupEco = args.contexts['web-management'].ecosystemId;
    } else {
      lookupEco = args.contexts[primary].ecosystemId;
    }
    // Per audit move 4: thread the wizard's first focus tag into the
    // snippet key so focus-specific variants can fire when authored.
    // Empty focus = falls through to 3-segment keys (existing snippets).
    const focusPrimary = (args.narrativeVariables.focus && Array.isArray(args.narrativeVariables.focus) && args.narrativeVariables.focus.length > 0)
      ? args.narrativeVariables.focus[0] || null
      : null;
    // Per audit move 7: thread the client id so client-scoped
    // overrides can win over global overrides at the same key.
    const overrideMatch = lookupSnippetOverrideWithKey({
      productId: primary,
      otherProductIds: others,
      ecosystemId: lookupEco,
      urgency: args.narrativeVariables.urgency || null,
      focusPrimary,
      clientId: args.clientId || null,
    });
    if (overrideMatch) {
      // The snippet runs with the primary product's context (the
      // helpers in narrative-snippets.ts read client_name, page_count,
      // industry, urgency from variables that the composer threaded
      // through). Each bucket present in the snippet REPLACES the content
      // for the products the snippet SPEAKS FOR (the matched key's product
      // segment). Products NOT covered by the snippet always keep their
      // inline contributions appended, so a single-product snippet matched
      // in a multi-product proposal can never drop the other products'
      // sections (the bug that made build + consulting copy vanish from a
      // WM+MC+Build bundle once WM routed to an ecosystem with no combo
      // snippet).
      const snippetSet = overrideMatch.snippet(args.contexts[primary]);
      const coveredIds = new Set(overrideMatch.key.split('::')[0].split('+'));
      const coveredInline = inlineContributions.filter(c => coveredIds.has(c.id));
      const uncoveredInline = inlineContributions.filter(c => !coveredIds.has(c.id));
      const bucket = (snippetVal: string[] | undefined, name: 'intro_lines' | 'what_i_see_paragraphs' | 'what_i_recommend_paragraphs' | 'rollout_phases'): any[] => {
        const head = snippetVal !== undefined ? snippetVal : coveredInline.flatMap(c => (c.set as any)[name] || []);
        const tail = uncoveredInline.flatMap(c => (c.set as any)[name] || []);
        return [...head, ...tail];
      };
      const merged: NarrativeSnippetSet = {
        intro_lines: bucket(snippetSet.intro_lines, 'intro_lines'),
        what_i_see_paragraphs: bucket(snippetSet.what_i_see_paragraphs, 'what_i_see_paragraphs'),
        what_i_recommend_paragraphs: bucket(snippetSet.what_i_recommend_paragraphs, 'what_i_recommend_paragraphs'),
        rollout_phases: bucket(snippetSet.rollout_phases, 'rollout_phases'),
        rollout_scenarios: snippetSet.rollout_scenarios
          || inlineContributions.find(c => c.set.rollout_scenarios)?.set.rollout_scenarios,
        rollout_scenario_step: snippetSet.rollout_scenario_step
          || inlineContributions.find(c => c.set.rollout_scenario_step)?.set.rollout_scenario_step,
        // closer_tie_back: snippet wins if it set one; falls back to
        // the first non-empty inline tie-back otherwise. Per audit
        // move 2, the field needed to be in this merge object —
        // without it, snippet-authored tie-backs were silently dropped.
        closer_tie_back: snippetSet.closer_tie_back !== undefined
          ? snippetSet.closer_tie_back
          : inlineContributions.map(c => c.set.closer_tie_back).find(p => typeof p === 'string' && p.trim().length > 0),
      };
      contributions = [{ id: primary, set: merged }];
    }
  }

  // Master intro: one composed paragraph from each product's
  // intro_lines, plus a top opener.
  const productNames = args.orderedProducts.map(id => PRODUCT_REGISTRY[id].short_name);
  const intro = composeIntro({
    productNames,
    productIntroLines: contributions.flatMap(c => c.set.intro_lines || []),
    urgency: args.narrativeVariables.urgency,
  });

  // Opener: "The Situation" from the synthesis sales_angles. Names the
  // client's perceived problem in their language. Pattern lifted from
  // the ZipKit proposal's working opener. Omitted when no angles are
  // present (legacy or non-AI-driven composes).
  const openerParagraphs = composeSituationOpener({
    clientName: args.clientName,
    engagementStrategy: args.engagementStrategy,
  });

  // "What I see in your business" h2 with paragraphs.
  const seeParagraphs = contributions.flatMap(c => c.set.what_i_see_paragraphs || []);
  // "Where the work is" h2 from synthesis internal_gaps. The buyer's
  // own problems framed in Cody's voice, surfaced between his
  // observation of their business and his recommended engagement.
  // Per audit move 1: internal_gaps was being dropped at create.ts
  // and never reached the buyer; this surfaces it.
  const workParagraphs = composeWhereTheWorkIs({
    engagementStrategy: args.engagementStrategy,
    orderedProducts: args.orderedProducts,
  });
  // "What I recommend" h2 with paragraphs.
  const recommendParagraphs: string[] = [];
  // Per audit move 9: PREPEND per-product sales-angle lines so the
  // section opens with the prospect's own pitch reflected back at
  // them, before Cody's product pitch lands. One short line per
  // in-scope product that has a matching angle.
  const salesAngleLines = composeSalesAnglesPerProduct({
    engagementStrategy: args.engagementStrategy,
    orderedProducts: args.orderedProducts,
  });
  for (const p of salesAngleLines) recommendParagraphs.push(p);
  // Per-product inline contributions (default pitch paragraphs).
  for (const p of contributions.flatMap(c => c.set.what_i_recommend_paragraphs || [])) {
    recommendParagraphs.push(p);
  }
  // Per audit move 8: APPEND per-product "Why I'm pitching X here"
  // paragraphs from engagement_strategy.recommended_product_mix.
  // Surfaces the AI's reasoning to the buyer instead of keeping it
  // admin-only. Confidence stays admin-side; only rationale ships.
  const mixRationaleParagraphs = composeWhyEachProduct({
    engagementStrategy: args.engagementStrategy,
    orderedProducts: args.orderedProducts,
  });
  for (const p of mixRationaleParagraphs) recommendParagraphs.push(p);

  // Closer: "How this works in practice." Constant boundary-setting
  // language that adapts to the product mix (not the strategy fields).
  // Echoes 07 §5.4 (hours do not roll over), §6.4 (decision velocity),
  // §7.5 (no chase work), §8 (change-order). Client agreeing to this
  // language up front sets the expectation the contract then enforces.
  //
  // When the matched snippet provides a `closer_tie_back` paragraph
  // (Cody-authored prose that ties the engagement to the prospect's
  // first stated value prop), it gets appended as the closer's final
  // paragraph. Per audit finding 4. The composer below threads the
  // tie-back through.
  const closerTieBack = contributions
    .map(c => c.set.closer_tie_back)
    .find(p => typeof p === 'string' && p.trim().length > 0);
  const closerParagraphs = composeHowItWorksCloser({
    orderedProducts: args.orderedProducts,
    tieBack: closerTieBack,
    waiveOnboarding: args.waiveOnboarding === true,
  });

  const sections: NarrativeSection[] = [];
  if (openerParagraphs.length > 0) {
    sections.push({ h2: 'The Situation', paragraphs: openerParagraphs });
  }
  if (seeParagraphs.length > 0) {
    sections.push({ h2: 'What I see in your business', paragraphs: seeParagraphs });
  }
  if (workParagraphs.length > 0) {
    sections.push({ h2: 'Where the work is', paragraphs: workParagraphs });
  }
  if (recommendParagraphs.length > 0) {
    sections.push({ h2: 'What I recommend', paragraphs: recommendParagraphs });
  }
  if (closerParagraphs.length > 0) {
    sections.push({ h2: 'How this works in practice', paragraphs: closerParagraphs });
  }

  // Rollout: if any product contributes scenarios, use the first
  // product's scenarios + scenario_step (Raised Bar style). Otherwise
  // concatenate single-scenario rollout_phases across products.
  const productWithScenarios = contributions.find(c => c.set.rollout_scenarios);
  let rollout: ProposalConfig['narrative']['rollout'] | undefined;
  if (productWithScenarios) {
    rollout = {
      h2: 'How it rolls out',
      scenario_step: productWithScenarios.set.rollout_scenario_step,
      scenarios: productWithScenarios.set.rollout_scenarios,
    };
  } else {
    const phases: NarrativePhase[] = contributions.flatMap(c => c.set.rollout_phases || []);
    if (phases.length > 0) {
      rollout = {
        h2: 'How it rolls out',
        phases,
      };
    }
  }

  return { intro, sections, rollout };
}

function composeIntro(args: {
  productNames: string[];
  productIntroLines: string[];
  urgency?: string;
}): string {
  // One short paragraph, Cody-voice. Names the products in scope and
  // sets the framing.
  const opener = `Here is the engagement I recommend, the numbers behind it, and the order it rolls out in.`;
  const productList = args.productNames.length > 0
    ? `The engagement runs on ${joinList(args.productNames)}.`
    : '';
  // Product intro lines are short sentences each product contributes.
  // Compose them into one paragraph.
  const productSentences = args.productIntroLines.join(' ');

  return [opener, productList, productSentences].filter(Boolean).join(' ');
}

// =========================================================================
// Opener: "The Situation" composed from sales_angles
// =========================================================================
//
// Renders up to three sales angles from the synthesis as the proposal's
// opening section. Each angle is the AI's one-sentence observation about
// the client's perceived problem, backed by scraped-content evidence
// (the validator drops angles without evidence per no-fabrication).
//
// The opener uses angles VERBATIM. No re-paraphrasing, no template
// chaining. If the AI returned a clean sentence, it stays clean; if
// the AI returned an awkward one, the admin reviews the panel and
// either re-runs research or overrides the section in the wizard.
function composeSituationOpener(args: {
  clientName: string;
  engagementStrategy?: EngagementStrategy | null;
}): string[] {
  const strategy = args.engagementStrategy;
  if (!strategy || !Array.isArray(strategy.sales_angles) || strategy.sales_angles.length === 0) {
    return [];
  }

  // Take up to 3 angles, normalize end punctuation, drop empties.
  const angles = strategy.sales_angles
    .slice(0, 3)
    .map(a => (a && typeof a.angle === 'string' ? a.angle.trim() : ''))
    .filter(Boolean)
    .map(s => (s.endsWith('.') || s.endsWith('!') || s.endsWith('?')) ? s : s + '.');
  if (angles.length === 0) return [];

  // One paragraph. Leads with what stood out, then each angle as its
  // own sentence. Plain language, no AI-template framing.
  const leadIn = angles.length === 1
    ? `One thing stood out looking at ${args.clientName}.`
    : `A few things stood out looking at ${args.clientName}.`;
  return [`${leadIn} ${angles.join(' ')}`];
}

// =========================================================================
// Per-product sales-angle lines from synthesis sales_angles
// =========================================================================
//
// Each sales angle the prospect tells their own customers can carry
// a product_implication tag (web_management / marketing_consulting /
// build / training) when the synthesis sees a clear mapping. This
// pulls the FIRST angle whose product_implication matches each
// in-scope product and renders it as a one-line opener in "What I
// recommend." Threads the prospect's own pitch into each product's
// section, so the buyer reads their own language reflected back at
// them before Cody's pitch lands.
//
// Per audit move 9.
function composeSalesAnglesPerProduct(args: {
  engagementStrategy?: EngagementStrategy | null;
  orderedProducts: ProductId[];
}): string[] {
  const strategy = args.engagementStrategy;
  if (!strategy || !Array.isArray(strategy.sales_angles) || strategy.sales_angles.length === 0) return [];
  const synthToShortName: Record<string, string> = {
    web_management: 'Web Management',
    marketing_consulting: 'Marketing Consulting',
    build: 'Build',
    training: 'Training',
  };
  const wizardToSynth: Record<string, string> = {
    'web-management': 'web_management',
    'marketing-consulting': 'marketing_consulting',
    'build': 'build',
    'training': 'training',
  };
  const out: string[] = [];
  const usedAngles = new Set<string>();
  for (const wizardId of args.orderedProducts) {
    const synthId = wizardToSynth[wizardId];
    if (!synthId) continue;
    const name = synthToShortName[synthId];
    if (!name) continue;
    // First angle whose product_implication matches AND we haven't
    // surfaced yet (no double-attribution to the same product).
    const match = strategy.sales_angles.find(a =>
      a && typeof a.angle === 'string' && a.angle.trim().length > 0
      && a.product_implication === synthId
      && !usedAngles.has(a.angle.trim().toLowerCase())
    );
    if (!match) continue;
    usedAngles.add(match.angle.trim().toLowerCase());
    const angleClean = match.angle.trim().replace(/[.!?]+$/, '');
    out.push(`<strong>${name}</strong> carries your own line forward: "${angleClean}."`);
  }
  return out;
}

// =========================================================================
// Per-product rationale from synthesis recommended_product_mix
// =========================================================================
//
// For each in-scope product that has a non-empty rationale in the
// synthesis, append a paragraph at the end of "What I recommend"
// that names why that product is being pitched. Buyer reads
// "<strong>Why Web Management?</strong> {rationale}" inline with
// the rest of the recommendation section.
//
// Per audit move 8. Confidence is admin-only.
function composeWhyEachProduct(args: {
  engagementStrategy?: EngagementStrategy | null;
  orderedProducts: ProductId[];
}): string[] {
  const strategy = args.engagementStrategy;
  if (!strategy || !strategy.recommended_product_mix) return [];
  // Synthesis product id (web_management) -> wizard product short name.
  const synthToShortName: Record<string, string> = {
    web_management: 'Web Management',
    marketing_consulting: 'Marketing Consulting',
    build: 'Build',
    training: 'Training',
  };
  // Same map but reversed: wizard id -> synthesis id for lookup.
  const wizardToSynth: Record<string, string> = {
    'web-management': 'web_management',
    'marketing-consulting': 'marketing_consulting',
    'build': 'build',
    'training': 'training',
  };
  const out: string[] = [];
  for (const wizardId of args.orderedProducts) {
    const synthId = wizardToSynth[wizardId];
    if (!synthId) continue;
    const rec = strategy.recommended_product_mix[synthId as EngagementStrategySynthProductId];
    if (!rec || !rec.rationale || rec.rationale.trim().length === 0) continue;
    const name = synthToShortName[synthId];
    if (!name) continue;
    const cleaned = rec.rationale.trim().replace(/[.!?]+$/, '') + '.';
    out.push(`<strong>Why ${name}?</strong> ${cleaned}`);
  }
  return out;
}

// =========================================================================
// "Where the work is" from synthesis internal_gaps
// =========================================================================
//
// Renders the AI's identified internal_gaps as a buyer-facing
// section between "What I see" and "What I recommend." High and
// medium severity only; low gaps stay admin-side. Each gap reads
// as one concrete thing the engagement addresses, with a soft
// inline product attribution when known. Voice goal: name the
// problem in Cody's framing, not "your site is broken."
//
// Per audit move 1. Previously internal_gaps was dropped at
// create.ts:131-172 and never reached the composer.
function composeWhereTheWorkIs(args: {
  engagementStrategy?: EngagementStrategy | null;
  orderedProducts: ProductId[];
}): string[] {
  const strategy = args.engagementStrategy;
  if (!strategy || !Array.isArray(strategy.internal_gaps) || strategy.internal_gaps.length === 0) {
    return [];
  }
  // Synthesis product id (web_management) -> wizard product short name.
  const synthToShortName: Record<string, string> = {
    web_management: 'Web Management',
    marketing_consulting: 'Marketing Consulting',
    build: 'Build',
    training: 'Training',
  };
  const inScopeSynthIds = new Set<string>(
    args.orderedProducts.map(id => {
      if (id === 'web-management') return 'web_management';
      if (id === 'marketing-consulting') return 'marketing_consulting';
      if (id === 'build') return 'build';
      if (id === 'training') return 'training';
      return '';
    }).filter(Boolean)
  );

  // Keep high + medium severity only; drop low (admin-only signal).
  // Cap at five so the section stays scannable.
  const kept = strategy.internal_gaps
    .filter(g => g && (g.severity === 'high' || g.severity === 'medium'))
    .filter(g => typeof g.gap === 'string' && g.gap.trim().length > 0)
    .slice(0, 5);
  if (kept.length === 0) return [];

  const leadIn = kept.length === 1
    ? `Here is one concrete thing the engagement addresses.`
    : `Here are the concrete things the engagement addresses.`;

  // Each gap renders as a single sentence. Cody-voice framing:
  // describe the gap as a fact, attach the product that handles it
  // when it maps cleanly to one in scope. Punctuation normalized so
  // the AI's input doesn't double-period or run on.
  const sentences: string[] = [];
  for (const g of kept) {
    const gapText = g.gap.trim().replace(/[.!?]+$/, '');
    const productKey = g.product_implication;
    let attribution = '';
    if (productKey && productKey !== 'none' && inScopeSynthIds.has(productKey)) {
      const productName = synthToShortName[productKey];
      if (productName) {
        attribution = ` <strong>${productName}</strong> handles this.`;
      }
    }
    sentences.push(`${gapText}.${attribution}`);
  }

  return [`${leadIn} ${sentences.join(' ')}`];
}

// =========================================================================
// Closer: "How this works in practice"
// =========================================================================
//
// Constant boundary-setting language adapted to the product mix in
// scope. Echoes the standard contract:
//   - 07 §5.4: "Unused included hours do not roll over"
//   - 07 §6.4: client decision-velocity (5 business days)
//   - 07 §7.5: Cody does not chase work the client ignores
//   - 07 §8:   new work outside scope is a change order
//
// Adapts wording per product (WM mentions hours pool; MC mentions
// strategy call; Build mentions transition to WM at launch). Does NOT
// reference tier names (no-dangling-tier-references rule). Never
// driven by engagement strategy synthesis fields; this is a Cody-
// constant.
function composeHowItWorksCloser(args: {
  orderedProducts: ProductId[];
  tieBack?: string;
  waiveOnboarding?: boolean;
}): string[] {
  if (args.orderedProducts.length === 0) return [];
  const hasWM = args.orderedProducts.includes('web-management');
  const hasMC = args.orderedProducts.includes('marketing-consulting');
  const hasBuild = args.orderedProducts.includes('build');
  const hasTraining = args.orderedProducts.includes('training');
  const waived = args.waiveOnboarding === true;

  const paragraphs: string[] = [];

  // Paragraph 1: month one. Onboarding so the client sees what is
  // changing fast (04 §4: anxiety highest in the first week). On a
  // reissue (waived), onboarding and the initial audit were already done
  // on the prior engagement, so the month-one framing flips to a
  // continuation: a build (new work) still scopes here, but the managed
  // sites and consulting pick up directly instead of re-onboarding.
  const monthOneParts: string[] = waived
    ? [`<strong>Month one continues where we left off.</strong> Because this picks up an existing engagement, there is no onboarding or initial audit to repeat; those were completed previously.`]
    : [`<strong>Month one is onboarding.</strong> The work in the first weeks is concentrated so you can see what is changing.`];
  if (hasBuild) {
    monthOneParts.push(`If a build is in scope, scoping conversations and the first design pass happen here.`);
  }
  if (hasWM) {
    monthOneParts.push(waived
      ? `Your managed sites carry over from the prior engagement; management continues without a new takeover.`
      : `If a site is moving onto management, the takeover audit, baseline health work, and access transfer happen in this window.`);
  }
  if (hasMC && !hasBuild && !hasWM) {
    monthOneParts.push(waived
      ? `The consulting audit is already on file; the strategy cycle picks up where it left off.`
      : `If consulting is in scope on its own, the initial audit and the first strategy cycle land in this window.`);
  } else if (hasMC) {
    monthOneParts.push(waived
      ? `The consulting audit is already on file; the strategy cycle continues.`
      : `If consulting is in scope, the initial audit lands in this window too.`);
  }
  paragraphs.push(monthOneParts.join(' '));

  // Paragraph 2: steady state. The cadence agreed to in writing.
  // Hours capped per cycle, do not roll over. Decisions in writing
  // turn around in five business days.
  const steadyParts: string[] = [
    `<strong>After month one is the steady cadence we agree to in writing.</strong>`,
  ];
  if (hasWM) {
    steadyParts.push(`Web Management runs on a pool of hours per cycle. Unused hours do not roll over to the next cycle; that is the trade for a predictable monthly fee.`);
  }
  if (hasMC) {
    steadyParts.push(`Marketing Consulting runs on the strategy-call cadence and advisory schedule in your level. Consulting is advice; execution routes through Web Management hours or a separate statement of work.`);
  }
  if (hasTraining && !hasMC && !hasWM) {
    steadyParts.push(`Training runs on the session cadence in your level.`);
  }
  steadyParts.push(`Decisions I send in writing turn around in five business days; that is what keeps the cycle moving.`);
  paragraphs.push(steadyParts.join(' '));

  // Paragraph 3: change orders for anything outside scope. Easy to
  // add; gets papered separately. (07 §8.)
  const changeOrderParts: string[] = [
    `<strong>New work that falls outside the agreed scope is a change order.</strong>`,
    `Easy to add and quick to paper. It keeps every party clear on what was bought and what is new.`,
  ];
  if (hasBuild) {
    changeOrderParts.push(`Subsequent builds in this engagement carry a 20 percent discount off the first.`);
  }
  paragraphs.push(changeOrderParts.join(' '));

  // Optional tie-back paragraph keyed to the prospect's first sales
  // angle. Snippet-authored; appended only when present so the closer
  // reads complete without it.
  if (args.tieBack && args.tieBack.trim().length > 0) {
    paragraphs.push(args.tieBack.trim());
  }

  return paragraphs;
}

function joinList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return items.slice(0, -1).join(', ') + ', and ' + items[items.length - 1];
}

function joinNames(items: string[]): string {
  return joinList(items);
}

// =========================================================================
// Pricing composer (called from proposal-pricing.ts product_driven_v1)
// =========================================================================

// Composes a PricingResult from per-product contributions. Iterates
// products, calls each computePricing, and accumulates totals. Returns
// in the legacy PricingResult shape so the renderer and emails read
// it unchanged.
import type { PricingResult } from '../proposal-pricing';

export function composePricing(args: {
  config: ProposalConfig;
  selections: Record<string, string | null>;
}): PricingResult | null {
  const products = args.config.products;
  const productVars = args.config.product_vars || {};
  if (!products || products.length === 0) return null;

  // Per ClickUp 86ba3ww35 fix: thread the managed_sites snapshot
  // and engagement_strategy that compose-time persisted onto the
  // config so this pricing path matches what Schedule A produces.
  // Without these, multi-site WM totals fell back to single-eco
  // and disagreed with the contract for any client with 2+ sites.
  const managedSites = args.config.managed_sites;
  const engagementStrategy = args.config.engagement_strategy ?? null;
  // Reissue / already-onboarded: zero the one-time setup fees.
  const waiveOnboarding = args.config.waive_onboarding === true;

  let monthly = 0;
  let oneTime = 0;
  const breakdown: Array<{ label: string; amount: number }> = [];
  // Per-product display summaries for the email/page summaries.
  const wmCtx = buildContextForProduct({
    id: 'web-management',
    selections: args.selections,
    productVars,
    products,
    managedSites,
    engagementStrategy,
    waiveOnboarding,
  });
  const mcCtx = buildContextForProduct({
    id: 'marketing-consulting',
    selections: args.selections,
    productVars,
    products,
    managedSites,
    engagementStrategy,
    waiveOnboarding,
  });

  // Iterate products in order, accumulating.
  let mgmtMonthly = 0;
  let consultingMonthly = 0;
  let mgmtTierName = '';
  let consultingTierName = '';

  for (const id of products) {
    const product = PRODUCT_REGISTRY[id];
    if (!product) continue;
    const ctx = buildContextForProduct({
      id,
      selections: args.selections,
      productVars,
      products,
      managedSites,
      engagementStrategy,
      waiveOnboarding,
    });
    const contribution = product.computePricing(ctx);
    monthly += contribution.monthly;
    oneTime += contribution.oneTime;
    breakdown.push(...contribution.breakdown);

    if (id === 'web-management') {
      mgmtMonthly = contribution.monthly;
      mgmtTierName = contribution.displaySummary?.tier_name || '';
    }
    if (id === 'marketing-consulting') {
      consultingMonthly = contribution.monthly;
      consultingTierName = contribution.displaySummary?.tier_name || '';
    }
  }

  // Legacy cross-product effects from pre-2026-05-28 Build options.
  // New Build options carry structural wm_sites_added /
  // wm_site_modifications, and Web Management prices those from the
  // buyer's selected wm_tier. Only apply static deltas for old saved
  // configs that have no structural WM payload at all.
  const buildVars = productVars['build'];
  const buildOptionsArr = buildVars && Array.isArray(buildVars.build_options)
    ? buildVars.build_options
    : [];
  const pickedBuildOptionId = args.selections['build_options'];
  if (pickedBuildOptionId && buildOptionsArr.length >= 2 && products.includes('web-management')) {
    const pickedOption = buildOptionsArr.find((o: any) => o && o.id === pickedBuildOptionId);
    if (pickedOption) {
      const hasStructuralWmPayload =
        (Array.isArray(pickedOption.wm_sites_added) && pickedOption.wm_sites_added.length > 0)
        || (Array.isArray(pickedOption.wm_site_modifications) && pickedOption.wm_site_modifications.length > 0);
      if (hasStructuralWmPayload) {
        // Already handled inside web-management.computePricing().
      } else {
        if (typeof pickedOption.wm_monthly_delta === 'number' && pickedOption.wm_monthly_delta !== 0) {
          monthly += pickedOption.wm_monthly_delta;
          mgmtMonthly += pickedOption.wm_monthly_delta;
          breakdown.push({
            label: `Web Management adjustment (${pickedOption.name})`,
            amount: pickedOption.wm_monthly_delta,
          });
        }
        if (typeof pickedOption.wm_onboarding_delta === 'number' && pickedOption.wm_onboarding_delta !== 0) {
          oneTime += pickedOption.wm_onboarding_delta;
          breakdown.push({
            label: `Web Management onboarding adjustment (${pickedOption.name})`,
            amount: pickedOption.wm_onboarding_delta,
          });
        }
      }
    }
  }

  // Apply the snapshotted per-client discount uniformly across all
  // line items + totals. Clamped to [0, 1] at compose time so it
  // cannot flip a total negative. A 0 discount is a no-op.
  const discount = typeof args.config.discount_rate === 'number'
    ? Math.max(0, Math.min(1, args.config.discount_rate))
    : 0;
  if (discount > 0) {
    const keep = 1 - discount;
    for (const line of breakdown) {
      line.amount = Math.round(line.amount * keep * 100) / 100;
    }
    monthly = Math.round(monthly * keep * 100) / 100;
    oneTime = Math.round(oneTime * keep * 100) / 100;
    mgmtMonthly = Math.round(mgmtMonthly * keep * 100) / 100;
    consultingMonthly = Math.round(consultingMonthly * keep * 100) / 100;
    // Surface the discount explicitly as the final breakdown line so
    // it shows up on the proposal page and in confirmation emails.
    const pctLabel = `Client discount (${(discount * 100).toFixed(discount * 100 % 1 === 0 ? 0 : 1)}%)`;
    breakdown.push({ label: pctLabel, amount: 0 });
  }

  return {
    oneTime,
    monthly,
    atSigning: oneTime + monthly,
    breakdown,
    mgmtMonthly,
    consultingMonthly,
    mgmtTierName,
    consultingTierName,
    siteSetupShortLabel: '',
    siteSetupLongLabel: '',
  };
}

// Bundled-tier mode (the Raised Bar / Jason 5/22 shape). A single
// buyer-facing Good/Better/Best card fuses Web Management + Marketing
// Consulting into one monthly + one to-start figure, with an optional
// add-on card below. The bundle is a PRESENTATION + buyer-decision layer
// only: all money stays registry-derived. This helper expands the single
// `bundle_tier` pick (and the optional `bundle_addon` toggle) into the
// canonical per-product selection keys (wm_tier / mc_yes_no / mc_tier /
// build_options) BEFORE composePricing and buildScheduleA run, so both
// derive identically from the unchanged product registry. That is the
// structural opposite of the rejected hardcoded-bundle approach (PR #195):
// the bundle never stores dollar figures.
//
// When config.bundle is absent it returns the selections unchanged, so
// every non-bundle product_driven_v1 proposal behaves byte-for-byte as
// before. Pure and idempotent: re-expanding an already-expanded map sets
// the same keys to the same values.
export function expandBundleSelections(
  config: any,
  selections: Record<string, string | null>,
): Record<string, string | null> {
  const bundle = config?.bundle;
  if (!bundle || !bundle.tiers || !selections) return selections;
  const pick = selections.bundle_tier;
  if (pick !== 'good' && pick !== 'better' && pick !== 'best') return selections;
  const map = bundle.tiers[pick];
  const wm = map?.wm;
  const mc = map?.mc;
  if (wm !== 'good' && wm !== 'better' && wm !== 'best') return selections;
  const expanded: Record<string, string | null> = {
    ...selections,
    wm_tier: wm,
    mc_yes_no: 'yes',
    mc_tier: (mc === 'good' || mc === 'better' || mc === 'best') ? mc : wm,
  };
  // Optional add-on: "add" maps to the add-on's build option (a net-new
  // site plus a subsequent build at the 20% discount); "skip" maps to the
  // no-add baseline option. Both option ids must exist in the build
  // product's build_options so the canonical build/WM math prices them.
  const addon = bundle.addon;
  if (addon && typeof selections.bundle_addon === 'string') {
    if (selections.bundle_addon === 'add' && addon.build_option_id) {
      expanded.build_options = addon.build_option_id;
    } else if (selections.bundle_addon === 'skip' && addon.skip_option_id) {
      expanded.build_options = addon.skip_option_id;
    }
  }
  return expanded;
}

// Resolve the tier picked for a product based on its step ids.
// Convention: web-management picks under selections.wm_tier;
// marketing-consulting under selections.mc_tier (gated by mc_yes_no).
function buildContextForProduct(args: {
  id: ProductId;
  selections: Record<string, string | null>;
  productVars: Record<ProductId, ProductVariables>;
  products: ProductId[];
  // Per ClickUp 86ba3ww35 fix: thread managedSites so WM's
  // computePricing produces per-site routed totals on the proposal
  // page (was falling back to single-eco for multi-site clients,
  // causing the proposal page price to disagree with Schedule A).
  managedSites?: Array<{
    domain: string;
    label?: string | null;
    is_primary?: boolean;
    page_count?: number | null;
    // Per-site pricing overrides; NULL = formula, non-null = exact
    // amount with multi-site multiplier skipped. Pro-bono and
    // grandfathered carve-outs.
    monthly_override?: number | null;
    onboarding_override?: number | null;
  }>;
  // Engagement strategy too — same gap (some snippets read it,
  // dispatcher path was dropping it).
  engagementStrategy?: EngagementStrategy | null;
  // Reissue / already-onboarded waiver from the proposal config.
  waiveOnboarding?: boolean;
}): ProductContext {
  const product = PRODUCT_REGISTRY[args.id];
  const variables = synthesizeWmPageCount(args.id, args.productVars[args.id] || {}, args.productVars);
  const ecosystemId = product.routeEcosystem(variables);

  let tierId: TierId | null = null;
  if (args.id === 'web-management') {
    const v = args.selections.wm_tier;
    if (v === 'good' || v === 'better' || v === 'best') tierId = v;
  } else if (args.id === 'marketing-consulting') {
    const yesNo = args.selections.mc_yes_no;
    if (yesNo === 'yes' || args.products.length === 1) {
      const v = args.selections.mc_tier;
      if (v === 'good' || v === 'better' || v === 'best') tierId = v;
    } else if (yesNo === 'no') {
      tierId = null;
    } else {
      const v = args.selections.mc_tier;
      if (v === 'good' || v === 'better' || v === 'best') tierId = v;
    }
  }
  // Build, training, other-sow do not have tier picks at v1.

  const otherProducts = args.products
    .filter(p => p !== args.id)
    .map(p => {
      let otherTier: TierId | null = null;
      if (p === 'web-management') {
        const v = args.selections.wm_tier;
        if (v === 'good' || v === 'better' || v === 'best') otherTier = v;
      } else if (p === 'marketing-consulting') {
        const v = args.selections.mc_tier;
        if (v === 'good' || v === 'better' || v === 'best') otherTier = v;
      }
      return { id: p, tierId: otherTier };
    });

  return {
    ecosystemId,
    tierId,
    variables,
    otherProducts,
    selections: args.selections,
    allProductVars: args.productVars,
    managedSites: args.managedSites,
    engagementStrategy: args.engagementStrategy ?? null,
    waiveOnboarding: args.waiveOnboarding ?? false,
  };
}

// Exported for use in contract-schedule.ts product_driven_v1 branch.
export { buildContextForProduct };
