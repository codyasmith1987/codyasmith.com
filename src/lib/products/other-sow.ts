// Other-SOW product definition.
//
// Catch-all for genuine "outside the three products" scope (non-web
// execution per 05 Section 2: copy production at scale, campaign
// setup, ad creative, research production, etc.). v1 stub: admin
// types a title and a fixed fee. Contributes a one-time line and a
// Schedule A reference to a separate Statement of Work.

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

const OTHER_SOW_ECOSYSTEMS: Record<EcosystemId, Ecosystem> = {
  default: {
    id: 'default',
    label: 'Other Statement of Work',
    band: 'Custom scope',
    tiers: {
      good: { id: 'good', name: 'Custom' },
      better: { id: 'better', name: 'Custom' },
      best: { id: 'best', name: 'Custom' },
      custom: { id: 'custom', name: 'Custom' },
    },
  },
};

const VARIABLE_SCHEMA: VariableSchemaField[] = [
  {
    id: 'title',
    label: 'SOW title',
    type: 'text',
    default: '',
    help: 'Short label, e.g., "Q3 content production sprint" or "Ad creative for launch campaign."',
  },
  {
    id: 'description',
    label: 'One-sentence description',
    type: 'text',
    default: '',
    help: 'One sentence the proposal narrative carries. The Statement of Work itself contains the full scope.',
  },
  {
    id: 'fixed_fee',
    label: 'Fixed fee',
    type: 'number',
    default: 0,
    help: 'Total fee for the SOW. v1 supports fixed-fee only; hourly SOWs use a separate flow.',
  },
];

export const otherSowProduct: ProductDefinition = {
  id: 'other-sow',
  name: 'Other Statement of Work',
  short_name: 'Other SOW',

  variableSchema: VARIABLE_SCHEMA,

  ecosystems: OTHER_SOW_ECOSYSTEMS,

  routeEcosystem(_variables) {
    return 'default';
  },

  generateSteps(_ctx) {
    return [];
  },

  generateNarrativeSnippets(ctx) {
    const title = typeof ctx.variables.title === 'string' ? ctx.variables.title : '';
    const desc = typeof ctx.variables.description === 'string' ? ctx.variables.description : '';
    const sentence = title
      ? `A separate Statement of Work covers ${title}${desc ? `: ${desc}` : ''}.`
      : `A separate Statement of Work is part of this engagement.`;
    return {
      intro_lines: [sentence],
      what_i_recommend_paragraphs: [
        `<strong>${title || 'Other Statement of Work'}</strong>: ${desc || 'scope detailed in a separate signed SOW'}. Per the contract's section 3.2, non-web execution routes through a separate Statement of Work; this is that.`,
      ],
    };
  },

  computePricing(ctx) {
    const fee = numberFromVar(ctx.variables.fixed_fee, 0);
    if (fee <= 0) {
      return { monthly: 0, oneTime: 0, breakdown: [], displaySummary: {} };
    }
    const title = typeof ctx.variables.title === 'string' && ctx.variables.title
      ? ctx.variables.title
      : 'Other Statement of Work';
    return {
      monthly: 0,
      oneTime: fee,
      breakdown: [{ label: title, amount: fee }],
      displaySummary: { title },
    };
  },

  buildScheduleAContribution(ctx, _pricing) {
    const title = typeof ctx.variables.title === 'string' ? ctx.variables.title : '';
    const desc = typeof ctx.variables.description === 'string' ? ctx.variables.description : '';
    return {
      products_purchased: { other_sow: true },
      other_sow_ref: title
        ? `${title}${desc ? `: ${desc}` : ''}. Detailed in a separate, signed Statement of Work.`
        : `A separate, signed Statement of Work specifies the scope, deliverables, fee, and timeline.`,
    };
  },
};

function numberFromVar(v: ProductVariables[string] | undefined, dflt: number): number {
  if (v === null || v === undefined) return dflt;
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
