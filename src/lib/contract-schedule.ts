// Schedule A builder.
//
// One dispatcher (buildScheduleA) routes to a per-formula implementation
// based on the proposal config's pricing_formula. The implementation
// takes the proposal config, the locked draft selections, the pricing
// result already computed by the accept endpoint, the client metadata,
// the effective date, and the practice info, and produces a flat
// JSON object matching the ScheduleA shape used by the renderer.
//
// Conditional sections are set to null when the corresponding product
// is not purchased; the renderer in contract-render.ts then omits the
// section entirely.

import { PRODUCT_REGISTRY, buildContextForProduct, expandBundleSelections } from './products';

// Standing language for Schedule A's WM section describing the
// single-cadence billing policy. Threaded into WebManagementSection
// so the contract renderer can italicize it under the WM heading.
// Per Cody operating rule (2026-05-26) and 07v3 Section 5.3.
export const BILLING_CADENCE_NOTE =
  'All sites on this agreement bill on the same monthly cadence. ' +
  'The first invoice for any site is prorated from its go-live date ' +
  'to the next billing anchor day; from there forward the site bills ' +
  'with all others on the agreement on a single monthly close.';

// Standing language under the Schedule A "Amount due at signing" block.
// Section 5.2: one-time fees are billed in full at signing and the first
// month of every recurring fee is collected with them; work does not
// begin until it clears.
export const AT_SIGNING_NOTE =
  'This total is every one-time fee (onboarding, initial audit, and build, ' +
  'each billed in full at signing) plus the first month of every recurring ' +
  'fee. It must clear before the Practice begins work. Recurring fees then ' +
  'bill monthly in advance per section 5.3.';

export interface ScheduleAContext {
  proposalConfig: any;
  draftSelections: Record<string, string | null>;
  pricing: PricingLike | null;
  clientMetadata: ClientMetadataInput;
  effectiveDate: string;
  // Managed sites for the client, read from client_sites where
  // is_managed = 1. Used by the WM product's buildScheduleAContribution
  // to render real domain rows on Schedule A instead of placeholders.
  // Per-site page_count routes each site's WM ecosystem in the
  // multi-site pricing pipeline (2026-05-24 locked formula).
  managedSites?: Array<{
    domain: string;
    label?: string | null;
    is_primary?: boolean;
    page_count?: number | null;
    monthly_override?: number | null;
    onboarding_override?: number | null;
  }>;
  // 1-31 day of month every site under this agreement bills on.
  // Omitted defaults to 1. Surfaced on Schedule A's hours_and_rates
  // so the rendered contract states the anchor day inline with the
  // proration rule.
  billingAnchorDay?: number;
}

export interface PricingLike {
  oneTime: number;
  monthly: number;
  // Canonical at-signing total (oneTime + first month). Required so the
  // Schedule A A.4 block reads it directly and cannot drift from the
  // proposal page / emails.
  atSigning: number;
  breakdown: Array<{ label: string; amount: number }>;
  mgmtMonthly: number;
  consultingMonthly: number;
  mgmtTierName: string;
  consultingTierName: string;
  siteSetupShortLabel: string;
  siteSetupLongLabel: string;
}

export interface ClientMetadataInput {
  legal_entity_name?: string | null;
  entity_type?: string | null;
  state_of_organization?: string | null;
  principal_address?: string | null;
  notice_address?: string | null;
  primary_contact_name?: string | null;
  primary_contact_title?: string | null;
  primary_contact_email?: string | null;
  primary_contact_phone?: string | null;
}

export interface ScheduleA {
  effective_date: string;
  designated_contacts: {
    client: {
      name: string | null;
      title: string | null;
      address: string | null;
      email: string | null;
      phone: string | null;
    };
  };
  products_purchased: {
    web_management: boolean;
    marketing_consulting: boolean;
    build: boolean;
    other_sow: boolean;
  };
  web_management: WebManagementSection | null;
  marketing_consulting: MarketingConsultingSection | null;
  hours_and_rates: HoursAndRates;
  day_one_access: DayOneAccess;
  pass_through_items: PassThroughItem[];
  build_sow_ref: string | null;
  other_sow_ref: string | null;
  // Itemized amount due at signing per section 5.2: one-time fees plus
  // the first month of every recurring fee. Total equals the pricing
  // result's atSigning (post-discount). Null until pricing is known
  // (e.g. an empty preview before products are chosen).
  amount_due_at_signing: AmountDueAtSigning | null;
}

