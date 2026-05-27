// Web Management product definition.
//
// Encodes business-design-v2 Section 3: three ecosystems (A small, B
// mid, C large) routed by page count, three tiers (Good / Better /
// Best) per ecosystem, multi-site formula. Per 05 Section 4, takeover
// onboarding is per-site at full ecosystem base (NOT the multi-site
// discount); this is the trap and the unit tests guard it.

import type {
  ProductDefinition,
  ProductContext,
  Ecosystem,
  EcosystemId,
  TierId,
  ProductVariables,
  ProductPricingContribution,
  ProductScheduleAContribution,
  ProposalStep,
  ProposalStepOption,
  NarrativeSnippetSet,
  VariableSchemaField,
} from './types';

// =========================================================================
// Ecosystem definitions
// =========================================================================

export const WM_ECOSYSTEMS: Record<EcosystemId, Ecosystem> = {
  A: {
    id: 'A',
    label: 'Ecosystem A',
    band: 'Under 30 pages',
    multi_unit_monthly_discount: 0.80,
    multi_unit_onb_discount: 1.0, // per-site full base; no discount on onboarding
    tiers: {
      good: {
        id: 'good',
        name: 'Good',
        tagline: 'A start, intentionally light.',
        monthly: 297,
        onb: 800,
        hours: 3,
        update_cadence: 'monthly',
        response_time: 'standard tier response window',
        training_sessions: null,
        features: [
          'Hosting, daily backups, security and uptime monitoring on every site under management.',
          'Monthly software updates at the contracted cadence.',
          'About three pooled hours per month for hands-on site work.',
        ],
      },
      better: {
        id: 'better',
        name: 'Better',
        tagline: 'The flagship. The right fit for most clients.',
        recommended: true,
        monthly: 497,
        onb: 800,
        hours: 5,
        update_cadence: 'bi-weekly',
        response_time: 'standard tier response window',
        training_sessions: null,
        features: [
          'Everything in Good, plus bi-weekly software updates and performance optimization.',
          'A monthly health report so you always know what is happening.',
          'About five pooled hours per month for active page work, copy edits, image updates.',
        ],
      },
      best: {
        id: 'best',
        name: 'Best',
        tagline: 'Weekly updates. Same-day priority response.',
        monthly: 647,
        onb: 1000,
        hours: 8,
        update_cadence: 'weekly',
        response_time: 'same-day priority response',
        training_sessions: 1,
        features: [
          'Everything in Better, plus weekly updates and same-day priority response when something breaks.',
          'About eight pooled hours per month.',
          'One staff training session per quarter for your team, on whichever topic helps them most.',
        ],
      },
      custom: { id: 'custom', name: 'Custom' },
    },
  },
  B: {
    id: 'B',
    label: 'Ecosystem B',
    band: '30 to 150 pages',
    multi_unit_monthly_discount: 0.80,
    multi_unit_onb_discount: 1.0,
    tiers: {
      good: {
        id: 'good',
        name: 'Good',
        tagline: 'A start, intentionally light.',
        monthly: 497,
        onb: 1200,
        hours: 5,
        update_cadence: 'monthly',
        response_time: 'standard tier response window',
        training_sessions: null,
        features: [
          'Hosting, daily backups, security and uptime monitoring on every site under management.',
          'Monthly software updates at the contracted cadence.',
          'About five pooled hours per month for hands-on site work.',
        ],
      },
      better: {
        id: 'better',
        name: 'Better',
        tagline: 'The flagship. The right fit for most clients.',
        recommended: true,
        monthly: 797,
        onb: 1200,
        hours: 8,
        update_cadence: 'bi-weekly',
        response_time: 'standard tier response window',
        training_sessions: null,
        features: [
          'Everything in Good, plus bi-weekly software updates and performance optimization.',
          'A monthly health report so you always know what is happening.',
          'About eight pooled hours per month for active page work, copy edits, image updates.',
        ],
      },
      best: {
        id: 'best',
        name: 'Best',
        tagline: 'Weekly updates. Same-day priority response.',
        monthly: 997,
        onb: 1500,
        hours: 12,
        update_cadence: 'weekly',
        response_time: 'same-day priority response',
        training_sessions: 1,
        features: [
          'Everything in Better, plus weekly updates and same-day priority response when something breaks.',
          'About twelve pooled hours per month.',
          'One staff training session per quarter for your team, on whichever topic helps them most.',
        ],
      },
      custom: { id: 'custom', name: 'Custom' },
    },
  },
  C: {
    id: 'C',
    label: 'Ecosystem C',
    band: '150 or more pages',
    multi_unit_monthly_discount: 0.80,
    multi_unit_onb_discount: 1.0,
    tiers: {
      good: {
        id: 'good',
        name: 'Good',
        tagline: 'A start, intentionally light.',
        monthly: 997,
        onb: 2000,
        hours: 8,
        update_cadence: 'monthly',
        response_time: 'standard tier response window',
        training_sessions: null,
        features: [
          'Hosting, daily backups, security and uptime monitoring on every site under management.',
          'Monthly software updates at the contracted cadence.',
          'About eight pooled hours per month for hands-on site work.',
        ],
      },
      better: {
        id: 'better',
        name: 'Better',
        tagline: 'The flagship. The right fit for most clients.',
        recommended: true,
        monthly: 1497,
        onb: 2000,
        hours: 12,
        update_cadence: 'bi-weekly',
        response_time: 'standard tier response window',
        training_sessions: null,
        features: [
          'Everything in Good, plus bi-weekly software updates and performance optimization.',
          'A monthly health report so you always know what is happening.',
          'About twelve pooled hours per month for active page work, copy edits, image updates.',
        ],
      },
      best: {
        id: 'best',
        name: 'Best',
        tagline: 'Weekly updates. Same-day priority response.',
        monthly: 1997,
        onb: 2500,
        hours: 18,
        update_cadence: 'weekly',
        response_time: 'same-day priority response',
        training_sessions: 1,
        features: [
          'Everything in Better, plus weekly updates and same-day priority response when something breaks.',
          'About eighteen pooled hours per month.',
          'One staff training session per quarter for your team, on whichever topic helps them most.',
        ],
      },
      custom: { id: 'custom', name: 'Custom' },
    },
  },
};

