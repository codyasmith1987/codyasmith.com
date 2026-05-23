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

export interface ScheduleAContext {
  proposalConfig: any;
  draftSelections: Record<string, string | null>;
  pricing: PricingLike | null;
  clientMetadata: ClientMetadataInput;
  effectiveDate: string;
}

export interface PricingLike {
  oneTime: number;
  monthly: number;
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
}

export interface WebManagementSection {
  tier_name: string;
  sites: Array<{ domain: string; description: string }>;
  site_count: number;
  monthly_base: number;
  monthly_total: number;
  included_hours: number;
  onboarding_fee: number;
  update_cadence: string;
  response_time: string;
  quarterly_training_sessions: number | null;
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

// Dispatcher. New pricing formulas add a branch here.
export function buildScheduleA(ctx: ScheduleAContext): ScheduleA {
  const formula = ctx.proposalConfig?.pricing_formula;
  if (formula === 'raised_bar_v1') return buildScheduleAForRaisedBarV1(ctx);
  // Fallback for unknown formulas: render an empty Schedule A so the
  // contract page still loads. Admin will fill manually.
  return emptyScheduleA(ctx.effectiveDate);
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
    },
    day_one_access: {
      required_by: ctx.effectiveDate,
      items: DEFAULT_DAY_ONE_ACCESS_ITEMS,
    },
    pass_through_items: passThrough,
    build_sow_ref,
    other_sow_ref: null,
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
    },
    day_one_access: { required_by: null, items: [] },
    pass_through_items: [],
    build_sow_ref: null,
    other_sow_ref: null,
  };
}