export interface AmountDueAtSigning {
  line_items: Array<{ label: string; amount: number }>;
  total: number;
  note: string;
}

export interface WebManagementSection {
  tier_name: string;
  // Each site carries its own ecosystem and per-site monthly + onboarding
  // contribution per the locked multi-site formula (2026-05-24):
  // primary pays full base for its own ecosystem; each additional site
  // pays 0.80 of its own ecosystem base. The contract renders these
  // per-site rows so the buyer sees how the total breaks down.
  sites: Array<{
    domain: string;
    description: string;
    ecosystem?: string;           // 'A' | 'B' | 'C' for the routed eco
    monthly_contribution?: number;
    onboarding_contribution?: number;
    is_primary?: boolean;
  }>;
  site_count: number;
  monthly_base: number;           // primary's monthly base, for reference
  monthly_total: number;          // sum across all sites with multi-site discount
  included_hours: number;
  onboarding_fee: number;         // primary's onboarding base, for reference
  onboarding_total?: number;      // sum across all sites with multi-site discount
  update_cadence: string;
  response_time: string;
  quarterly_training_sessions: number | null;
  // Per Cody operating rule (2026-05-26): all sites under one
  // agreement bill on the same monthly cadence. When a site goes
  // live mid-cycle, its first invoice is prorated from go-live to
  // the next anchor day, then standard monthly thereafter. This
  // note states the policy in the contract so the buyer reads it
  // alongside the per-site fee rows.
  billing_cadence_note: string;
}

export interface MarketingConsultingSection {
  tier_name: string;
  monthly_retainer: number;
  initial_audit_fee: number;
  strategy_call_frequency: string;
  deep_advisories_per_cycle: string;
  performance_reporting_cadence: string;
  hiring_guidance: boolean;
}

export interface HoursAndRates {
  included_hours: number | null;
  overage_buffer: number;
  overage_rate: number;
  rush_rate: number;
  emergency_rate: number;
  // Day of month every site under this agreement bills on. 1-31.
  // Default 1. Stated on Schedule A so the contract reflects the
  // policy in section 5.3 (proration).
  billing_anchor_day: number;
}

export interface DayOneAccess {
  required_by: string | null;
  items: Array<{ system: string; provider: string }>;
}

export interface PassThroughItem {
  name: string;
  monthly_cost: number;
  billing_note: string;
}

function clampBillingAnchorDay(input: number | undefined | null): number {
  if (typeof input !== 'number' || !Number.isInteger(input)) return 1;
  if (input < 1) return 1;
  if (input > 31) return 31;
  return input;
}

// Dispatcher. New pricing formulas add a branch here.
export function buildScheduleA(ctx: ScheduleAContext): ScheduleA {
  const formula = ctx.proposalConfig?.pricing_formula;
  let schedule: ScheduleA;
  if (formula === 'raised_bar_v1') schedule = buildScheduleAForRaisedBarV1(ctx);
  else if (formula === 'product_driven_v1') schedule = buildScheduleAForProductDrivenV1(ctx);
  else schedule = emptyScheduleA(ctx.effectiveDate);
  schedule.hours_and_rates.billing_anchor_day = clampBillingAnchorDay(ctx.billingAnchorDay);
  // Itemize the amount due at signing from the already-computed pricing,
  // after each formula has applied any discount. Both formula paths put
  // their one-time fees in pricing.breakdown and their recurring split in
  // mgmtMonthly/consultingMonthly, so the items reconcile to atSigning.
  schedule.amount_due_at_signing = buildAmountDueAtSigning(ctx.pricing);
  return schedule;
}

