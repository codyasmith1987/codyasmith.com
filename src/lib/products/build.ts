// Build product definition.
//
// Project pricing per build-and-rush-pricing.md and 05 Section 2.
// Fixed-fee per site by size band. Replaces onboarding for the site it
// produces. Site moves to Web Management retainer at launch. Subsequent
// builds in the same engagement at 20 percent off the first.
//
// Per Cody's directive: site_setup-style binary pickers are NOT a
// primary step. They only appear when Build is in scope AND the build
// has multiple deployment shapes (the Raised Bar pattern). For v1,
// default builds generate ZERO interactive steps; admin can add a
// multi-config option set via the wizard's override step if needed.

import type {
  ProductDefinition,
  ProductContext,
  Ecosystem,
  EcosystemId,
  ProductVariables,
  ProductPricingContribution,
  ProductScheduleAContribution,
  NarrativeSnippetSet,
  VariableSchemaField,
  BuildOption,
  ProposalStep,
  NarrativeScenario,
} from './types';

// =========================================================================
// Size bands
// =========================================================================

export const BUILD_SIZES: Record<EcosystemId, Ecosystem> = {
  small: {
    id: 'small',
    label: 'Small build (under 30 pages)',
    band: 'Under 30 pages',
    tiers: {
      good: { id: 'good', name: 'Small build', monthly: 0, onb: 5625 },
      better: { id: 'better', name: 'Small build' },
      best: { id: 'best', name: 'Small build' },
      custom: { id: 'custom', name: 'Custom' },
    },
  },
  mid: {
    id: 'mid',
    label: 'Mid build (30 to 150 pages)',
    band: '30 to 150 pages',
    tiers: {
      good: { id: 'good', name: 'Mid build', monthly: 0, onb: 11875 },
      better: { id: 'better', name: 'Mid build' },
      best: { id: 'best', name: 'Mid build' },
      custom: { id: 'custom', name: 'Custom' },
    },
  },
  large: {
    id: 'large',
    label: 'Large build (150 or more pages)',
    band: '150 or more pages',
    tiers: {
      good: { id: 'good', name: 'Large build', monthly: 0, onb: 22500 },
      better: { id: 'better', name: 'Large build' },
      best: { id: 'best', name: 'Large build' },
      custom: { id: 'custom', name: 'Custom' },
    },
  },
};

const BUILD_FEES: Record<string, number> = {
  small: 5625,
  mid: 11875,
  large: 22500,
};

const SUBSEQUENT_BUILD_DISCOUNT = 0.20; // 20% off for builds 2+

// =========================================================================
// Variable schema
// =========================================================================

const VARIABLE_SCHEMA: VariableSchemaField[] = [
  {
    id: 'build_total_pages',
    label: 'Total pages for the build (estimate)',
    type: 'number',
    default: null,
    help: 'Type a number. Could be 4, could be 43. Routes to the build size band: under 30 = Small ($5,625), 30-150 = Mid ($11,875), 150 or more = Large ($22,500). Used as the default 1-build size when no shape options are defined; shape options override this with their own per-site page counts.',
  },
  {
    id: 'build_description',
    label: 'What is being built (brief)',
    type: 'text',
    default: '',
    help: 'One sentence the proposal narrative carries. Schedule A references a separate Build Statement of Work for full scope.',
  },
];

// =========================================================================
// Routing
// =========================================================================

export function routeBuildSize(variables: ProductVariables): EcosystemId | null {
  // Legacy explicit picker still wins if set (back-compat with older
  // proposals saved before the page-count migration).
  const size = typeof variables.build_size === 'string' ? variables.build_size : null;
  if (size === 'small' || size === 'mid' || size === 'large') return size;
  // Derive from total pages: under 30 = small, 30-150 = mid, 150+ = large.
  const pages = typeof variables.build_total_pages === 'number'
    ? variables.build_total_pages
    : (typeof variables.build_total_pages === 'string' ? parseInt(variables.build_total_pages, 10) : NaN);
  if (Number.isFinite(pages) && pages > 0) {
    if (pages < 30) return 'small';
    if (pages <= 150) return 'mid';
    return 'large';
  }
  return null;
}

