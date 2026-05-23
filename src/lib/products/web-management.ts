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

// Multi-site monthly = base + (n - 1) * base * 0.80
export function computeMultiSiteMonthly(base: number, sites: number): number {
  const n = Math.max(1, sites);
  return base + (n - 1) * base * 0.80;
}

// Per 05 Section 4: takeover onboarding is per-site at FULL ecosystem
// base, NOT the multi-site formula. This function multiplies, not
// discounts. The test in tests/lib/products/web-management.test.mjs
// asserts this against the documented rule.
export function computeMultiSiteOnboarding(base: number, sites: number): number {
  const n = Math.max(1, sites);
  return base * n;
}

// =========================================================================
// Step generation
// =========================================================================

function buildTierOption(args: {
  tierId: TierId;
  ecosystem: Ecosystem;
  sites: number;
}): ProposalStepOption {
  const tier = args.ecosystem.tiers[args.tierId];
  const monthly = computeMultiSiteMonthly(tier.monthly || 0, args.sites);
  const onb = computeMultiSiteOnboarding(tier.onb || 0, args.sites);
  return {
    id: args.tierId,
    name: tier.name,
    tagline: tier.tagline,
    recommended: !!tier.recommended,
    price_label: formatMoney(monthly),
    price_suffix: '/ month',
    price_subline: args.sites > 1
      ? `${formatMoney(onb)} onboarding, ${args.sites} sites at ${args.ecosystem.label}`
      : `${formatMoney(onb)} onboarding, ${args.ecosystem.label}`,
    features: tier.features ? [...tier.features] : [],
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

  return {
    intro_lines: [
      `Web Management keeps the ${siteWord} you have under management running, secure, and improving every month.`,
    ],
    what_i_see_paragraphs: [
      `Your site footprint sits at <strong>${ecoBand}</strong>${ecoBand ? ', placing it in ' : 'in '}${eco?.label || 'an ecosystem'} for management pricing. The tier you pick sets how often I update your sites, how fast I respond when something breaks, and how many hands-on hours per month sit in your pool.`,
    ],
    what_i_recommend_paragraphs: [
      sites === 1
        ? `<strong>Web Management</strong> for the site. The fee covers hosting, daily backups, security and uptime monitoring, software updates at the contracted cadence, and a pool of hands-on hours for site work. Unused hours do not roll over; that is the trade for a predictable monthly.`
        : `<strong>Web Management</strong> for all ${sites} sites under one engagement. The multi-site formula applies to monthly fees (additional sites at 80 percent of the base); takeover onboarding is per-site at the full ecosystem base, because each site is its own audit.`,
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
    const step: ProposalStep = {
      id: 'wm_tier',
      type: 'tier_picker',
      h2: 'Pick a Web Management level',
      prompt: `Good, Better, or Best for Web Management. The level sets how often I update your sites, how fast I respond when something breaks, and how many hands-on hours per month sit in your pool.`,
      options: [
        buildTierOption({ tierId: 'good', ecosystem: eco, sites }),
        buildTierOption({ tierId: 'better', ecosystem: eco, sites }),
        buildTierOption({ tierId: 'best', ecosystem: eco, sites }),
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
    const sites = numberFromVar(ctx.variables.site_count, 1);
    const monthly = computeMultiSiteMonthly(tier.monthly, sites);
    const onb = computeMultiSiteOnboarding(tier.onb, sites);
    return {
      monthly,
      oneTime: onb,
      breakdown: [
        { label: `Web Management onboarding (${sites === 1 ? '1 site' : `${sites} sites`}, ${tier.name})`, amount: onb },
      ],
      displaySummary: {
        tier_name: tier.name,
        ecosystem_label: eco.label,
        sites_text: sites === 1 ? '1 site' : `${sites} sites`,
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
    const sites = numberFromVar(ctx.variables.site_count, 1);
    // Sites are left as placeholders here; the wizard does not collect
    // per-domain names yet (v2 work). Schedule A admin editor or the
    // override path can fill them.
    const siteRows = Array.from({ length: sites }, (_, i) => ({
      domain: i === 0 ? '(primary domain confirmed at signing)' : `(additional site ${i + 1} domain confirmed at signing)`,
      description: '',
    }));
    return {
      products_purchased: { web_management: true },
      web_management: {
        tier_name: tier.name,
        sites: siteRows,
        site_count: sites,
        monthly_base: tier.monthly || 0,
        monthly_total: Math.round(pricing.monthly),
        included_hours: tier.hours || 0,
        onboarding_fee: tier.onb || 0, // base, not the multi-site total
        update_cadence: tier.update_cadence || 'monthly',
        response_time: tier.response_time || 'standard tier response window',
        quarterly_training_sessions: tier.training_sessions ?? null,
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