// Build the itemized at-signing block from a pricing result. One-time
// fees come from the pricing breakdown (each product contributes its
// onboarding / audit / build fee there); the first month of recurring
// comes from mgmtMonthly + consultingMonthly, with any remaining
// recurring (other products) captured as a residual so the line items
// always sum to the authoritative atSigning total.
function buildAmountDueAtSigning(pricing: PricingLike | null): AmountDueAtSigning | null {
  if (!pricing) return null;
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const items: Array<{ label: string; amount: number }> = [];

  // One-time fees. Skip non-positive lines (e.g. the discount marker
  // line composePricing pushes at amount 0; discounted figures are
  // already net in the remaining lines).
  for (const r of pricing.breakdown || []) {
    if (typeof r.amount === 'number' && r.amount > 0.005) {
      items.push({ label: r.label, amount: round2(r.amount) });
    }
  }

  // First month of every recurring fee.
  const mgmt = typeof pricing.mgmtMonthly === 'number' ? pricing.mgmtMonthly : 0;
  const consulting = typeof pricing.consultingMonthly === 'number' ? pricing.consultingMonthly : 0;
  if (mgmt > 0.005) {
    items.push({
      label: `First month, Web Management${pricing.mgmtTierName ? ` (${pricing.mgmtTierName})` : ''}`,
      amount: round2(mgmt),
    });
  }
  if (consulting > 0.005) {
    items.push({
      label: `First month, Marketing Consulting${pricing.consultingTierName ? ` (${pricing.consultingTierName})` : ''}`,
      amount: round2(consulting),
    });
  }
  // Any recurring not represented by WM/MC (e.g. a recurring other-SOW).
  const otherRecurring = round2((pricing.monthly || 0) - mgmt - consulting);
  if (otherRecurring > 0.005) {
    items.push({ label: 'First month, other recurring services', amount: otherRecurring });
  }

  // Read the canonical at-signing total directly (no re-derivation from
  // components, which could drift). pricing is non-null here (guarded above).
  const total = round2(pricing.atSigning);

  if (items.length === 0 && total <= 0) return null;
  return { line_items: items, total, note: AT_SIGNING_NOTE };
}

// product_driven_v1: walks the config's in-scope products, asks each
// for its Schedule A contribution, and composes a full Schedule A.
// Mirrors the buildScheduleAForRaisedBarV1 output shape so the
// renderer reads it without changes.
function buildScheduleAForProductDrivenV1(ctx: ScheduleAContext): ScheduleA {
  const config = ctx.proposalConfig;
  const products: string[] = Array.isArray(config?.products) ? config.products : [];
  if (products.length === 0) return emptyScheduleA(ctx.effectiveDate);

  // Bundled-tier proposals carry a single bundle_tier pick; expand it into
  // the canonical wm_tier/mc_tier/build_options keys so Schedule A derives
  // from the same registry math (same per-product tiers) the proposal-page
  // price used. MUST mirror the expansion in computeProductDrivenV1 or the
  // proposal price and Schedule A diverge. No-op for non-bundle proposals.
  const selections = expandBundleSelections(config, ctx.draftSelections);

  // Start with an empty Schedule A; each product fills its slots.
  const base = emptyScheduleA(ctx.effectiveDate);
  // Designated-contact client side from clientMetadata, when present.
  // Proposal-time Schedule A previews may run before the client fills
  // their metadata at contract intake; treat missing metadata as nulls
  // rather than throwing.
  const meta = ctx.clientMetadata || {};
  base.designated_contacts = {
    client: {
      name: meta.primary_contact_name || null,
      title: meta.primary_contact_title || null,
      address: meta.notice_address || meta.principal_address || null,
      email: meta.primary_contact_email || null,
      phone: meta.primary_contact_phone || null,
    },
  };

  const productVars = config?.product_vars || {};
  const managedSites = ctx.managedSites && ctx.managedSites.length > 0
    ? ctx.managedSites
    : (Array.isArray(config?.managed_sites) ? config.managed_sites : undefined);
  const composed: ScheduleA = {
    ...base,
    pass_through_items: [],
    day_one_access: { ...base.day_one_access, items: [...(base.day_one_access.items || [])] },
  };

  for (const id of products) {
    const product = PRODUCT_REGISTRY[id];
    if (!product) continue;
    const productCtx = buildContextForProduct({
      id,
      selections,
      productVars,
      products,
      managedSites,
      waiveOnboarding: config?.waive_onboarding === true,
    });
    const pricing = product.computePricing(productCtx);
    const contribution = product.buildScheduleAContribution(productCtx, pricing);

    if (contribution.products_purchased) {
      Object.assign(composed.products_purchased, contribution.products_purchased);
    }
    if (contribution.web_management) composed.web_management = contribution.web_management;
    if (contribution.marketing_consulting) composed.marketing_consulting = contribution.marketing_consulting;
    if (contribution.build_sow_ref) composed.build_sow_ref = contribution.build_sow_ref;
    if (contribution.other_sow_ref) composed.other_sow_ref = contribution.other_sow_ref;
    if (Array.isArray(contribution.pass_through_items)) {
      composed.pass_through_items.push(...contribution.pass_through_items);
    }
    if (Array.isArray(contribution.day_one_access_items)) {
      composed.day_one_access.items.push(...contribution.day_one_access_items);
    }
    if (contribution.hours_addendum && contribution.hours_addendum.included_hours != null) {
      composed.hours_and_rates.included_hours = contribution.hours_addendum.included_hours;
    }
  }

  // If web_management is in scope but no day-one access items were
  // added by the product, fall back to the standard intake list.
  if (composed.products_purchased.web_management && composed.day_one_access.items.length === 0) {
    composed.day_one_access.items = [...DEFAULT_DAY_ONE_ACCESS_ITEMS];
  }
  composed.day_one_access.required_by = ctx.effectiveDate;

  // Apply client-level discount_rate to every monetary field on
  // Schedule A. composePricing in products/index.ts applies the same
  // discount uniformly across line items + totals; without this
  // mirror, Schedule A's monthly_total / per-site contributions are
  // pre-discount while the proposal page total is post-discount —
  // they disagree for any client with discount_rate > 0 (e.g. a 100%
  // discount on the proposal page shows $0 but Schedule A would show
  // full price). The signed contract gets the wrong number. Clamped
  // to [0, 1] so a bad value cannot flip a number negative.
  const discount = typeof config?.discount_rate === 'number'
    ? Math.max(0, Math.min(1, config.discount_rate))
    : 0;
  if (discount > 0) {
    applyDiscountToScheduleA(composed, discount);
  }

  return composed;
}

