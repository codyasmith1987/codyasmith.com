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
import { lookupSnippetOverride } from './narrative-snippets';
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
    const variables = { ...composeLevelVars, ...(args.product_vars[id] || {}) };
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
  // ProposalConfig.narrative shape. The strategy drives the opener
  // (The Situation) and informs per-product paragraphs through
  // ctx.engagementStrategy.
  const narrative = composeNarrative({
    orderedProducts,
    contexts,
    clientName: args.client.name,
    narrativeVariables: args.narrative_variables || {},
    engagementStrategy,
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
  engagementStrategy?: EngagementStrategy | null;
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
    const override = lookupSnippetOverride({
      productId: primary,
      otherProductIds: others,
      ecosystemId: lookupEco,
      urgency: args.narrativeVariables.urgency || null,
    });
    if (override) {
      // The snippet runs with the primary product's context (the
      // helpers in narrative-snippets.ts read client_name, page_count,
      // industry, urgency from variables that the composer threaded
      // through). Each bucket present in the snippet REPLACES the
      // concatenated inline content for that bucket; absent buckets
      // fall back to the inline contributions.
      const snippetSet = override(args.contexts[primary]);
      const merged: NarrativeSnippetSet = {
        intro_lines: snippetSet.intro_lines !== undefined
          ? snippetSet.intro_lines
          : inlineContributions.flatMap(c => c.set.intro_lines || []),
        what_i_see_paragraphs: snippetSet.what_i_see_paragraphs !== undefined
          ? snippetSet.what_i_see_paragraphs
          : inlineContributions.flatMap(c => c.set.what_i_see_paragraphs || []),
        what_i_recommend_paragraphs: snippetSet.what_i_recommend_paragraphs !== undefined
          ? snippetSet.what_i_recommend_paragraphs
          : inlineContributions.flatMap(c => c.set.what_i_recommend_paragraphs || []),
        rollout_phases: snippetSet.rollout_phases !== undefined
          ? snippetSet.rollout_phases
          : inlineContributions.flatMap(c => c.set.rollout_phases || []),
        rollout_scenarios: snippetSet.rollout_scenarios
          || inlineContributions.find(c => c.set.rollout_scenarios)?.set.rollout_scenarios,
        rollout_scenario_step: snippetSet.rollout_scenario_step
          || inlineContributions.find(c => c.set.rollout_scenario_step)?.set.rollout_scenario_step,
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
  const recommendParagraphs = contributions.flatMap(c => c.set.what_i_recommend_paragraphs || []);

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
}): string[] {
  if (args.orderedProducts.length === 0) return [];
  const hasWM = args.orderedProducts.includes('web-management');
  const hasMC = args.orderedProducts.includes('marketing-consulting');
  const hasBuild = args.orderedProducts.includes('build');
  const hasTraining = args.orderedProducts.includes('training');

  const paragraphs: string[] = [];

  // Paragraph 1: month one. Onboarding so the client sees what is
  // changing fast (04 §4: anxiety highest in the first week).
  const monthOneParts: string[] = [
    `<strong>Month one is onboarding.</strong> The work in the first weeks is concentrated so you can see what is changing.`,
  ];
  if (hasBuild) {
    monthOneParts.push(`If a build is in scope, scoping conversations and the first design pass happen here.`);
  }
  if (hasWM) {
    monthOneParts.push(`If a site is moving onto management, the takeover audit, baseline health work, and access transfer happen in this window.`);
  }
  if (hasMC && !hasBuild && !hasWM) {
    monthOneParts.push(`If consulting is in scope on its own, the initial audit and the first strategy cycle land in this window.`);
  } else if (hasMC) {
    monthOneParts.push(`If consulting is in scope, the initial audit lands in this window too.`);
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

  // Cross-product effects from a picked Build option. The Raised Bar
  // pattern: Option 2 ("split setup") adds a managed site, which
  // bumps WM monthly + onboarding. The option carries pre-computed
  // wm_monthly_delta + wm_onboarding_delta so the dispatcher just
  // adds them — no multi-site recomputation at pick time.
  const buildVars = productVars['build'];
  const buildOptionsArr = buildVars && Array.isArray(buildVars.build_options)
    ? buildVars.build_options
    : [];
  const pickedBuildOptionId = args.selections['build_options'];
  if (pickedBuildOptionId && buildOptionsArr.length >= 2 && products.includes('web-management')) {
    const pickedOption = buildOptionsArr.find((o: any) => o && o.id === pickedBuildOptionId);
    if (pickedOption) {
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

  return {
    ecosystemId,
    tierId,
    variables,
    otherProducts,
    selections: args.selections,
    allProductVars: args.productVars,
  };
}

// Exported for use in contract-schedule.ts product_driven_v1 branch.
export { buildContextForProduct };
