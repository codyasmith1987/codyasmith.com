// Product registry and proposal composer.
//
// The wizard at /portal/admin/proposals/new calls composeProposal()
// with: which client, which products are in scope, per-product
// variables, narrative variables, and any overrides. The composer
// produces a complete ProposalConfig the wizard POSTs to the create
// endpoint. The downstream (renderer, accept, contract Schedule A)
// reads the same shape it has read for the live Raised Bar proposal.

import { webManagementProduct } from './web-management';
import { marketingConsultingProduct } from './marketing-consulting';
import { buildProduct } from './build';
import { trainingProduct } from './training';
import { otherSowProduct } from './other-sow';
import type {
  ProductDefinition,
  ProductId,
  ProductContext,
  ProductVariables,
  ProposalConfig,
  ComposeArgs,
  NarrativeSection,
  ProposalStep,
  TierId,
  NarrativeSnippetSet,
  NarrativePhase,
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

export function composeProposal(args: ComposeArgs): ProposalConfig {
  // Order products by PRODUCT_ORDER so the composed output is stable.
  const orderedProducts = PRODUCT_ORDER.filter(id => args.products.includes(id));

  // Build a ProductContext for each in-scope product. tierId is null
  // at compose time (the prospect picks tiers on the proposal page).
  // otherProducts is each product's view of the rest of the mix; used
  // for narrative composition.
  const contexts: Record<ProductId, ProductContext> = {} as any;
  for (const id of orderedProducts) {
    const product = PRODUCT_REGISTRY[id];
    const variables = args.product_vars[id] || {};
    const ecosystemId = product.routeEcosystem(variables);
    const otherProducts = orderedProducts
      .filter(other => other !== id)
      .map(other => ({ id: other, tierId: null as TierId | null }));
    contexts[id] = {
      ecosystemId,
      tierId: null,
      variables,
      otherProducts,
    };
  }

  // Steps: concatenate each product's steps in product order.
  const composedSteps: ProposalStep[] = [];
  for (const id of orderedProducts) {
    const product = PRODUCT_REGISTRY[id];
    const ctx = contexts[id];
    const steps = product.generateSteps(ctx);
    composedSteps.push(...steps);
  }

  // Narrative: merge per-product NarrativeSnippetSets into the
  // ProposalConfig.narrative shape.
  const narrative = composeNarrative({
    orderedProducts,
    contexts,
    clientName: args.client.name,
    narrativeVariables: args.narrative_variables || {},
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
  const rollout = overrides.rollout || narrative.rollout;
  const steps = overrides.steps || composedSteps;

  return {
    version: 1,
    prepared_for,
    prepared_on,
    title,
    discount_rate: typeof args.client.discount_rate === 'number'
      ? Math.max(0, Math.min(1, args.client.discount_rate))
      : 0,
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
  };
}

// =========================================================================
// Narrative composition helpers
// =========================================================================

interface ComposeNarrativeArgs {
  orderedProducts: ProductId[];
  contexts: Record<ProductId, ProductContext>;
  clientName: string;
  narrativeVariables: { industry?: string; urgency?: string; focus?: string[] };
}

function composeNarrative(args: ComposeNarrativeArgs): {
  intro: string;
  sections: NarrativeSection[];
  rollout?: ProposalConfig['narrative']['rollout'];
} {
  // Gather each product's contribution.
  const contributions: Array<{ id: ProductId; set: NarrativeSnippetSet }> = [];
  for (const id of args.orderedProducts) {
    const product = PRODUCT_REGISTRY[id];
    const ctx = args.contexts[id];
    contributions.push({ id, set: product.generateNarrativeSnippets(ctx) });
  }

  // Master intro: one composed paragraph from each product's
  // intro_lines, plus a top opener.
  const productNames = args.orderedProducts.map(id => PRODUCT_REGISTRY[id].short_name);
  const intro = composeIntro({
    productNames,
    productIntroLines: contributions.flatMap(c => c.set.intro_lines || []),
    urgency: args.narrativeVariables.urgency,
  });

  // "What I see in your business" h2 with paragraphs.
  const seeParagraphs = contributions.flatMap(c => c.set.what_i_see_paragraphs || []);
  // "What I recommend" h2 with paragraphs.
  const recommendParagraphs = contributions.flatMap(c => c.set.what_i_recommend_paragraphs || []);

  const sections: NarrativeSection[] = [];
  if (seeParagraphs.length > 0) {
    sections.push({ h2: 'What I see in your business', paragraphs: seeParagraphs });
  }
  if (recommendParagraphs.length > 0) {
    sections.push({ h2: 'What I recommend', paragraphs: recommendParagraphs });
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

  let monthly = 0;
  let oneTime = 0;
  const breakdown: Array<{ label: string; amount: number }> = [];
  // Per-product display summaries for the email/page summaries.
  const wmCtx = buildContextForProduct({
    id: 'web-management',
    selections: args.selections,
    productVars,
    products,
  });
  const mcCtx = buildContextForProduct({
    id: 'marketing-consulting',
    selections: args.selections,
    productVars,
    products,
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
    breakdown,
    mgmtMonthly,
    consultingMonthly,
    mgmtTierName,
    consultingTierName,
    siteSetupShortLabel: '',
    siteSetupLongLabel: '',
  };
}

// Resolve the tier picked for a product based on its step ids.
// Convention: web-management picks under selections.wm_tier;
// marketing-consulting under selections.mc_tier (gated by mc_yes_no).
function buildContextForProduct(args: {
  id: ProductId;
  selections: Record<string, string | null>;
  productVars: Record<ProductId, ProductVariables>;
  products: ProductId[];
}): ProductContext {
  const product = PRODUCT_REGISTRY[args.id];
  const variables = args.productVars[args.id] || {};
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

  return { ecosystemId, tierId, variables, otherProducts };
}

// Exported for use in contract-schedule.ts product_driven_v1 branch.
export { buildContextForProduct };