// Walks a composed Schedule A and applies a client-level discount
// (0-1) to every monetary field. Mirrors the uniform-discount
// semantics composePricing uses so proposal page and Schedule A
// agree post-discount. Per-site override amounts are also discounted
// because client-level discount applies uniformly per the model in
// products/index.ts and the documented operating rule.
function applyDiscountToScheduleA(s: ScheduleA, discount: number): void {
  const keep = 1 - discount;
  const discountAmount = (n: number | null | undefined): number =>
    typeof n === 'number' ? Math.round(n * keep * 100) / 100 : 0;
  if (s.web_management) {
    s.web_management.monthly_base = discountAmount(s.web_management.monthly_base);
    s.web_management.monthly_total = discountAmount(s.web_management.monthly_total);
    s.web_management.onboarding_fee = discountAmount(s.web_management.onboarding_fee);
    if (typeof (s.web_management as any).onboarding_total === 'number') {
      (s.web_management as any).onboarding_total = discountAmount((s.web_management as any).onboarding_total);
    }
    if (Array.isArray(s.web_management.sites)) {
      for (const site of s.web_management.sites) {
        if (typeof site.monthly_contribution === 'number') {
          site.monthly_contribution = discountAmount(site.monthly_contribution);
        }
        if (typeof site.onboarding_contribution === 'number') {
          site.onboarding_contribution = discountAmount(site.onboarding_contribution);
        }
      }
    }
  }
  if (s.marketing_consulting) {
    s.marketing_consulting.monthly_retainer = discountAmount(s.marketing_consulting.monthly_retainer);
    s.marketing_consulting.initial_audit_fee = discountAmount(s.marketing_consulting.initial_audit_fee);
  }
}

