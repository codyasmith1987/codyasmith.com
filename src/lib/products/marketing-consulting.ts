// Marketing Consulting product definition.
//
// Three ecosystems (A small, B mid, C large) routed by client annual
// revenue, three tiers (Good / Better / Best) per ecosystem. Marketing
// Consulting is broader-advisory in practice: marketing, search and
// content strategy, brand, operations, and growth, advise and recommend
// only, never execute.
//
// The structure is deliberately bounded (per the May 2026 lessons: the
// prior open-ended consulting scope let a client request unlimited
// advisories). Each tier caps direct phone access, the scheduled call,
// research advisories, and reporting. Better and Best run research
// advisories whose outputs and methodology remain the Practice's
// property (see MC_RESEARCH_OWNERSHIP_CLAUSE). Best adds operations
// consulting at Ecosystem B and C only.

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
        access_pool: 'up to one hour a month',
        call_frequency: 'one 30-minute strategy call a month',
        advisories: 'none at this level',
        reporting: 'not included',
        portal_reporting_access: true,
        operations_consulting: false,
        includes_research: false,
        hiring_guidance: false,
        features: [
          'Up to an hour a month of direct phone time to think a decision through with me, plus a 30-minute strategy call each month.',
          'My read on marketing, search, brand, and the adjacent calls, by conversation.',
          'Full access to your reporting in the portal. No formal research deliverable at this level.',
        ],
      },
      better: {
        id: 'better',
        name: 'Better',
        tagline: 'The flagship consulting cycle.',
        recommended: true,
        monthly: 497,
        audit: 1500,
        access_pool: 'up to ninety minutes a month',
        call_frequency: 'one 60-minute strategy call a month',
        advisories: 'one research advisory a month',
        reporting: 'monthly',
        portal_reporting_access: true,
        operations_consulting: false,
        includes_research: true,
        hiring_guidance: false,
        features: [
          'One research-backed advisory a month: a real question taken apart, with competitive, search, and market data behind the answer.',
          'Up to ninety minutes a month of direct phone time, plus a 60-minute strategy call each month.',
          'Full reporting access in the portal and a monthly performance report.',
        ],
      },
      best: {
        id: 'best',
        name: 'Best',
        tagline: 'The deepest cycle. Two advisories a month.',
        monthly: 797,
        audit: 2500,
        access_pool: 'up to two hours a month',
        call_frequency: 'one 90-minute strategy call a month',
        advisories: 'up to two research advisories a month',
        reporting: 'monthly',
        portal_reporting_access: true,
        operations_consulting: false,
        includes_research: true,
        hiring_guidance: false,
        features: [
          'Up to two research-backed advisories a month on the questions that move the business.',
          'Up to two hours a month of direct phone time, plus a 90-minute strategy call each month.',
          'Full reporting access and a monthly performance report. You can keep the research output; the research itself and the methods behind it stay mine.',
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
        access_pool: 'up to one hour a month',
        call_frequency: 'one 30-minute strategy call a month',
        advisories: 'none at this level',
        reporting: 'not included',
        portal_reporting_access: true,
        operations_consulting: false,
        includes_research: false,
        hiring_guidance: false,
        features: [
          'Up to an hour a month of direct phone time to think a decision through with me, plus a 30-minute strategy call each month.',
          'My read on marketing, search, brand, and the adjacent calls, by conversation.',
          'Full access to your reporting in the portal. No formal research deliverable at this level.',
        ],
      },
      better: {
        id: 'better',
        name: 'Better',
        tagline: 'The flagship consulting cycle.',
        recommended: true,
        monthly: 997,
        audit: 2500,
        access_pool: 'up to ninety minutes a month',
        call_frequency: 'one 60-minute strategy call a month',
        advisories: 'one research advisory a month',
        reporting: 'monthly',
        portal_reporting_access: true,
        operations_consulting: false,
        includes_research: true,
        hiring_guidance: false,
        features: [
          'One research-backed advisory a month: a real question taken apart, with competitive, search, and market data behind the answer.',
          'Up to ninety minutes a month of direct phone time, plus a 60-minute strategy call each month.',
          'Full reporting access in the portal and a monthly performance report.',
        ],
      },
      best: {
        id: 'best',
        name: 'Best',
        tagline: 'The deepest cycle. Operations consulting included.',
        monthly: 1497,
        audit: 4000,
        access_pool: 'up to two hours a month',
        call_frequency: 'one 90-minute strategy call a month',
        advisories: 'up to two research advisories a month',
        reporting: 'monthly',
        portal_reporting_access: true,
        operations_consulting: true,
        includes_research: true,
        hiring_guidance: false,
        features: [
          'Up to two research-backed advisories a month on the questions that move the business.',
          'Up to two hours a month of direct phone time, plus a 90-minute strategy call each month.',
          'Operations consulting on workflows, tooling, and the calls that come with growth, including bringing roles in-house.',
          'Full reporting access and a monthly performance report. You can keep the research output; the research itself and the methods behind it stay mine.',
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
        access_pool: 'up to one hour a month',
        call_frequency: 'one 30-minute strategy call a month',
        advisories: 'none at this level',
        reporting: 'not included',
        portal_reporting_access: true,
        operations_consulting: false,
        includes_research: false,
        hiring_guidance: false,
        features: [
          'Up to an hour a month of direct phone time to think a decision through with me, plus a 30-minute strategy call each month.',
          'My read on marketing, search, brand, and the adjacent calls, by conversation.',
          'Full access to your reporting in the portal. No formal research deliverable at this level.',
        ],
      },
      better: {
        id: 'better',
        name: 'Better',
        tagline: 'The flagship consulting cycle.',
        recommended: true,
        monthly: 2497,
        audit: 6000,
        access_pool: 'up to ninety minutes a month',
        call_frequency: 'one 60-minute strategy call a month',
        advisories: 'one research advisory a month',
        reporting: 'monthly',
        portal_reporting_access: true,
        operations_consulting: false,
        includes_research: true,
        hiring_guidance: false,
        features: [
          'One research-backed advisory a month: a real question taken apart, with competitive, search, and market data behind the answer.',
          'Up to ninety minutes a month of direct phone time, plus a 60-minute strategy call each month.',
          'Full reporting access in the portal and a monthly performance report.',
        ],
      },
      best: {
        id: 'best',
        name: 'Best',
        tagline: 'The deepest cycle. Operations consulting included.',
        monthly: 3997,
        audit: 10000,
        access_pool: 'up to two hours a month',
        call_frequency: 'one 90-minute strategy call a month',
        advisories: 'up to two research advisories a month',
        reporting: 'monthly',
        portal_reporting_access: true,
        operations_consulting: true,
        includes_research: true,
        hiring_guidance: false,
        features: [
          'Up to two research-backed advisories a month on the questions that move the business.',
          'Up to two hours a month of direct phone time, plus a 90-minute strategy call each month.',
          'Operations consulting on workflows, tooling, and the calls that come with growth, including bringing roles in-house.',
          'Full reporting access and a monthly performance report. You can keep the research output; the research itself and the methods behind it stay mine.',
        ],
      },
      custom: { id: 'custom', name: 'Custom' },
    },
  },
};