// =========================================================================
// Variable schema
// =========================================================================

const VARIABLE_SCHEMA: VariableSchemaField[] = [
  {
    id: 'page_count',
    label: 'Page count (across all managed sites)',
    type: 'number',
    default: null,
    help: 'Total page count across the sites in scope. Routes the ecosystem. Defaults to the latest crawl aggregate if available.',
  },
  {
    id: 'site_count',
    label: 'Number of sites under management',
    type: 'number',
    default: 1,
    help: 'How many domains the engagement covers. The multi-site formula applies for site_count > 1.',
  },
];

// =========================================================================
// Routing
// =========================================================================

export function routeWebManagementEcosystem(pageCount: number | null): EcosystemId | null {
  if (pageCount === null || pageCount === undefined) return null;
  if (pageCount < 30) return 'A';
  if (pageCount <= 150) return 'B';
  return 'C';
}

// =========================================================================
// Pricing math
// =========================================================================
//
// Multi-site formula locked 2026-05-24 per docs/audits/proposal-chain-
// audit-2026-05-24.md finding 1. Replaces the prior "all sites priced
// off primary's ecosystem" rule.
//
// Each managed site routes to its OWN ecosystem by its OWN page count.
// The engagement tier (Good / Better / Best) is set once and applied
// to every site. Each site contributes its own ecosystem's tier base.
// The primary contributes its full base; each additional site
// contributes its base × MULTI_SITE_DISCOUNT. Linear, no compounding.
// Same discount applies to monthly and onboarding.

export const MULTI_SITE_DISCOUNT = 0.80;

// Sum a per-site array of bases with the multi-site discount. The
// FIRST element is the primary (full base); the rest are additional
// sites at the discounted rate. Used for both monthly and onboarding.
//
// Callers compute each site's base by routing the site to its own
// ecosystem (via routeWebManagementEcosystem) and looking up the
// engagement tier's monthly or onb value at that ecosystem.
//
// Rounds to cents (2 decimals) per-step so float artifacts from
// multiplying integer-dollar bases by 0.80 do not accumulate. Money
// math is decimal; the bases are always whole or half-cent dollar
// figures, and the discount is exactly 0.80.
export function computeMultiSiteSum(perSiteBases: number[]): number {
  if (perSiteBases.length === 0) return 0;
  const [primary, ...additional] = perSiteBases;
  const discountedSum = additional.reduce(
    (sum, base) => sum + Math.round(base * MULTI_SITE_DISCOUNT * 100) / 100,
    0
  );
  return Math.round((primary + discountedSum) * 100) / 100;
}