// Raised Bar v1: two products (Web Management + optional Marketing
// Consulting), 2 or 3 managed sites depending on site_setup, and a
// build component that ships as part of the engagement.
function buildScheduleAForRaisedBarV1(ctx: ScheduleAContext): ScheduleA {
  const s = ctx.draftSelections;
  const tier = s.mgmt_tier || '';
  const opt = s.site_setup || '';
  const consulting = s.consulting === 'yes';
  const consultingTier = s.consulting_tier || '';
  const buildersDomain = s.builders_domain || '';
  const tailwaterDomain = s.tailwater_domain || '';
  const pricing = ctx.pricing;

  const wmSites = buildRaisedBarSites(opt, buildersDomain, tailwaterDomain);
  const wmCount = wmSites.length;

  const wmTierDefaults = RB_MGMT_TIER_DEFAULTS[tier as keyof typeof RB_MGMT_TIER_DEFAULTS] || RB_MGMT_TIER_DEFAULTS.better;
  const mcTierDefaults = consulting && consultingTier
    ? (RB_CONSULTING_TIER_DEFAULTS[consultingTier as keyof typeof RB_CONSULTING_TIER_DEFAULTS] || RB_CONSULTING_TIER_DEFAULTS.better)
    : null;

  const includedHours = wmCount === 3 ? wmTierDefaults.hours_3sites : wmTierDefaults.hours_2sites;

  const webManagement: WebManagementSection = {
    tier_name: pricing?.mgmtTierName || wmTierDefaults.name,
    sites: wmSites,
    site_count: wmCount,
    monthly_base: wmTierDefaults.base,
    monthly_total: Math.round(pricing?.mgmtMonthly || 0),
    included_hours: includedHours,
    onboarding_fee: wmTierDefaults.onb,
    update_cadence: wmTierDefaults.update_cadence,
    response_time: wmTierDefaults.response_time,
    quarterly_training_sessions: wmTierDefaults.training_sessions,
    billing_cadence_note: BILLING_CADENCE_NOTE,
  };

  const marketingConsulting: MarketingConsultingSection | null = mcTierDefaults && pricing
    ? {
        tier_name: pricing.consultingTierName || mcTierDefaults.name,
        monthly_retainer: mcTierDefaults.monthly,
        initial_audit_fee: mcTierDefaults.audit,
        strategy_call_frequency: mcTierDefaults.call_frequency,
        deep_advisories_per_cycle: mcTierDefaults.advisories,
        performance_reporting_cadence: mcTierDefaults.reporting,
        hiring_guidance: mcTierDefaults.hiring_guidance,
      }
    : null;

  // Build SOW reference: there is always a build on Raised Bar (Builders
  // site, plus Tailwater micro-site on Option 2).
  const buildItems: string[] = ['Raised Bar Builders site build'];
  if (opt === 'o2') buildItems.push('Tailwater micro-site build');
  const build_sow_ref = `Builds in scope: ${buildItems.join('; ')}. Each is detailed in a separate Build Statement of Work to be signed alongside this agreement.`;

  // Pass-through items at signing: the $15/site monthly plugin
  // management fee per the business rules. Itemized per site.
  const passThrough: PassThroughItem[] = wmSites.map(site => ({
    name: `Plugin and software management (${site.domain})`,
    monthly_cost: 15,
    billing_note: 'billed monthly with the recurring invoice',
  }));

  return {
    effective_date: ctx.effectiveDate,
    designated_contacts: {
      client: {
        name: ctx.clientMetadata.primary_contact_name || null,
        title: ctx.clientMetadata.primary_contact_title || null,
        address: ctx.clientMetadata.notice_address || ctx.clientMetadata.principal_address || null,
        email: ctx.clientMetadata.primary_contact_email || null,
        phone: ctx.clientMetadata.primary_contact_phone || null,
      },
    },
    products_purchased: {
      web_management: true,
      marketing_consulting: consulting,
      build: true,
      other_sow: false,
    },
    web_management: webManagement,
    marketing_consulting: marketingConsulting,
    hours_and_rates: {
      included_hours: includedHours,
      overage_buffer: 2,
      overage_rate: 100,
      rush_rate: 150,
      emergency_rate: 200,
      billing_anchor_day: 1,
    },
    day_one_access: {
      required_by: ctx.effectiveDate,
      items: DEFAULT_DAY_ONE_ACCESS_ITEMS,
    },
    pass_through_items: passThrough,
    build_sow_ref,
    other_sow_ref: null,
    // Set by the buildScheduleA dispatcher from ctx.pricing.
    amount_due_at_signing: null,
  };
}