// =========================================================================
// Contract clauses (Schedule A). Modeled on WM_ECOSYSTEM_CLAUSE: the MC
// contribution sets these strings; the contract renderer prints them
// verbatim as gated Schedule A clauses. Party terms: "the Practice" =
// Cody A Smith LLC, "the Client" = the buyer (standard-v5.md section 1).
// =========================================================================

// Consulting scope and limits. Closes the open-ended-scope gap from the
// May 2026 lessons by tying what is included to the specific caps set for
// the purchased tier in Schedule A, and routing anything beyond to a
// quote. Set whenever Marketing Consulting is purchased.
export const MC_SCOPE_CLAUSE = 'Marketing Consulting is advisory. The Practice provides strategy, research, and recommendations and does not execute on them. The engagement includes only what is set for the chosen level in this Schedule: the monthly direct phone access, the scheduled strategy call, the number of research advisories, the reporting, and, where included, operations consulting. The monthly fee secures the Practice\'s attention and thinking for that defined cadence, not unlimited production. Any request beyond it, including additional research advisories, additional access, or execution of any recommendation, is new work that the Practice scopes and quotes before any work begins, under the change-order mechanism in section 8.';

// Research ownership and methodology. Closes the "nothing protects the
// Practice's methods/tools as property" and "deliverables ownership
// written too broadly" gaps. Set only when the tier includes research
// advisories (Better and Best).
export const MC_RESEARCH_OWNERSHIP_CLAUSE = 'Research advisories, the analysis behind them, and the methods, frameworks, tools, and processes the Practice uses to produce them are and remain the sole property of the Practice. The Client receives the Practice\'s recommendations, and at the Best level may receive the research output itself for the Client\'s internal use. That delivery grants the Client a license to use the output for its own business and transfers no ownership. The Client acquires no right in the Practice\'s research methodology, data models, or process, and may not reproduce, resell, license, or repackage them.';

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