// Override-aware sum. Per-site shape: { base, isOverride }. Primary
// (index 0) always gets full base. Additional sites get 0.80x UNLESS
// isOverride is true, in which case they get full base because the
// override IS the price (no multi-site discount on top of a
// grandfathered or pro-bono carve-out). Used by the WM pricing
// pipeline when managedSites carry monthly_override / onboarding_override.
export type PerSiteBase = { base: number; isOverride: boolean };

export function computeMultiSiteSumWithOverrides(perSite: PerSiteBase[]): number {
  if (perSite.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < perSite.length; i++) {
    const { base, isOverride } = perSite[i];
    const factor = (i === 0 || isOverride) ? 1 : MULTI_SITE_DISCOUNT;
    sum += Math.round(base * factor * 100) / 100;
  }
  return Math.round(sum * 100) / 100;
}

// Legacy single-ecosystem helpers. Retained for callsites that have
// NOT been migrated to pass per-site arrays yet, AND for the fallback
// path when no per-site page counts exist (the primary's ecosystem
// applies to every site). When `sites` is the number of managed sites
// and `base` is the single shared ecosystem base, the result is
// identical to the new per-site formula with all sites at the same
// base.
export function computeMultiSiteMonthly(base: number, sites: number): number {
  const n = Math.max(1, sites);
  return computeMultiSiteSum(Array(n).fill(base));
}

export function computeMultiSiteOnboarding(base: number, sites: number): number {
  const n = Math.max(1, sites);
  return computeMultiSiteSum(Array(n).fill(base));
}

// Build the per-site base arrays from ctx.managedSites + the chosen
// tier. Each site routes to its own ecosystem via its page_count;
// sites whose page_count is null fall back to the primary site's
// ecosystem. Returns [monthlyBases[], onboardingBases[]] aligned per
// site, primary first.
//
// When ctx.managedSites is empty/undefined, the caller falls back to
// ctx.variables.site_count + ctx.ecosystemId (the legacy single-
// ecosystem flow). This function is only relevant when managedSites
// is populated.
export function buildPerSiteBases(args: {
  managedSites: Array<{
    is_primary?: boolean;
    page_count?: number | null;
    monthly_override?: number | null;
    onboarding_override?: number | null;
  }>;
  tierId: TierId;
  primaryEcosystemId: EcosystemId;
}): {
  monthlyBases: number[];
  onboardingBases: number[];
  monthlyPerSite: PerSiteBase[];
  onboardingPerSite: PerSiteBase[];
} {
  // Sort so primary is first; the discount applies to the rest.
  const sorted = [...args.managedSites].sort((a, b) => {
    if (!!a.is_primary === !!b.is_primary) return 0;
    return a.is_primary ? -1 : 1;
  });
  const monthlyBases: number[] = [];
  const onboardingBases: number[] = [];
  const monthlyPerSite: PerSiteBase[] = [];
  const onboardingPerSite: PerSiteBase[] = [];
  for (const site of sorted) {
    const eco = site.page_count != null
      ? (routeWebManagementEcosystem(site.page_count) || args.primaryEcosystemId)
      : args.primaryEcosystemId;
    const ecosystem = WM_ECOSYSTEMS[eco];
    const tier = ecosystem?.tiers[args.tierId];
    const formulaMonthly = tier?.monthly || 0;
    const formulaOnb = tier?.onb || 0;
    // Per-site override: NULL = use formula; any non-null value
    // (including 0) = use the override and skip the multi-site
    // multiplier for this site.
    const monthlyIsOverride = site.monthly_override != null;
    const onbIsOverride = site.onboarding_override != null;
    const monthlyBase = monthlyIsOverride ? site.monthly_override! : formulaMonthly;
    const onbBase = onbIsOverride ? site.onboarding_override! : formulaOnb;
    monthlyBases.push(monthlyBase);
    onboardingBases.push(onbBase);
    monthlyPerSite.push({ base: monthlyBase, isOverride: monthlyIsOverride });
    onboardingPerSite.push({ base: onbBase, isOverride: onbIsOverride });
  }
  return { monthlyBases, onboardingBases, monthlyPerSite, onboardingPerSite };
}

// Apply a picked BuildOption's wm_site_modifications to a managedSites
// array. Returns a new array (or the original reference if there are
// no modifications). Both computePricing and buildScheduleAContribution
// call this BEFORE pricing/rendering so the post-option state is the
// single source of truth: WM totals and Schedule A both reflect the
// modified page counts (and therefore the modified ecosystem routing).
//
// Modifications match by site_domain (case-insensitive). A modification
// that does not match any managedSite is silently ignored — the wizard
// authors them by picking from existing managed domains, but if the
// admin renames a site between picks the modification will no-op
// rather than crash.
export function applyBuildOptionSiteModifications<
  S extends { domain: string; page_count?: number | null }
