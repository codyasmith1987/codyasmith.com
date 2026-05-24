// Marketing Consulting product definition.
//
// Encodes business-design-v2 Section 4: three ecosystems (A small, B
// mid, C large) routed by client annual revenue, three tiers (Good /
// Better / Best) per ecosystem. Per 04 Section 3, Marketing Consulting
// is "broader-advisory in practice" — it covers marketing, operations,
// hiring guidance, and vendor selection, not just marketing topics.
// The format constraint is advise/strategize/recommend, never execute.

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

export const MC_ECOSYSTEMS: Record<EcosystemId, Ecosystem> = {
  A: {
    id: 'A',
    label: 'Ecosystem A',
    band: 'Under $1M annual revenue',
    tiers: {
      good: {
        id: 'good',
        name: 'Good',
        tagline: 'The lightest consulting engagement.',
        monthly: 297,
        audit: 750,
        call_frequency: 'no scheduled call; written advisories on request',
        advisories: 'one or two per quarter as requested',
        reporting: 'not included',
        hiring_guidance: false,
        features: [
          'A baseline competitive and keyword read at the start of the engagement.',
          'Written advisories on request, no fixed monthly cadence.',
          'Designed to open the door; most clients move up once the cycle is real.',
        ],
      },
      better: {
        id: 'better',
        name: 'Better',
        tagline: 'The flagship consulting cycle.',
        recommended: true,
        monthly: 497,
        audit: 1500,
        call_frequency: 'one 30-minute call per month',
        advisories: 'one per quarter',
        reporting: 'quarterly',
        hiring_guidance: false,
        features: [
          'A research-grade audit at the start, then a quarterly cycle of competitive analysis, SEO and content roadmap, and brand positioning.',
          'A 30-minute monthly strategy call. Quarterly performance reporting.',
          'For a business that is actively trying to grow.',
        ],
      },
      best: {
        id: 'best',
        name: 'Best',
        tagline: 'Monthly cycle. Hiring guidance included.',
        monthly: 797,
        audit: 2500,
        call_frequency: 'one 60-minute call per month',
        advisories: 'one per month',
        reporting: 'monthly',
        hiring_guidance: true,
        features: [
          'The deepest audit at the start, then a monthly cycle of competitive analysis, SEO and content roadmap, and ongoing brand work.',
          'A 60-minute strategy call every month. Monthly performance reporting.',
          'Hiring guidance when you bring marketing or web roles in-house.',
        ],
      },
      custom: { id: 'custom', name: 'Custom' },
    },
  },
  B: {
    id: 'B',
    label: 'Ecosystem B',
    band: '$1M to $10M annual revenue',
    tiers: {
      good: {
        id: 'good',
        name: 'Good',
        tagline: 'The lightest consulting engagement.',
        monthly: 497,
        audit: 1500,
        call_frequency: 'no scheduled call; written advisories on request',
        advisories: 'one or two per quarter as requested',
        reporting: 'not included',
        hiring_guidance: false,
        features: [
          'A baseline competitive and keyword read at the start of the engagement.',
          'Written advisories on request, no fixed monthly cadence.',
          'Designed to open the door; most clients move up once the cycle is real.',
        ],
      },
      better: {
        id: 'better',
        name: 'Better',
        tagline: 'The flagship consulting cycle.',
        recommended: true,
        monthly: 997,
        audit: 2500,
        call_frequency: 'one 30-minute call per month',
        advisories: 'one per quarter',
        reporting: 'quarterly',
        hiring_guidance: false,
        features: [
          'A research-grade audit at the start, then a quarterly cycle of competitive analysis, SEO and content roadmap, and brand positioning.',
          'A 30-minute monthly strategy call. Quarterly performance reporting.',
          'For a business that is actively trying to grow.',
        ],
      },
      best: {
        id: 'best',
        name: 'Best',
        tagline: 'Monthly cycle. Hiring guidance included.',
        monthly: 1497,
        audit: 4000,
        call_frequency: 'one 60-minute call per month',
        advisories: 'one per month',
        reporting: 'monthly',
        hiring_guidance: true,
        features: [
          'The deepest audit at the start, then a monthly cycle of competitive analysis, SEO and content roadmap, and ongoing brand work.',
          'A 60-minute strategy call every month. Monthly performance reporting.',
          'Hiring guidance when you bring marketing or web roles in-house.',
        ],
      },
      custom: { id: 'custom', name: 'Custom' },
    },
  },
  C: {
    id: 'C',
    label: 'Ecosystem C',
    band: '$10M or more annual revenue',
    tiers: {
      good: {
        id: 'good',
        name: 'Good',
        tagline: 'The lightest consulting engagement.',
        monthly: 1497,
        audit: 4000,
        call_frequency: 'no scheduled call; written advisories on request',
        advisories: 'one or two per quarter as requested',
        reporting: 'not included',
        hiring_guidance: false,
        features: [
          'A baseline competitive and keyword read at the start of the engagement.',
          'Written advisories on request, no fixed monthly cadence.',
          'Designed to open the door; most clients move up once the cycle is real.',
        ],
      },
      better: {
        id: 'better',
        name: 'Better',
        tagline: 'The flagship consulting cycle.',
        recommended: true,
        monthly: 2497,
        audit: 6000,
        call_frequency: 'one 30-minute call per month',
        advisories: 'one per quarter',
        reporting: 'quarterly',
        hiring_guidance: false,
        features: [
          'A research-grade audit at the start, then a quarterly cycle of competitive analysis, SEO and content roadmap, and brand positioning.',
          'A 30-minute monthly strategy call. Quarterly performance reporting.',
          'For a business that is actively trying to grow.',
        ],
      },
      best: {
        id: 'best',
        name: 'Best',
        tagline: 'Monthly cycle. Hiring guidance included.',
        monthly: 3997,
        audit: 10000,
        call_frequency: 'one 60-minute call per month',
        advisories: 'one per month',
        reporting: 'monthly',
        hiring_guidance: true,
        features: [
          'The deepest audit at the start, then a monthly cycle of competitive analysis, SEO and content roadmap, and ongoing brand work.',
          'A 60-minute strategy call every month. Monthly performance reporting.',
          'Hiring guidance when you bring marketing or web roles in-house.',
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
    id: 'revenue_band',
    label: 'Annual revenue band',
    type: 'select',
    options: [
      { id: 'under-1m', label: 'Under $1M' },
      { id: '1m-to-10m', label: '$1M to $10M' },
      { id: 'over-10m', label: '$10M or more' },
    ],
    default: null,
    help: 'Marketing Consulting prices route by client revenue. Pick the band; the system selects Ecosystem A, B, or C.',
  },
];

// =========================================================================
// Routing
// =========================================================================

export function routeMarketingConsultingEcosystem(revenueBand: string | null): EcosystemId | null {
  if (revenueBand === 'under-1m') return 'A';
  if (revenueBand === '1m-to-10m') return 'B';
  if (revenueBand === 'over-10m') return 'C';
  return null;
}

// =========================================================================
// Step generation
// =========================================================================

function buildTierOption(tierId: TierId, ecosystem: Ecosystem, aiRecommendedTier?: TierId | null): ProposalStepOption {
  const tier = ecosystem.tiers[tierId];
  // AI's per-prospect tier recommendation overrides the static product
  // default (Better is recommended at every ecosystem). When no AI rec
  // exists, fall back to the product's own `recommended` flag. Per
  // finding 3.
  const recommended = aiRecommendedTier
    ? aiRecommendedTier === tierId
    : !!tier.recommended;
  return {
    id: tierId,
    name: tier.name,
    tagline: tier.tagline,
    recommended,
    price_label: formatMoney(tier.monthly || 0),
    price_suffix: '/ month',
    price_subline: `${formatMoney(tier.audit || 0)} audit at signing, ${ecosystem.label}`,
    features: tier.features ? [...tier.features] : [],
  };
}

function formatMoney(n: number): string {
  return '$' + Math.round(n).toLocaleString('en-US');
}

// =========================================================================
// Narrative snippets
// =========================================================================

function buildMarketingConsultingNarrative(ctx: ProductContext): NarrativeSnippetSet {
  const ecoId = ctx.ecosystemId || 'B';
  const eco = MC_ECOSYSTEMS[ecoId];
  const ecoBand = eco?.band || '';
  const hasWebManagement = ctx.otherProducts.some(p => p.id === 'web-management');

  const recommendation = hasWebManagement
    ? `<strong>Marketing Consulting</strong> on top of Web Management. The consulting product is strategy and recommendation applied to the whole business, not the sites. I cover marketing, search and content strategy, brand positioning, and adjacent advisory like operations or hiring guidance when you want outside thinking. It is advice only; execution routes through Web Management hours or a separate statement of work.`
    : `<strong>Marketing Consulting</strong> as a standalone engagement. Strategy and recommendation applied to the whole business: marketing, search and content strategy, brand positioning, plus adjacent advisory like operations, hiring guidance, or vendor selection. It is advice only; if you want me to execute on a recommendation, that gets scoped separately.`;

  // Engagement-strategy adaptation. One optional sentence appended
  // when the synthesis points to a clear consulting shape. Does NOT
  // name tiers; steers the framing.
  const what_i_see_paragraphs: string[] = [
    `Your business sits in ${eco?.label || 'the consulting ecosystem'}${ecoBand ? ` (${ecoBand})` : ''}. The tier you pick sets the depth of the cycle: how often we meet, how many deep advisories per cycle, and whether monthly performance reporting is in scope.`,
  ];
  const strategy = ctx.engagementStrategy;
  if (strategy?.clv_horizon === 'long-term-stable') {
    what_i_see_paragraphs.push(
      `The shape that fits a steady business is the outside thinker you call when a decision needs sharper context than the room can produce. The cycle is built around that pattern.`
    );
  } else if (strategy?.cody_time_intensity === 'low' && strategy?.clv_horizon !== 'churn-risk') {
    what_i_see_paragraphs.push(
      `Consulting works best when the decision needs thinking, not hands. You ask, I research and recommend, you decide. The fee buys attention and research, not unlimited production.`
    );
  }

  return {
    intro_lines: [
      `Marketing Consulting is strategic advisory applied to your business${ecoBand ? `, priced for the ${ecoBand} band` : ''}.`,
    ],
    what_i_see_paragraphs,
    what_i_recommend_paragraphs: [recommendation],
  };
}

// =========================================================================
// Product definition
// =========================================================================

export const marketingConsultingProduct: ProductDefinition = {
  id: 'marketing-consulting',
  name: 'Marketing Consulting',
  short_name: 'Marketing Consulting',

  variableSchema: VARIABLE_SCHEMA,

  ecosystems: MC_ECOSYSTEMS,

  routeEcosystem(variables) {
    const band = typeof variables.revenue_band === 'string' ? variables.revenue_band : null;
    return routeMarketingConsultingEcosystem(band);
  },

  generateSteps(ctx) {
    if (!ctx.ecosystemId) return [];
    const eco = MC_ECOSYSTEMS[ctx.ecosystemId];
    if (!eco) return [];

    // AI's per-prospect tier recommendation, if any, overrides the
    // static "Better is recommended for everyone" default in the
    // tier definition. Per finding 3.
    const aiTier = ctx.engagementStrategy?.recommended_tier_per_product?.marketing_consulting?.tier;
    const aiRecommendedTier = aiTier === 'good' || aiTier === 'better' || aiTier === 'best'
      ? aiTier as TierId
      : null;

    // If MC is the only product in scope, present a single tier_picker.
    // If other products are also in scope, present a yes/no first
    // (binary_picker) followed by a gated tier_picker. The yes/no
    // structure matches the existing Raised Bar flow and gives the
    // prospect the option to skip consulting without abandoning the
    // proposal.
    const isOnly = ctx.otherProducts.length === 0;
    if (isOnly) {
      return [
        {
          id: 'mc_tier',
          type: 'tier_picker',
          h2: 'Pick a Marketing Consulting level',
          prompt: `Good, Better, or Best for Marketing Consulting. The level sets the cadence and depth of the strategic cycle.`,
          options: [
            buildTierOption('good', eco, aiRecommendedTier),
            buildTierOption('better', eco, aiRecommendedTier),
            buildTierOption('best', eco, aiRecommendedTier),
          ],
        },
      ];
    }

    return [
      {
        id: 'mc_yes_no',
        type: 'binary_picker',
        h2: 'Add Marketing Consulting?',
        prompt: `Marketing Consulting is sold once for the whole business and is advice only. You can add it now or skip it; either keeps the rest of the engagement intact.`,
        options: [
          {
            id: 'no',
            name: 'Skip Marketing Consulting for now',
            html: `Keep the engagement focused on the other products picked above. You can add Marketing Consulting later at any time without re-papering.`,
          },
          {
            id: 'yes',
            name: 'Add Marketing Consulting',
            html: `Add strategic advisory across marketing, search and content strategy, brand positioning, and adjacent topics like operations or hiring guidance. Advice only, never execution.`,
          },
        ],
      },
      {
        id: 'mc_tier',
        type: 'tier_picker',
        h2: 'Pick a Marketing Consulting level',
        prompt: 'Choose the cycle that fits.',
        depends_on: 'mc_yes_no',
        show_when: { mc_yes_no: 'yes' },
        options: [
          buildTierOption('good', eco, aiRecommendedTier),
          buildTierOption('better', eco, aiRecommendedTier),
          buildTierOption('best', eco, aiRecommendedTier),
        ],
      },
    ];
  },

  generateNarrativeSnippets(ctx) {
    return buildMarketingConsultingNarrative(ctx);
  },

  computePricing(ctx) {
    if (!ctx.ecosystemId || !ctx.tierId) {
      return { monthly: 0, oneTime: 0, breakdown: [], displaySummary: {} };
    }
    const eco = MC_ECOSYSTEMS[ctx.ecosystemId];
    if (!eco) return { monthly: 0, oneTime: 0, breakdown: [], displaySummary: {} };
    const tier = eco.tiers[ctx.tierId];
    if (!tier || tier.monthly == null || tier.audit == null) {
      return { monthly: 0, oneTime: 0, breakdown: [], displaySummary: {} };
    }
    return {
      monthly: tier.monthly,
      oneTime: tier.audit,
      breakdown: [
        { label: `Marketing Consulting ${tier.name} initial audit (${eco.label})`, amount: tier.audit },
      ],
      displaySummary: {
        tier_name: tier.name,
        ecosystem_label: eco.label,
      },
    };
  },

  buildScheduleAContribution(ctx, _pricing) {
    if (!ctx.ecosystemId || !ctx.tierId) {
      return { products_purchased: { marketing_consulting: false } };
    }
    const eco = MC_ECOSYSTEMS[ctx.ecosystemId];
    const tier = eco?.tiers[ctx.tierId];
    if (!tier) return { products_purchased: { marketing_consulting: false } };
    return {
      products_purchased: { marketing_consulting: true },
      marketing_consulting: {
        tier_name: tier.name,
        monthly_retainer: tier.monthly || 0,
        initial_audit_fee: tier.audit || 0,
        strategy_call_frequency: tier.call_frequency || 'as agreed',
        deep_advisories_per_cycle: tier.advisories || 'as requested',
        performance_reporting_cadence: tier.reporting || 'as agreed',
        hiring_guidance: !!tier.hiring_guidance,
      },
    };
  },
};