function buildRaisedBarSites(opt: string, buildersDomain: string, tailwaterDomain: string): Array<{ domain: string; description: string }> {
  // F3 is the existing takeover site (known URL). The Builders and
  // Tailwater sites are net-new builds; the domain pick is a step in
  // the proposal flow. If the Client deferred ("discuss" or not yet
  // picked), the Schedule A still says "confirmed by Client at
  // signing" so nothing is locked without their explicit choice.
  const buildersDisplay = resolveBuildersDomain(buildersDomain);
  const tailwaterDisplay = resolveTailwaterDomain(tailwaterDomain);

  if (opt === 'o2') {
    return [
      { domain: buildersDisplay, description: 'general contracting practice site' },
      { domain: 'f3properties.com', description: 'real estate brokerage takeover' },
      { domain: tailwaterDisplay, description: 'three-home pre-sell, standalone URL' },
    ];
  }
  return [
    { domain: buildersDisplay, description: 'general contracting practice site, with Tailwater section embedded' },
    { domain: 'f3properties.com', description: 'real estate brokerage takeover' },
  ];
}

function resolveBuildersDomain(pick: string): string {
  if (pick === 'raisedbarbuilders') return 'raisedbarbuilders.com';
  if (pick === 'raisedbarconstruction') return 'raisedbarconstruction.com';
  return 'Raised Bar Builders site (domain confirmed by Client at signing)';
}

function resolveTailwaterDomain(pick: string): string {
  if (pick === 'tailwaterhailey') return 'tailwaterhailey.com';
  if (pick === 'livetailwater') return 'livetailwater.com';
  return 'Tailwater micro-site (domain confirmed by Client at signing)';
}

const RB_MGMT_TIER_DEFAULTS = {
  good: {
    name: 'Good',
    base: 297,
    onb: 800,
    hours_2sites: 5,
    hours_3sites: 8,
    update_cadence: 'monthly',
    response_time: 'standard tier response window',
    training_sessions: null as number | null,
  },
  better: {
    name: 'Better',
    base: 497,
    onb: 800,
    hours_2sites: 9,
    hours_3sites: 13,
    update_cadence: 'bi-weekly',
    response_time: 'standard tier response window',
    training_sessions: null as number | null,
  },
  best: {
    name: 'Best',
    base: 647,
    onb: 1000,
    hours_2sites: 14,
    hours_3sites: 21,
    update_cadence: 'weekly',
    response_time: 'same-day priority response',
    training_sessions: 1,
  },
} as const;

const RB_CONSULTING_TIER_DEFAULTS = {
  good: {
    name: 'Good',
    monthly: 497,
    audit: 1500,
    call_frequency: 'no scheduled monthly call; access by email for written advisories',
    advisories: 'as requested, one or two per quarter',
    reporting: 'not included',
    hiring_guidance: false,
  },
  better: {
    name: 'Better',
    monthly: 997,
    audit: 2500,
    call_frequency: 'one 30-minute call per month',
    advisories: 'one per quarter',
    reporting: 'quarterly',
    hiring_guidance: false,
  },
  best: {
    name: 'Best',
    monthly: 1497,
    audit: 4000,
    call_frequency: 'one 60-minute call per month',
    advisories: 'one per month',
    reporting: 'monthly',
    hiring_guidance: true,
  },
} as const;

const DEFAULT_DAY_ONE_ACCESS_ITEMS: Array<{ system: string; provider: string }> = [
  { system: 'Domain registrar', provider: 'to be confirmed at intake' },
  { system: 'DNS provider', provider: 'to be confirmed at intake' },
  { system: 'Email host and authentication', provider: 'to be confirmed at intake' },
  { system: 'Web hosting', provider: 'to be confirmed at intake' },
  { system: 'Content management system', provider: 'WordPress' },
  { system: 'Analytics', provider: 'Google Analytics, Google Search Console' },
  { system: 'Form tools', provider: 'to be confirmed at intake' },
  { system: 'Customer relationship management', provider: 'to be confirmed at intake' },
];

function emptyScheduleA(effectiveDate: string): ScheduleA {
  return {
    effective_date: effectiveDate,
    designated_contacts: {
      client: { name: null, title: null, address: null, email: null, phone: null },
    },
    products_purchased: {
      web_management: false,
      marketing_consulting: false,
      build: false,
      other_sow: false,
    },
    web_management: null,
    marketing_consulting: null,
    hours_and_rates: {
      included_hours: null,
      overage_buffer: 2,
      overage_rate: 100,
      rush_rate: 150,
      emergency_rate: 200,
      billing_anchor_day: 1,
    },
    day_one_access: { required_by: null, items: [] },
    pass_through_items: [],
    build_sow_ref: null,
    other_sow_ref: null,
    amount_due_at_signing: null,
  };
}