>(args: {
  managedSites: S[];
  allProductVars?: Record<string, any>;
  selections?: Record<string, any>;
}): S[] {
  const productVars = args.allProductVars || {};
  const buildOptionsArr = productVars['build']?.build_options;
  const pickedBuildOptionId = args.selections?.['build_options'];
  if (!Array.isArray(buildOptionsArr) || !pickedBuildOptionId) return args.managedSites;
  const pickedOption = buildOptionsArr.find((o: any) => o && o.id === pickedBuildOptionId);
  if (!pickedOption || !Array.isArray(pickedOption.wm_site_modifications)) return args.managedSites;
  const modMap: Record<string, number> = {};
  for (const mod of pickedOption.wm_site_modifications) {
    if (mod && typeof mod.site_domain === 'string' && typeof mod.new_page_count === 'number') {
      modMap[mod.site_domain.toLowerCase()] = mod.new_page_count;
    }
  }
  if (Object.keys(modMap).length === 0) return args.managedSites;
  return args.managedSites.map(s => {
    const key = s.domain.toLowerCase();
    return modMap[key] != null ? { ...s, page_count: modMap[key] } : s;
  });
}

// =========================================================================
// Step generation
// =========================================================================

function buildTierOption(args: {
  tierId: TierId;
  ecosystem: Ecosystem;
  sites: number;
  aiRecommendedTier?: TierId | null;
  // Per audit move 5: the AI's reason for recommending this tier
  // surfaces as a sub-line under the Recommended pill. Only set when
  // the tier is the AI-recommended one (skipped for non-matching
  // tiers and for product-default recommendations).
  aiRecommendedRationale?: string;
  // Optional managed sites array. When present and >= 2 sites, the
  // tier card pricing reflects per-site ecosystem routing instead of
  // priming everything off the primary's ecosystem. The features list
  // also gains a per-site breakdown line so the buyer sees how the
  // total is built. Per the 2026-05-24 locked formula. Per-site
  // monthly_override / onboarding_override (if set) bypass the
  // multi-site multiplier for that site.
  managedSites?: Array<{
    domain: string; label?: string | null; is_primary?: boolean;
    page_count?: number | null;
    monthly_override?: number | null;
    onboarding_override?: number | null;
  }>;
}): ProposalStepOption {
  const tier = args.ecosystem.tiers[args.tierId];

  // Path A: per-site ecosystem when managedSites with page_count data
  // is present. Path B: legacy single-eco fallback otherwise.
  let monthly: number;
  let onb: number;
  let perSiteBreakdown: string | null = null;
  const hasPerSiteData = Array.isArray(args.managedSites)
    && args.managedSites.length > 0
    && args.managedSites.some(s => s.page_count != null);
  if (hasPerSiteData) {
    const { monthlyPerSite, onboardingPerSite } = buildPerSiteBases({
      managedSites: args.managedSites!,
      tierId: args.tierId,
      primaryEcosystemId: args.ecosystem.id,
    });
    monthly = computeMultiSiteSumWithOverrides(monthlyPerSite);
    onb = computeMultiSiteSumWithOverrides(onboardingPerSite);
    // Build the per-site breakdown line for the features list.
    // Primary's contribution + each additional site's contribution.
    // Overridden sites contribute their override amount as-is; non-
    // overridden additional sites get the 0.80 multi-site factor.
    const sortedSites = [...args.managedSites!].sort((a, b) => {
      if (!!a.is_primary === !!b.is_primary) return 0;
      return a.is_primary ? -1 : 1;
    });
    const breakdownParts = sortedSites.map((s, i) => {
      const label = s.label && s.label !== s.domain ? s.label : s.domain;
      const { base, isOverride } = monthlyPerSite[i];
      const factor = (i === 0 || isOverride) ? 1 : MULTI_SITE_DISCOUNT;
      const contribution = Math.round(base * factor * 100) / 100;
      return `${formatMoney(contribution)} (${label})`;
    });
    perSiteBreakdown = `Per-site monthly: ${breakdownParts.join(' + ')} = ${formatMoney(monthly)}.`;
  } else {
    monthly = computeMultiSiteMonthly(tier.monthly || 0, args.sites);
    onb = computeMultiSiteOnboarding(tier.onb || 0, args.sites);
  }

  // AI's per-prospect tier recommendation overrides the static product
  // default. When AI didn't recommend a tier (or its recommendation is
  // not a valid tier id for this ecosystem), fall back to the tier
  // definition's own `recommended` flag. Per finding 3.
  const recommended = args.aiRecommendedTier
    ? args.aiRecommendedTier === args.tierId
    : !!tier.recommended;

  const features = tier.features ? [...tier.features] : [];
  if (perSiteBreakdown) {
    features.push(perSiteBreakdown);
  }

  // Surface the AI rationale only when THIS tier is the AI-recommended
  // one AND the rationale string is non-empty. Skipped for non-
  // recommended tiers and when the recommendation came from the
  // product's static default (no AI rationale exists in that case).
  const showRationale = args.aiRecommendedTier
    && args.aiRecommendedTier === args.tierId
    && typeof args.aiRecommendedRationale === 'string'
    && args.aiRecommendedRationale.trim().length > 0;
  return {
    id: args.tierId,
    name: tier.name,
    tagline: tier.tagline,
    recommended,
    recommended_rationale: showRationale ? args.aiRecommendedRationale!.trim() : undefined,
    price_label: formatMoney(monthly),
    price_suffix: '/ month',
    price_subline: args.sites > 1
      ? `${formatMoney(onb)} onboarding total, ${args.sites} sites${hasPerSiteData ? ' (per-site routed)' : ` at ${args.ecosystem.label}`}`
      : `${formatMoney(onb)} onboarding, ${args.ecosystem.label}`,
    features,
  };
}