// =========================================================================
// Pricing math
// =========================================================================

export function computeBuildTotal(size: string | null, count: number): number {
  if (!size || !(size in BUILD_FEES)) return 0;
  const n = Math.max(1, Math.floor(count));
  const base = BUILD_FEES[size];
  if (n === 1) return base;
  // First build at full; subsequent at (1 - discount) each.
  const subsequent = (n - 1) * base * (1 - SUBSEQUENT_BUILD_DISCOUNT);
  return base + subsequent;
}

// =========================================================================
// Narrative snippets
// =========================================================================

function buildNarrative(ctx: ProductContext): NarrativeSnippetSet {
  const desc = typeof ctx.variables.build_description === 'string' ? ctx.variables.build_description : '';

  // Build price and per-option detail live on the build option cards (see
  // generateSteps), not in this narrative. The paragraph just frames the
  // build and how it hands off to Web Management.
  const whatRecommend = `<strong>Build work</strong> for the site${desc ? ' (' + desc + ')' : ''}. A fixed-fee project; the build replaces onboarding for the site it produces, and the site moves onto Web Management at launch.`;

  return {
    intro_lines: [`A net-new build is part of the engagement.`],
    what_i_recommend_paragraphs: [whatRecommend],
  };
}

function numberFromVar(v: ProductVariables[string] | undefined, dflt: number): number {
  if (v === null || v === undefined) return dflt;
  if (typeof v === 'number') return v;
  if (Array.isArray(v)) return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

// Read the BuildOption array off ctx.variables.build_options.
// Returns the array only when at least two options are present
// (single-option Build means no picker; no point in a 1-card chooser).
// Tolerates the field being absent, null, or not an array.
function getBuildOptions(ctx: ProductContext): BuildOption[] {
  const raw = ctx.variables.build_options;
  if (!Array.isArray(raw)) return [];
  const valid = raw.filter((o): o is BuildOption =>
    !!o && typeof o === 'object'
    && typeof (o as any).id === 'string' && (o as any).id.length > 0
    && typeof (o as any).name === 'string'
  );
  return valid.length >= 2 ? valid : [];
}

// Resolve the prospect's picked option from ctx.selections. Step id
// for the picker is the Build product's own step id `build_options`.
// Returns the matching BuildOption or null when nothing is picked yet.
function getSelectedBuildOption(ctx: ProductContext): BuildOption | null {
  const options = getBuildOptions(ctx);
  if (options.length === 0) return null;
  const picked = ctx.selections?.['build_options'];
  if (!picked) return null;
  return options.find(o => o.id === picked) || null;
}

// =========================================================================
// Product definition
// =========================================================================

export const buildProduct: ProductDefinition = {
  id: 'build',
  name: 'Build work',
  short_name: 'Build',

  variableSchema: VARIABLE_SCHEMA,

  ecosystems: BUILD_SIZES,

  routeEcosystem(variables) {
    return routeBuildSize(variables);
  },

  generateSteps(ctx) {
    // Default builds generate no interactive step. The fee is fixed
    // once size is picked; the prospect does not choose between tiers.
    //
    // Multi-option builds (Raised Bar pattern) emit a binary or
    // multi-option picker when ctx.variables.build_options has 2+
    // entries. Each option becomes a card with name + pitch HTML;
    // the picker step id is `build_options`. See finding 7 in
    // docs/audits/proposal-chain-audit-2026-05-24.md.
    const options = getBuildOptions(ctx);
    if (options.length === 0) return [];

    // Absolute per-option build fee = base (one build at the routed size)
    // + the option's precomputed pricing delta (which carries the full
    // multi-site math for that shape). Surfaced on the card so the buyer
    // sees the real price per option; the narrative no longer carries it.
    const baseTotal = computeBuildTotal(routeBuildSize(ctx.variables), 1);

    const step: ProposalStep = {
      id: 'build_options',
      type: options.length === 2 ? 'binary_picker' : 'tier_picker',
      h2: 'Pick a build approach',
      prompt: 'The build can ship in more than one shape. Pick the option that fits; the pricing and Schedule A will reflect your pick.',
      options: options.map((opt, i) => {
        const optTotal = baseTotal + (typeof opt.pricing_delta === 'number' ? opt.pricing_delta : 0);
        const priceLabel = optTotal > 0 ? formatMoney(optTotal) : undefined;
        return {
          id: opt.id,
          name: opt.name,
          html: opt.pitch,
          recommended: i === 0, // first option is the default recommendation
          price_label: priceLabel,
          price_suffix: priceLabel ? 'one-time build' : undefined,
          price_detail_html: priceLabel ? 'One-time build fee, paid at signing.' : undefined,
        };
      }),
    };
    return [step];
  },

  generateNarrativeSnippets(ctx) {
    const base = buildNarrative(ctx);
    const options = getBuildOptions(ctx);
    if (options.length === 0) return base;

    // Emit rollout_scenarios keyed by the build_options step's option
    // id. The proposal renderer swaps the rollout content based on
    // the prospect's pick on the picker step.
    const scenarios: Record<string, NarrativeScenario> = {};
    for (const opt of options) {
      scenarios[opt.id] = {
        intro_html: opt.rollout_intro_html,
        phases: opt.rollout_phases || [],
        outro_html: opt.rollout_outro_html,
      };
    }
    return {
      ...base,
      rollout_scenarios: scenarios,
      rollout_scenario_step: 'build_options',
    };
  },

  computePricing(ctx) {
    const size = routeBuildSize(ctx.variables);
    // Base is always 1 build at the routed size. When shape options
    // are defined, the picked option's pricing_delta carries the
    // shape's full per-site math relative to this 1-build base.
    const baseTotal = computeBuildTotal(size, 1);
    if (baseTotal === 0) {
      return { monthly: 0, oneTime: 0, breakdown: [], displaySummary: {} };
    }
    const desc = typeof ctx.variables.build_description === 'string' && ctx.variables.build_description
      ? ` (${ctx.variables.build_description})`
      : '';
    const sizeLabel = size === 'small' ? 'small'
      : size === 'mid' ? 'mid'
      : size === 'large' ? 'large'
      : 'unspecified size';
    const breakdown = [{ label: `Build, ${sizeLabel}${desc}`, amount: baseTotal }];

    // Apply pricing delta from picked Build option, if any. The
    // wizard sets this to (option's full build cost) - (1-build base
    // cost) so the math here yields the option's full cost.
    let total = baseTotal;
    const picked = getSelectedBuildOption(ctx);
    if (picked && picked.pricing_delta) {
      total = Math.round((total + picked.pricing_delta) * 100) / 100;
      breakdown.push({
        label: `${picked.name} adjustment`,
        amount: picked.pricing_delta,
      });
    }

    return {
      monthly: 0,
      oneTime: total,
      breakdown,
      displaySummary: {
        size_label: sizeLabel,
        count: '1',
        picked_option_id: picked?.id || '',
      },
    };
  },

  buildScheduleAContribution(ctx, _pricing) {
    const size = routeBuildSize(ctx.variables);
    if (!size) {
      return { products_purchased: { build: false } };
    }
    const desc = typeof ctx.variables.build_description === 'string' ? ctx.variables.build_description : '';
    // Shape options (when picked) carry their own per-site breakdown
    // via schedule_a_note; the base SOW description here is the
    // default 1-build case.
    const itemsClause = `Build in scope: one ${size} build${desc ? ` (${desc})` : ''}.`;

    // Picked option's schedule_a_note appends to the SOW reference so
    // the contract reflects which deployment shape was chosen.
    const picked = getSelectedBuildOption(ctx);
    const optionClause = picked && picked.schedule_a_note
      ? ` ${picked.name}: ${picked.schedule_a_note}`
      : picked
        ? ` Selected option: ${picked.name}.`
        : '';

    return {
      products_purchased: { build: true },
      build_sow_ref: `${itemsClause}${optionClause} Each is detailed in a separate Build Statement of Work to be signed alongside this agreement.`,
    };
  },
};

// Helper used by generateSteps for the per-card pricing-delta subline.
function formatMoney(n: number): string {
  const abs = Math.abs(Math.round(n));
  const sign = n < 0 ? '-' : '';
  return `${sign}$${abs.toLocaleString('en-US')}`;
}
