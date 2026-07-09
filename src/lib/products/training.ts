// Training product definition.
//
// Bundled with Best tier of Web Management or Marketing Consulting (one
// quarterly session included). Otherwise a la carte:
//   - SEO Fundamentals (2 hrs): $200 flat
//   - WordPress Best Practices (2 hrs): $200 flat
//   - New Hire Orientation (2-3 hrs): $250 flat
//   - Custom training: $100/hr
//
// For v1, training contributes narrative + Schedule A only; no
// interactive steps. Admin can add an a la carte training step via the
// wizard's override path if a specific session is being sold standalone.

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
  TierId,
} from './types';

// =========================================================================
// Modes
// =========================================================================

// "ecosystems" here is a loose fit; training does not band the same
// way WM and MC do. The two modes are bundled (free, with Best) and
// a-la-carte (priced per session). Keeping the shape consistent so
// the wizard renders training alongside other products without
// special-casing.
export const TRAINING_MODES: Record<EcosystemId, Ecosystem> = {
  bundled: {
    id: 'bundled',
    label: 'Bundled with Best tier',
    band: 'Included with Web Management Best or Marketing Consulting Best',
    tiers: {
      good: { id: 'good', name: 'Bundled', monthly: 0, onb: 0 },
      better: { id: 'better', name: 'Bundled' },
      best: { id: 'best', name: 'Bundled' },
      custom: { id: 'custom', name: 'Custom' },
    },
  },
  'a-la-carte': {
    id: 'a-la-carte',
    label: 'A la carte sessions',
    band: 'Priced per session',
    tiers: {
      good: { id: 'good', name: 'Single session', monthly: 0, onb: 200 },
      better: { id: 'better', name: 'Single session' },
      best: { id: 'best', name: 'Single session' },
      custom: { id: 'custom', name: 'Custom hourly' },
    },
  },
};

const SESSION_FEES = {
  'seo-fundamentals': 200,
  'wordpress-best-practices': 200,
  'new-hire-orientation': 250,
  custom: 100, // hourly
};

// =========================================================================
// Variable schema
// =========================================================================

const VARIABLE_SCHEMA: VariableSchemaField[] = [
  {
    id: 'mode',
    label: 'Training mode',
    type: 'select',
    options: [
      { id: 'bundled', label: 'Bundled (free with Best tier)' },
      { id: 'a-la-carte', label: 'A la carte sessions' },
    ],
    default: 'bundled',
    help: 'Bundled mode is automatic when any other product is at Best tier. A la carte for standalone training sales.',
  },
  {
    id: 'session_count',
    label: 'A la carte session count',
    type: 'number',
    default: 0,
    help: 'Number of pre-set sessions (SEO Fundamentals, WordPress Best Practices, New Hire Orientation).',
  },
];

// =========================================================================
// Mode resolution
// =========================================================================

export function resolveTrainingMode(ctx: ProductContext): 'bundled' | 'a-la-carte' {
  // If admin explicitly set the mode, honor it.
  const declared = typeof ctx.variables.mode === 'string' ? ctx.variables.mode : null;
  if (declared === 'a-la-carte') return 'a-la-carte';
  if (declared === 'bundled') return 'bundled';
  // Auto: if any other product is at Best tier, bundle.
  const anyBest = ctx.otherProducts.some(p => p.tierId === 'best');
  return anyBest ? 'bundled' : 'a-la-carte';
}

// =========================================================================
// Narrative
// =========================================================================

function trainingNarrative(ctx: ProductContext): NarrativeSnippetSet {
  const mode = resolveTrainingMode(ctx);
  const lines = mode === 'bundled'
    ? [`Training is bundled. One quarterly session is included with the Best tier you picked, on whichever topic helps your team most.`]
    : [`Training is sold a la carte at $200 per pre-set session (SEO Fundamentals, WordPress Best Practices) or $250 for the New Hire Orientation. Custom training runs at $100 per hour.`];

  return {
    intro_lines: [mode === 'bundled' ? 'Training is included.' : 'Training is a la carte.'],
    what_i_recommend_paragraphs: lines,
  };
}

// =========================================================================
// Product definition
// =========================================================================

export const trainingProduct: ProductDefinition = {
  id: 'training',
  name: 'Training',
  short_name: 'Training',

  variableSchema: VARIABLE_SCHEMA,

  ecosystems: TRAINING_MODES,

  routeEcosystem(variables) {
    const mode = typeof variables.mode === 'string' ? variables.mode : null;
    if (mode === 'bundled' || mode === 'a-la-carte') return mode;
    return null;
  },

  generateSteps(_ctx) {
    return [];
  },

  generateNarrativeSnippets(ctx) {
    return trainingNarrative(ctx);
  },

  computePricing(ctx) {
    const mode = resolveTrainingMode(ctx);
    if (mode === 'bundled') {
      return { monthly: 0, oneTime: 0, breakdown: [], displaySummary: { mode: 'bundled' } };
    }
    const sessionCount = Math.max(0, Math.floor(numberFromVar(ctx.variables.session_count, 0)));
    if (sessionCount === 0) {
      return { monthly: 0, oneTime: 0, breakdown: [], displaySummary: { mode: 'a-la-carte', sessions: '0' } };
    }
    // For v1, assume standard $200 sessions; the wizard's preview-
    // override path can swap to $250 (New Hire) or $100/hr custom.
    const oneTime = sessionCount * 200;
    return {
      monthly: 0,
      oneTime,
      breakdown: [
        { label: `Training: ${sessionCount} a la carte session${sessionCount > 1 ? 's' : ''} at $200`, amount: oneTime },
      ],
      displaySummary: { mode: 'a-la-carte', sessions: String(sessionCount) },
    };
  },

  buildScheduleAContribution(_ctx, _pricing) {
    // Training does not occupy a dedicated Schedule A section; it
    // shows up in the WM tier's training_sessions field (when bundled)
    // or as a line in pass_through_items (when a la carte). v1 leaves
    // a la carte training off Schedule A unless the admin adds it via
    // override.
    return {};
  },
};

function numberFromVar(v: ProductVariables[string] | undefined, dflt: number): number {
  if (v === null || v === undefined) return dflt;
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