function formatMoney(n: number): string {
  return '$' + Math.round(n).toLocaleString('en-US');
}

// =========================================================================
// Narrative snippets
// =========================================================================

// Cody-voice defaults. Snippet keys allow per-prospect overrides via
// the narrative-snippets.ts registry; this file provides the baseline
// every WM-in-scope proposal starts from. Replaceable per engagement
// through the wizard's override step.
function buildWebManagementNarrative(ctx: ProductContext): NarrativeSnippetSet {
  const sites = numberFromVar(ctx.variables.site_count, 1);
  const ecoId = ctx.ecosystemId || 'B';
  const eco = WM_ECOSYSTEMS[ecoId];

  const siteWord = sites === 1 ? 'one site' : `${sites} sites`;
  const ecoBand = eco?.band || '';

  // Engagement-strategy adaptation. Light touch; one additional
  // paragraph at most when the synthesis points to a strong shape.
  // Does NOT name tiers (no-dangling-tier-references rule); steers
  // the framing instead.
  const what_i_see_paragraphs: string[] = [
    `Your site footprint sits at <strong>${ecoBand}</strong>${ecoBand ? ', placing it in ' : 'in '}${eco?.label || 'an ecosystem'} for management pricing. The tier you pick sets how often I update your sites, how fast I respond when something breaks, and how many hands-on hours per month sit in your pool.`,
  ];
  const strategy = ctx.engagementStrategy;
  if (strategy?.cody_time_intensity === 'high') {
    what_i_see_paragraphs.push(
      `The footprint also reads heavy on cleanup. Onboarding focuses on stabilizing what is already in place before tightening the steady cadence.`
    );
  } else if (strategy?.clv_horizon === 'churn-risk') {
    what_i_see_paragraphs.push(
      `Engagement-shape note: the priority of the first 30 days is to set a stable floor under the site, not to expand scope. Stability now, growth conversations after.`
    );
  }

  return {
    intro_lines: [
      `Web Management keeps the ${siteWord} you have under management running, secure, and improving every month.`,
    ],
    what_i_see_paragraphs,
    what_i_recommend_paragraphs: [
      sites === 1
        ? `<strong>Web Management</strong> for the site. The fee covers hosting, daily backups, security and uptime monitoring, software updates at the contracted cadence, and a pool of hands-on hours for site work. Unused hours do not roll over; that is the trade for a predictable monthly.`
        : `<strong>Web Management</strong> for all ${sites} sites under one engagement. Each site is sized to its own ecosystem by its own page count, at the engagement tier you pick. The primary site pays the full base monthly and full base onboarding for its ecosystem at that tier; each additional site pays 80 percent of its own ecosystem's base monthly and 80 percent of its own ecosystem's base onboarding at the same tier. Linear, no compounding. Pooled hours scale across all sites.`,
    ],
  };
}

