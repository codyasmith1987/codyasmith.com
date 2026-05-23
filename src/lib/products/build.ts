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
} from './types';

// =========================================================================
// Size bands
// =========================================================================

export const BUILD_SIZES: Record<EcosystemId, Ecosystem> = {
  small: {
    id: 'small',
    label: 'Small build (Ecosystem A)',
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
    label: 'Mid build (Ecosystem B)',
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
    label: 'Large build (Ecosystem C)',
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
    id: 'build_size',
    label: 'Build size',
    type: 'select',
    options: [
      { id: 'small', label: 'Small (under 30 pages, $5,625)' },
      { id: 'mid', label: 'Mid (30-150 pages, $11,875)' },
      { id: 'large', label: 'Large (150 or more, $22,500)' },
    ],
    default: null,
    help: 'Size band sets the fixed fee. Replaces onboarding for the site it produces.',
  },
  {
    id: 'build_count',
    label: 'Number of builds in this engagement',
    type: 'number',
    default: 1,
    help: 'Builds 2 and beyond get a 20 percent discount off the first build size.',
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
  const size = typeof variables.build_size === 'string' ? variables.build_size : null;
  if (size === 'small' || size === 'mid' || size === 'large') return size;
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
  const size = routeBuildSize(ctx.variables);
  const count = numberFromVar(ctx.variables.build_count, 1);
  const desc = typeof ctx.variables.build_description === 'string' ? ctx.variables.build_description : '';

  const sizeLabel = size === 'small' ? 'small (under 30 pages)'
    : size === 'mid' ? 'mid (30-150 pages)'
    : size === 'large' ? 'large (150 or more pages)'
    : 'sized at signing';

  const fee = computeBuildTotal(size, count);
  const feeStr = fee > 0 ? `$${Math.round(fee).toLocaleString('en-US')}` : '';

  const multi = count > 1 ? ` Each subsequent build in this engagement runs at 20 percent off.` : '';

  const whatRecommend = count === 1
    ? `<strong>Build work</strong> for the site${desc ? ' (' + desc + ')' : ''}. Fixed-fee project, ${sizeLabel}${feeStr ? ', total ' + feeStr : ''}. The build replaces onboarding for the site it produces; the site moves onto Web Management at launch.`
    : `<strong>Build work</strong> for ${count} sites${desc ? ' (' + desc + ')' : ''}. Fixed-fee projects, each ${sizeLabel}${feeStr ? ', engagement total ' + feeStr : ''}.${multi} Each build replaces onboarding for its site; the sites move onto Web Management at launch.`;

  return {
    intro_lines: [
      count === 1
        ? `A net-new build is part of the engagement.`
        : `${count} net-new builds are part of the engagement.`,
    ],
    what_i_recommend_paragraphs: [whatRecommend],
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

export const buildProduct: ProductDefinition = {
  id: 'build',
  name: 'Build work',
  short_name: 'Build',

  variableSchema: VARIABLE_SCHEMA,

  ecosystems: BUILD_SIZES,

  routeEcosystem(variables) {
    return routeBuildSize(variables);
  },

  generateSteps(_ctx) {
    // Default builds generate no interactive step. The fee is fixed
    // once size is picked; the prospect does not choose between
    // tiers. Multi-config builds (Raised Bar style) are added via the
    // wizard's preview-override step as an explicit admin extension.
    return [];
  },

  generateNarrativeSnippets(ctx) {
    return buildNarrative(ctx);
  },

  computePricing(ctx) {
    const size = routeBuildSize(ctx.variables);
    const count = numberFromVar(ctx.variables.build_count, 1);
    const total = computeBuildTotal(size, count);
    if (total === 0) {
      return { monthly: 0, oneTime: 0, breakdown: [], displaySummary: {} };
    }
    const desc = typeof ctx.variables.build_description === 'string' && ctx.variables.build_description
      ? ` (${ctx.variables.build_description})`
      : '';
    const sizeLabel = size === 'small' ? 'small'
      : size === 'mid' ? 'mid'
      : size === 'large' ? 'large'
      : 'unspecified size';
    const breakdown = count === 1
      ? [{ label: `Build, ${sizeLabel}${desc}`, amount: total }]
      : [
          { label: `Build, ${sizeLabel}${desc} (build 1)`, amount: BUILD_FEES[size!] },
          { label: `Builds 2-${count}, ${sizeLabel}, 20% off each`, amount: total - BUILD_FEES[size!] },
        ];
    return {
      monthly: 0,
      oneTime: total,
      breakdown,
      displaySummary: {
        size_label: sizeLabel,
        count: String(count),
      },
    };
  },

  buildScheduleAContribution(ctx, _pricing) {
    const size = routeBuildSize(ctx.variables);
    if (!size) {
      return { products_purchased: { build: false } };
    }
    const count = numberFromVar(ctx.variables.build_count, 1);
    const desc = typeof ctx.variables.build_description === 'string' ? ctx.variables.build_description : '';
    const itemsClause = count === 1
      ? `Build in scope: one ${size} build${desc ? ` (${desc})` : ''}.`
      : `Builds in scope: ${count} ${size} builds${desc ? ` (${desc})` : ''}.`;
    return {
      products_purchased: { build: true },
      build_sow_ref: `${itemsClause} Each is detailed in a separate Build Statement of Work to be signed alongside this agreement.`,
    };
  },
};