function buildTierOption(tierId: TierId, ecosystem: Ecosystem, aiRecommendedTier?: TierId | null, aiRecommendedRationale?: string, waiveOnboarding?: boolean): ProposalStepOption {
  const tier = ecosystem.tiers[tierId];
  // AI's per-prospect tier recommendation overrides the static product
  // default (Better is recommended at every ecosystem). When no AI rec
  // exists, fall back to the product's own `recommended` flag. Per
  // finding 3.
  const recommended = aiRecommendedTier
    ? aiRecommendedTier === tierId
    : !!tier.recommended;
  // Per audit move 5: surface AI rationale on the recommended card.
  const showRationale = aiRecommendedTier
    && aiRecommendedTier === tierId
    && typeof aiRecommendedRationale === 'string'
    && aiRecommendedRationale.trim().length > 0;
  return {
    id: tierId,
    name: tier.name,
    tagline: tier.tagline,
    recommended,
    recommended_rationale: showRationale ? aiRecommendedRationale!.trim() : undefined,
    price_label: formatMoney(tier.monthly || 0),
    price_suffix: '/ month',
    price_subline: waiveOnboarding
      ? `Waived for existing client`
      : `${formatMoney(tier.audit || 0)} at signing`,
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
  const hasWebManagement = ctx.otherProducts.some(p => p.id === 'web-management');

  const recommendation = hasWebManagement
    ? `<strong>Marketing Consulting</strong> on top of Web Management. The consulting product is strategy and recommendation applied to the whole business, not the sites. I cover marketing, search and content strategy, brand positioning, and adjacent advisory like operations or hiring guidance when you want outside thinking. It is advice only; execution routes through Web Management hours or a separate statement of work.`
    : `<strong>Marketing Consulting</strong> as a standalone engagement. Strategy and recommendation applied to the whole business: marketing, search and content strategy, brand positioning, plus adjacent advisory like operations, hiring guidance, or vendor selection. It is advice only; if you want me to execute on a recommendation, that gets scoped separately.`;

  // Engagement-strategy adaptation. One optional sentence appended
  // when the synthesis points to a clear consulting shape. Does NOT
  // name tiers; steers the framing.
  const what_i_see_paragraphs: string[] = [
    `The tier you pick sets the depth of the cycle: how much direct access you have to me, how many research advisories I run each month, and whether a monthly performance report is in scope.`,
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
      `Marketing Consulting is strategic advisory applied to your business.`,
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
    // Per audit move 5: AI rationale on the recommended card.
    const aiRecommendedRationale = ctx.engagementStrategy?.recommended_tier_per_product?.marketing_consulting?.rationale;
    // Reissue waiver: the initial fee is already paid/on file, so tier
    // cards must not promise it as a new charge while it is priced $0.
    const waiveOnboarding = ctx.waiveOnboarding === true;

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
            buildTierOption('good', eco, aiRecommendedTier, aiRecommendedRationale, waiveOnboarding),
            buildTierOption('better', eco, aiRecommendedTier, aiRecommendedRationale, waiveOnboarding),
            buildTierOption('best', eco, aiRecommendedTier, aiRecommendedRationale, waiveOnboarding),
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
            html: `Keep the engagement focused on the other products picked above. You can add Marketing Consulting later at any time, with no new contract required.`,
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
          buildTierOption('good', eco, aiRecommendedTier, aiRecommendedRationale, waiveOnboarding),
          buildTierOption('better', eco, aiRecommendedTier, aiRecommendedRationale, waiveOnboarding),
          buildTierOption('best', eco, aiRecommendedTier, aiRecommendedRationale, waiveOnboarding),
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
    // Reissue / already-onboarded: zero the initial fee. The retainer is
    // unaffected. A labeled $0 line keeps the waiver visible.
    const waived = ctx.waiveOnboarding === true;
    const finalAudit = waived ? 0 : tier.audit;
    const auditLabel = waived
      ? `Marketing Consulting fee at signing (waived, existing client)`
      : `Marketing Consulting ${tier.name} fee at signing`;
    return {
      monthly: tier.monthly,
      oneTime: finalAudit,
      breakdown: [
        { label: auditLabel, amount: finalAudit },
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
        // Reissue / already-onboarded waiver zeros the initial fee so
        // Schedule A's A.6 agrees with the at-signing block.
        initial_audit_fee: ctx.waiveOnboarding === true ? 0 : (tier.audit || 0),
        access_pool: tier.access_pool || '',
        strategy_call_frequency: tier.call_frequency || 'as agreed',
        deep_advisories_per_cycle: tier.advisories || 'none',
        performance_reporting_cadence: tier.reporting || 'not included',
        portal_reporting_access: tier.portal_reporting_access !== false,
        operations_consulting: !!tier.operations_consulting,
      },
      // Scope-limit clause always; research-ownership clause only when the
      // tier actually runs research advisories (Better and Best).
      mc_scope_clause: MC_SCOPE_CLAUSE,
      mc_research_ownership_clause: tier.includes_research ? MC_RESEARCH_OWNERSHIP_CLAUSE : undefined,
    };
  },
};