function numberFromVar(v: ProductVariables[string] | undefined, dflt: number): number {
  if (v === null || v === undefined) return dflt;
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

// =========================================================================
// Product definition
// =========================================================================

export const webManagementProduct: ProductDefinition = {
  id: 'web-management',
  name: 'Web Management',
  short_name: 'Web Management',

  variableSchema: VARIABLE_SCHEMA,

  ecosystems: WM_ECOSYSTEMS,

  routeEcosystem(variables) {
    const pageCount = numberFromVar(variables.page_count, NaN);
    if (!Number.isFinite(pageCount)) return null;
    return routeWebManagementEcosystem(pageCount);
  },

  generateSteps(ctx) {
    if (!ctx.ecosystemId) return [];
    const eco = WM_ECOSYSTEMS[ctx.ecosystemId];
    if (!eco) return [];
    const sites = numberFromVar(ctx.variables.site_count, 1);
    // AI's per-prospect tier recommendation, when present, overrides
    // the static "Better is recommended for everyone" default. Per
    // finding 3 in docs/audits/proposal-chain-audit-2026-05-24.md.
    const aiTier = ctx.engagementStrategy?.recommended_tier_per_product?.web_management?.tier;
    const aiRecommendedTier = aiTier === 'good' || aiTier === 'better' || aiTier === 'best'
      ? aiTier as TierId
      : null;
    // Per audit move 5: also pull the rationale so the recommended
    // tier card can show "why this one fits."
    const aiRecommendedRationale = ctx.engagementStrategy?.recommended_tier_per_product?.web_management?.rationale;
    // Thread managedSites into buildTierOption so per-site monthly
    // and the per-site breakdown line render correctly when multi-site.
    const managedSites = ctx.managedSites;
    const step: ProposalStep = {
      id: 'wm_tier',
      type: 'tier_picker',
      h2: 'Pick a Web Management level',
      prompt: `Good, Better, or Best for Web Management. The level sets how often I update your sites, how fast I respond when something breaks, and how many hands-on hours per month sit in your pool.`,
      options: [
        buildTierOption({ tierId: 'good', ecosystem: eco, sites, aiRecommendedTier, aiRecommendedRationale, managedSites }),
        buildTierOption({ tierId: 'better', ecosystem: eco, sites, aiRecommendedTier, aiRecommendedRationale, managedSites }),
        buildTierOption({ tierId: 'best', ecosystem: eco, sites, aiRecommendedTier, aiRecommendedRationale, managedSites }),
      ],
    };
    return [step];
  },

  generateNarrativeSnippets(ctx) {
    return buildWebManagementNarrative(ctx);
  },

  computePricing(ctx) {
    if (!ctx.ecosystemId || !ctx.tierId) {
      return { monthly: 0, oneTime: 0, breakdown: [], displaySummary: {} };
    }
    const eco = WM_ECOSYSTEMS[ctx.ecosystemId];
    if (!eco) return { monthly: 0, oneTime: 0, breakdown: [], displaySummary: {} };
    const tier = eco.tiers[ctx.tierId];
    if (!tier || tier.monthly == null || tier.onb == null) {
      return { monthly: 0, oneTime: 0, breakdown: [], displaySummary: {} };
    }
    // Two pricing paths:
    //   (1) Per-site ecosystem (2026-05-24 locked formula): ctx.managedSites
    //       is populated with at least one site that has a page_count.
    //       Each site routes to its own ecosystem; bases come from
    //       buildPerSiteBases().
    //   (2) Fallback: no per-site data. All sites priced off the
    //       primary's ecosystem (ctx.ecosystemId). Uses the legacy
    //       single-base helpers, which now produce identical results
    //       to path (1) when all sites are at the same ecosystem.
    let monthly: number;
    let onb: number;
    let sitesCount: number;
    // Apply BuildOption modifications first so the WM monthly/onboarding
    // line reflects the post-option page counts (matches Schedule A).
    const modifiedManagedSites = ctx.managedSites && ctx.managedSites.length > 0
      ? applyBuildOptionSiteModifications({
          managedSites: ctx.managedSites,
          allProductVars: ctx.allProductVars,
          selections: ctx.selections,
        })
      : ctx.managedSites;
    const hasPerSiteData = modifiedManagedSites && modifiedManagedSites.length > 0
      && modifiedManagedSites.some(s => s.page_count != null);
    if (hasPerSiteData) {
      const { monthlyPerSite, onboardingPerSite } = buildPerSiteBases({
        managedSites: modifiedManagedSites!,
        tierId: ctx.tierId,
        primaryEcosystemId: ctx.ecosystemId,
      });
      monthly = computeMultiSiteSumWithOverrides(monthlyPerSite);
      onb = computeMultiSiteSumWithOverrides(onboardingPerSite);
      sitesCount = modifiedManagedSites!.length;
    } else {
      sitesCount = numberFromVar(ctx.variables.site_count, 1);
      monthly = computeMultiSiteMonthly(tier.monthly, sitesCount);
      onb = computeMultiSiteOnboarding(tier.onb, sitesCount);
    }
    return {
      monthly,
      oneTime: onb,
      breakdown: [
        { label: `Web Management onboarding (${sitesCount === 1 ? '1 site' : `${sitesCount} sites`}, ${tier.name})`, amount: onb },
      ],
      displaySummary: {
        tier_name: tier.name,
        ecosystem_label: eco.label,
        sites_text: sitesCount === 1 ? '1 site' : `${sitesCount} sites`,
      },
    };
  },

  buildScheduleAContribution(ctx, pricing) {
    if (!ctx.ecosystemId || !ctx.tierId) {
      return { products_purchased: { web_management: false } };
    }
    const eco = WM_ECOSYSTEMS[ctx.ecosystemId];
    const tier = eco?.tiers[ctx.tierId];
    if (!tier) return { products_purchased: { web_management: false } };

    // Per the 2026-05-24 locked multi-site formula, each site routes
    // to its OWN ecosystem and gets its OWN per-site contribution.
    // Schedule A surfaces these per-site rows so the buyer sees how
    // the total breaks down. When ctx.managedSites is empty/legacy,
    // fall back to placeholder rows priced off the primary's ecosystem.
    type SiteRow = {
      domain: string;
      description: string;
      ecosystem?: string;
      monthly_contribution?: number;
      onboarding_contribution?: number;
      is_primary?: boolean;
    };
    let siteRows: SiteRow[];
    let sites: number;
    if (ctx.managedSites && ctx.managedSites.length > 0) {
      // Apply BuildOption wm_site_modifications BEFORE pricing so any
      // changes to existing site page counts re-route the site's
      // ecosystem in the Schedule A render. WM monthly/onboarding line
      // (in computePricing) and Schedule A both call the same helper,
      // so the post-option state is the single source of truth.
      const mutated = applyBuildOptionSiteModifications({
        managedSites: ctx.managedSites,
        allProductVars: ctx.allProductVars,
        selections: ctx.selections,
      });
      const sorted = [...mutated].sort((a, b) => {
        if (!!a.is_primary === !!b.is_primary) return a.domain.localeCompare(b.domain);
        return a.is_primary ? -1 : 1;
      });
      // Compute per-site monthly + onboarding contributions using the
      // locked formula. First site (primary) at full base; each
      // additional at base * 0.80, with base routed from that site's
      // own page_count (or primary's ecosystem if null). Per-site
      // monthly_override / onboarding_override (when non-null) replace
      // the formula base AND skip the 0.80 multiplier for that site.
      siteRows = sorted.map((s, idx) => {
        const siteEco = s.page_count != null
          ? (routeWebManagementEcosystem(s.page_count) || ctx.ecosystemId!)
          : ctx.ecosystemId!;
        const siteEcoObj = WM_ECOSYSTEMS[siteEco];
        const siteTier = siteEcoObj?.tiers[ctx.tierId!];
        const monthlyFormulaBase = siteTier?.monthly || 0;
        const onbFormulaBase = siteTier?.onb || 0;
        const monthlyIsOverride = (s as any).monthly_override != null;
        const onbIsOverride = (s as any).onboarding_override != null;
        const monthlyBase = monthlyIsOverride ? (s as any).monthly_override : monthlyFormulaBase;
        const onbBase = onbIsOverride ? (s as any).onboarding_override : onbFormulaBase;
        // Primary or overridden sites skip the multiplier.
        const monthlyFactor = (idx === 0 || monthlyIsOverride) ? 1 : MULTI_SITE_DISCOUNT;
        const onbFactor = (idx === 0 || onbIsOverride) ? 1 : MULTI_SITE_DISCOUNT;
        return {
          domain: s.label && s.label !== s.domain ? `${s.label} (${s.domain})` : s.domain,
          description: s.is_primary ? 'primary site' : '',
          ecosystem: siteEco,
          monthly_contribution: Math.round(monthlyBase * monthlyFactor * 100) / 100,
          onboarding_contribution: Math.round(onbBase * onbFactor * 100) / 100,
          is_primary: !!s.is_primary,
        };
      });
      sites = sorted.length;
    } else {
      sites = numberFromVar(ctx.variables.site_count, 1);
      // No per-site data; placeholder rows at primary's ecosystem.
      const baseMonthly = tier.monthly || 0;
      const baseOnb = tier.onb || 0;
      siteRows = Array.from({ length: sites }, (_, i) => {
        const factor = i === 0 ? 1 : MULTI_SITE_DISCOUNT;
        return {
          domain: i === 0 ? '(primary domain confirmed at signing)' : `(additional site ${i + 1} domain confirmed at signing)`,
          description: '',
          ecosystem: ctx.ecosystemId!,
          monthly_contribution: Math.round(baseMonthly * factor * 100) / 100,
          onboarding_contribution: Math.round(baseOnb * factor * 100) / 100,
          is_primary: i === 0,
        };
      });
    }
    // Cross-product effect from a picked Build option (Raised Bar
    // pattern). If a build_options pick adds sites via wm_sites_added,
    // append placeholder rows to the WM Schedule A section so the
    // executed contract reflects the picked shape. The pricing was
    // already adjusted via wm_monthly_delta + wm_onboarding_delta at
    // the dispatcher; here we just surface the rows.
    try {
      const productVars = ctx.allProductVars || {};
      const buildOptionsArr = productVars['build']?.build_options;
      const pickedBuildOptionId = ctx.selections?.['build_options'];
      if (Array.isArray(buildOptionsArr) && pickedBuildOptionId) {
        const pickedOption = buildOptionsArr.find((o: any) => o && o.id === pickedBuildOptionId);
        if (pickedOption && Array.isArray(pickedOption.wm_sites_added)) {
          for (const addedSite of pickedOption.wm_sites_added) {
            if (!addedSite || !addedSite.domain) continue;
            const pageCount = addedSite.page_count_estimate;
            const siteEco = pageCount != null
              ? (routeWebManagementEcosystem(pageCount) || ctx.ecosystemId!)
              : ctx.ecosystemId!;
            const siteEcoObj = WM_ECOSYSTEMS[siteEco];
            const siteTier = siteEcoObj?.tiers[ctx.tierId!];
            const monthlyBase = siteTier?.monthly || 0;
            const onbBase = siteTier?.onb || 0;
            siteRows.push({
              domain: addedSite.label && addedSite.label !== addedSite.domain
                ? `${addedSite.label} (${addedSite.domain})`
                : addedSite.domain,
              description: `added when prospect picked "${pickedOption.name}"`,
              ecosystem: siteEco,
              monthly_contribution: Math.round(monthlyBase * MULTI_SITE_DISCOUNT * 100) / 100,
              onboarding_contribution: Math.round(onbBase * MULTI_SITE_DISCOUNT * 100) / 100,
              is_primary: false,
            });
            sites++;
          }
        }
      }
    } catch {
      // Defensive: cross-product Schedule A augmentation should never
      // crash WM's own Schedule A build. Skip silently if shape is
      // wrong.
    }

    return {
      products_purchased: { web_management: true },
      web_management: {
        tier_name: tier.name,
        sites: siteRows,
        site_count: sites,
        monthly_base: tier.monthly || 0,
        monthly_total: Math.round(pricing.monthly),
        included_hours: tier.hours || 0,
        onboarding_fee: tier.onb || 0,
        onboarding_total: Math.round(pricing.oneTime),
        update_cadence: tier.update_cadence || 'monthly',
        response_time: tier.response_time || 'standard tier response window',
        quarterly_training_sessions: tier.training_sessions ?? null,
        // Per Cody operating rule (2026-05-26): single billing
        // cadence across all sites under one agreement.
        billing_cadence_note: 'Per-site Web Management monthly fees are prorated at each site\'s go-live date to align with this engagement\'s monthly billing cadence. All sites under this agreement bill on the same monthly date thereafter, on one consolidated invoice.',
      },
      hours_addendum: { included_hours: tier.hours || 0 },
      pass_through_items: siteRows.map(site => ({
        name: `Plugin and software management (${site.domain})`,
        monthly_cost: 15,
        billing_note: 'billed monthly with the recurring invoice',
      })),
    };
  },
};
