// Web Management product definition.
//
// Encodes business-design-v2 Section 3: three ecosystems (A small, B
// mid, C large) routed by page count, three tiers (Good / Better /
// Best) per ecosystem, multi-site formula. Build-produced sites skip
// WM onboarding because the Build fee covers standing them up; takeover
// sites still pay WM onboarding because inheriting prior work is its own
// activity.

import type {
  ProductDefinition,
  ProductContext,
  Ecosystem,
  EcosystemId,
  EcosystemCeiling,
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

export const WM_ECOSYSTEMS: Record<EcosystemId, Ecosystem> = {
  A: {
    id: 'A',
    label: 'Ecosystem A',
    band: 'Under 30 pages',
    multi_unit_monthly_discount: 0.90,
    multi_unit_onb_discount: 1.0, // per-site full base; no discount on onboarding
    tiers: {
      good: {
        id: 'good',
        name: 'Good',
        tagline: 'A start, intentionally light.',
        monthly: 297,
        onb: 800,
        hours: 2,
        update_cadence: 'monthly',
        response_time: 'standard tier response window',
        training_sessions: null,
        features: [
          'Hosting, daily backups, security and uptime monitoring on every site under management.',
          'Monthly updates at the contracted cadence.',
          'Pooled hours each month for hands-on site work.',
        ],
      },
      better: {
        id: 'better',
        name: 'Better',
        tagline: 'The flagship. The right fit for most clients.',
        recommended: true,
        monthly: 497,
        onb: 800,
        hours: 3,
        update_cadence: 'bi-weekly',
        response_time: 'standard tier response window',
        training_sessions: null,
        features: [
          'Everything in Good, plus bi-weekly updates and performance optimization.',
          'Pooled hours each month for active page work, copy edits, and image updates.',
        ],
      },
      best: {
        id: 'best',
        name: 'Best',
        tagline: 'Weekly updates. Same-day priority response.',
        monthly: 647,
        onb: 1000,
        hours: 4,
        update_cadence: 'weekly',
        response_time: 'same-day priority response',
        training_sessions: 1,
        features: [
          'Everything in Better, plus weekly updates and same-day priority response when something breaks.',
          'Pooled hours each month for hands-on work.',
          'One staff training session per quarter for your team, on whichever topic helps them most.',
        ],
      },
      custom: { id: 'custom', name: 'Custom' },
    },
  },
  B: {
    id: 'B',
    label: 'Ecosystem B',
    band: '30 to 150 pages',
    multi_unit_monthly_discount: 0.90,
    multi_unit_onb_discount: 1.0,
    tiers: {
      good: {
        id: 'good',
        name: 'Good',
        tagline: 'A start, intentionally light.',
        monthly: 497,
        onb: 1200,
        hours: 3,
        update_cadence: 'monthly',
        response_time: 'standard tier response window',
        training_sessions: null,
        features: [
          'Hosting, daily backups, security and uptime monitoring on every site under management.',
          'Monthly updates at the contracted cadence.',
          'Pooled hours each month for hands-on site work.',
        ],
      },
      better: {
        id: 'better',
        name: 'Better',
        tagline: 'The flagship. The right fit for most clients.',
        recommended: true,
        monthly: 797,
        onb: 1200,
        hours: 4,
        update_cadence: 'bi-weekly',
        response_time: 'standard tier response window',
        training_sessions: null,
        features: [
          'Everything in Good, plus bi-weekly updates and performance optimization.',
          'Pooled hours each month for active page work, copy edits, and image updates.',
        ],
      },
      best: {
        id: 'best',
        name: 'Best',
        tagline: 'Weekly updates. Same-day priority response.',
        monthly: 997,
        onb: 1500,
        hours: 6,
        update_cadence: 'weekly',
        response_time: 'same-day priority response',
        training_sessions: 1,
        features: [
          'Everything in Better, plus weekly updates and same-day priority response when something breaks.',
          'Pooled hours each month for hands-on work.',
          'One staff training session per quarter for your team, on whichever topic helps them most.',
        ],
      },
      custom: { id: 'custom', name: 'Custom' },
    },
  },
  C: {
    id: 'C',
    label: 'Ecosystem C',
    band: '150 or more pages',
    multi_unit_monthly_discount: 0.90,
    multi_unit_onb_discount: 1.0,
    tiers: {
      good: {
        id: 'good',
        name: 'Good',
        tagline: 'A start, intentionally light.',
        monthly: 997,
        onb: 2000,
        hours: 5,
        update_cadence: 'monthly',
        response_time: 'standard tier response window',
        training_sessions: null,
        features: [
          'Hosting, daily backups, security and uptime monitoring on every site under management.',
          'Monthly updates at the contracted cadence.',
          'Pooled hours each month for hands-on site work.',
        ],
      },
      better: {
        id: 'better',
        name: 'Better',
        tagline: 'The flagship. The right fit for most clients.',
        recommended: true,
        monthly: 1497,
        onb: 2000,
        hours: 8,
        update_cadence: 'bi-weekly',
        response_time: 'standard tier response window',
        training_sessions: null,
        features: [
          'Everything in Good, plus bi-weekly updates and performance optimization.',
          'Pooled hours each month for active page work, copy edits, and image updates.',
        ],
      },
      best: {
        id: 'best',
        name: 'Best',
        tagline: 'Weekly updates. Same-day priority response.',
        monthly: 1997,
        onb: 2500,
        hours: 12,
        update_cadence: 'weekly',
        response_time: 'same-day priority response',
        training_sessions: 1,
        features: [
          'Everything in Better, plus weekly updates and same-day priority response when something breaks.',
          'Pooled hours each month for hands-on work.',
          'One staff training session per quarter for your team, on whichever topic helps them most.',
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
    id: 'page_count',
    label: 'Page count (across all managed sites)',
    type: 'number',
    default: null,
    help: 'Total page count across the sites in scope. Routes the ecosystem. Defaults to the latest crawl aggregate if available.',
  },
  {
    id: 'site_count',
    label: 'Number of sites under management',
    type: 'number',
    default: 1,
    help: 'How many domains the engagement covers. The multi-site formula applies for site_count > 1.',
  },
];

// =========================================================================
// Routing
// =========================================================================

export function routeWebManagementEcosystem(pageCount: number | null): EcosystemId | null {
  if (pageCount === null || pageCount === undefined) return null;
  if (pageCount < 30) return 'A';
  if (pageCount <= 150) return 'B';
  return 'C';
}

// =========================================================================
// Ecosystem page-ceiling disclosure
// =========================================================================
//
// A proposal (and its contract) discloses, per site, the page ceiling of
// the ecosystem each site is priced in, and that crossing it moves that
// site into the next ecosystem at a higher rate. This is the ONLY surface
// where the ecosystem label + page ceiling are shown to the client; the
// de-leak boundary (PRs #231/#232) keeps them out of the narrative, the
// tier cards, and the Schedule A per-site table. "Pages" means real
// navigable pages (getNavigablePageCount) -- the same count that routes the
// ecosystem. Derived at render time from per-site page counts; nothing new
// is stored. The EcosystemCeiling type lives in types.ts (shared with
// ProposalConfig.ecosystem_ceilings).

// Per-ecosystem ceiling constants, kept in lockstep with the thresholds in
// routeWebManagementEcosystem (A: <30, B: <=150, C: >150). The ceiling is the
// LAST page count still in the ecosystem (29 / 150); the trigger is the FIRST
// count that moves up (30 / 151). One place these numbers live.
const ECOSYSTEM_CEILINGS: Record<EcosystemId, { ceilingPages: number | null; nextTriggerPages: number | null; nextLabel: string | null }> = {
  A: { ceilingPages: 29, nextTriggerPages: 30, nextLabel: 'Ecosystem B' },
  B: { ceilingPages: 150, nextTriggerPages: 151, nextLabel: 'Ecosystem C' },
  C: { ceilingPages: null, nextTriggerPages: null, nextLabel: null },
};

// Distinct ecosystems occupied by a proposal's sites, in A,B,C order, each
// with its ceiling + the domains routed into it. A site with a null page
// count falls back to fallbackEcosystem (mirroring the pricing fallback);
// callers that cannot back a hard ceiling for a null-count site soften the
// wording rather than asserting a page number. Returns [] when no site
// resolves to an ecosystem (the notice then renders nothing).
export function deriveEcosystemCeilings(
  sites: Array<{ domain: string; label?: string | null; page_count?: number | null }>,
  fallbackEcosystem?: EcosystemId | null,
): EcosystemCeiling[] {
  const byEco = new Map<EcosystemId, string[]>();
  for (const s of sites) {
    if (!s) continue;
    const routed = routeWebManagementEcosystem(typeof s.page_count === 'number' ? s.page_count : null);
    const eco = routed ?? fallbackEcosystem ?? null;
    if (!eco) continue;
    const name = (s.label && s.label.trim()) ? s.label.trim() : (s.domain || '').trim();
    const list = byEco.get(eco) || [];
    // Dedup: the same site can appear across multiple build options
    // (e.g. a Builders site in both o1 and o2), so guard against listing
    // it twice in the ceiling disclosure.
    if (name && !list.includes(name)) list.push(name);
    byEco.set(eco, list);
  }
  const order: EcosystemId[] = ['A', 'B', 'C'];
  return order
    .filter(id => byEco.has(id))
    .map(id => ({
      ecosystemId: id,
      label: WM_ECOSYSTEMS[id].label,
      band: WM_ECOSYSTEMS[id].band,
      ceilingPages: ECOSYSTEM_CEILINGS[id].ceilingPages,
      nextTriggerPages: ECOSYSTEM_CEILINGS[id].nextTriggerPages,
      nextLabel: ECOSYSTEM_CEILINGS[id].nextLabel,
      sites: byEco.get(id) || [],
    }));
}

// Contract Schedule A A.13 clause (2026-05-31, variant B, client-jargon pass):
// defines the three page-count SIZE BANDS by navigable-page ceiling and the
// per-site escalation mechanism with written notice. No internal "Ecosystem
// A/B/C" label reaches the client; the bands are described by page count only
// (Cody decision 2026-05-31: drop the label, price by page size). "the
// Practice" matches the contract's party term.
export const WM_ECOSYSTEM_CLAUSE =
  'Each site under this agreement is priced by its navigable page count in one of three size bands: '
  + 'fewer than 30 navigable pages, 30 to 150 navigable pages, and 150 or more navigable pages. '
  + '"Navigable pages" are indexable, publicly reachable HTML pages, excluding system, archive, feed, and '
  + 'pagination URLs. If a managed site\'s navigable page count grows beyond the ceiling of its current band, '
  + 'the Practice will re-price that site at the next band and adjust its recurring fee on the same per-site '
  + 'basis stated in Section A.5, effective the next billing cycle. The Practice will give the Client written '
  + 'notice before any such adjustment takes effect. This applies per site; other sites are unaffected.';

// =========================================================================
// Pricing math
// =========================================================================
//
// Multi-site formula locked 2026-05-24 per docs/audits/proposal-chain-
// audit-2026-05-24.md finding 1. Replaces the prior "all sites priced
// off primary's ecosystem" rule.
//
// Each managed site routes to its OWN ecosystem by its OWN page count.
// The engagement tier (Good / Better / Best) is set once and applied
// to every site. Each site contributes its own ecosystem's tier base.
// The primary contributes its full base; each additional site
// contributes its base × MULTI_SITE_DISCOUNT. Linear, no compounding.
// Same discount applies to monthly and onboarding.

export const MULTI_SITE_DISCOUNT = 0.90;

// Sum a per-site array of bases with the multi-site discount. The
// FIRST element is the primary (full base); the rest are additional
// sites at the discounted rate. Used for both monthly and onboarding.
//
// Callers compute each site's base by routing the site to its own
// ecosystem (via routeWebManagementEcosystem) and looking up the
// engagement tier's monthly or onb value at that ecosystem.
//
// Rounds to cents (2 decimals) per-step so float artifacts from
// multiplying integer-dollar bases by 0.90 do not accumulate. Money
// math is decimal; the bases are always whole or half-cent dollar
// figures, and the discount factor is exactly 0.90.
export function computeMultiSiteSum(perSiteBases: number[]): number {
  if (perSiteBases.length === 0) return 0;
  const [primary, ...additional] = perSiteBases;
  const discountedSum = additional.reduce(
    (sum, base) => sum + Math.round(base * MULTI_SITE_DISCOUNT * 100) / 100,
    0
  );
  return Math.round((primary + discountedSum) * 100) / 100;
}

// Override-aware sum. Per-site shape: { base, isOverride }. Primary
// (index 0) always gets full base. Additional sites get 0.90x UNLESS
// isOverride is true, in which case they get full base because the
// override IS the price (no multi-site discount on top of a
// grandfathered or pro-bono carve-out). Used by the WM pricing
// pipeline when managedSites carry monthly_override / onboarding_override.
export type PerSiteBase = { base: number; isOverride: boolean };

type ManagedSiteForPricing = {
  domain: string;
  label?: string | null;
  is_primary?: boolean;
  page_count?: number | null;
  monthly_override?: number | null;
  onboarding_override?: number | null;
  // Origin of the site, for Schedule A labeling: 'takeover' (existing
  // unmanaged site inherited), 'built' (new build), 'managed' (already under
  // contract). Pricing is identical regardless; this is a label only.
  site_type?: 'takeover' | 'built' | 'managed' | null;
};

function selectedBuildOption(args: {
  allProductVars?: Record<string, any>;
  selections?: Record<string, any>;
}): any | null {
  const productVars = args.allProductVars || {};
  const buildOptionsArr = productVars['build']?.build_options;
  const pickedBuildOptionId = args.selections?.['build_options'];
  if (!Array.isArray(buildOptionsArr) || !pickedBuildOptionId) return null;
  return buildOptionsArr.find((o: any) => o && o.id === pickedBuildOptionId) || null;
}

// Existing but UNMANAGED sites the proposal proposes to TAKE OVER. They are
// not is_managed yet (that flips on contract finalize); in the proposal they
// price as managed sites at their REAL crawl page count and pay FULL WM
// onboarding (onboarding_override stays null) -- the build covers onboarding
// for newly-built sites, never for inheriting an existing one. Proposal-level
// (constant across build options), read off product_vars['web-management'].
export function extractTakeoverSites(allProductVars?: Record<string, any>): ManagedSiteForPricing[] {
  const raw = allProductVars?.['web-management']?.takeover_sites;
  if (!Array.isArray(raw)) return [];
  const out: ManagedSiteForPricing[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const domain = typeof s.domain === 'string' ? s.domain.trim().toLowerCase() : '';
    const pages = typeof s.page_count === 'number' && Number.isFinite(s.page_count) && s.page_count > 0
      ? s.page_count
      : null;
    if (!domain || pages === null) continue;
    out.push({
      domain,
      label: typeof s.label === 'string' && s.label.trim() ? s.label.trim() : null,
      is_primary: s.is_primary === true,
      page_count: pages,
      site_type: 'takeover',
      monthly_override: null,
      onboarding_override: null,
    });
  }
  return out;
}

export function computeMultiSiteSumWithOverrides(perSite: PerSiteBase[]): number {
  if (perSite.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < perSite.length; i++) {
    const { base, isOverride } = perSite[i];
    const factor = (i === 0 || isOverride) ? 1 : MULTI_SITE_DISCOUNT;
    sum += Math.round(base * factor * 100) / 100;
  }
  return Math.round(sum * 100) / 100;
}

// Legacy single-ecosystem helpers. Retained for callsites that have
// NOT been migrated to pass per-site arrays yet, AND for the fallback
// path when no per-site page counts exist (the primary's ecosystem
// applies to every site). When `sites` is the number of managed sites
// and `base` is the single shared ecosystem base, the result is
// identical to the new per-site formula with all sites at the same
// base.
export function computeMultiSiteMonthly(base: number, sites: number): number {
  const n = Math.max(1, sites);
  return computeMultiSiteSum(Array(n).fill(base));
}

export function computeMultiSiteOnboarding(base: number, sites: number): number {
  const n = Math.max(1, sites);
  return computeMultiSiteSum(Array(n).fill(base));
}

// Build the per-site base arrays from ctx.managedSites + the chosen
// tier. Each site routes to its own ecosystem via its page_count;
// sites whose page_count is null fall back to the primary site's
// ecosystem. Returns [monthlyBases[], onboardingBases[]] aligned per
// site, primary first.
//
// When ctx.managedSites is empty/undefined, the caller falls back to
// ctx.variables.site_count + ctx.ecosystemId (the legacy single-
// ecosystem flow). This function is only relevant when managedSites
// is populated.
export function buildPerSiteBases(args: {
  managedSites: Array<{
    is_primary?: boolean;
    page_count?: number | null;
    monthly_override?: number | null;
    onboarding_override?: number | null;
  }>;
  tierId: TierId;
  primaryEcosystemId: EcosystemId;
}): {
  monthlyBases: number[];
  onboardingBases: number[];
  hoursBases: number[];
  monthlyPerSite: PerSiteBase[];
  onboardingPerSite: PerSiteBase[];
} {
  // Sort so primary is first; the discount applies to the rest.
  const sorted = [...args.managedSites].sort((a, b) => {
    if (!!a.is_primary === !!b.is_primary) return 0;
    return a.is_primary ? -1 : 1;
  });
  const monthlyBases: number[] = [];
  const onboardingBases: number[] = [];
  const hoursBases: number[] = [];
  const monthlyPerSite: PerSiteBase[] = [];
  const onboardingPerSite: PerSiteBase[] = [];
  for (const site of sorted) {
    const eco = site.page_count != null
      ? (routeWebManagementEcosystem(site.page_count) || args.primaryEcosystemId)
      : args.primaryEcosystemId;
    const ecosystem = WM_ECOSYSTEMS[eco];
    const tier = ecosystem?.tiers[args.tierId];
    const formulaMonthly = tier?.monthly || 0;
    const formulaOnb = tier?.onb || 0;
    // Per-site override: NULL = use formula; any non-null value
    // (including 0) = use the override and skip the multi-site
    // multiplier for this site.
    const monthlyIsOverride = site.monthly_override != null;
    const onbIsOverride = site.onboarding_override != null;
    const monthlyBase = monthlyIsOverride ? site.monthly_override! : formulaMonthly;
    const onbBase = onbIsOverride ? site.onboarding_override! : formulaOnb;
    monthlyBases.push(monthlyBase);
    onboardingBases.push(onbBase);
    // Hours are NOT discounted (Cody 2026-05-30): each site contributes
    // its full tier hours, pooled across all sites. So a multi-site
    // client's pool = the simple sum of every site's full tier hours.
    hoursBases.push(tier?.hours || 0);
    monthlyPerSite.push({ base: monthlyBase, isOverride: monthlyIsOverride });
    onboardingPerSite.push({ base: onbBase, isOverride: onbIsOverride });
  }
  return { monthlyBases, onboardingBases, hoursBases, monthlyPerSite, onboardingPerSite };
}

// Apply a picked BuildOption's wm_site_modifications to a managedSites
// array. Returns a new array (or the original reference if there are
// no modifications). Both computePricing and buildScheduleAContribution
// call this BEFORE pricing/rendering so the post-option state is the
// single source of truth: WM totals and Schedule A both reflect the
// modified page counts (and therefore the modified ecosystem routing).
//
// Modifications match by site_domain (case-insensitive). A modification
// that does not match any managedSite is silently ignored — the wizard
// authors them by picking from existing managed domains, but if the
// admin renames a site between picks the modification will no-op
// rather than crash.
export function applyBuildOptionSiteModifications<
  S extends { domain: string; page_count?: number | null }
>(args: {
  managedSites: S[];
  allProductVars?: Record<string, any>;
  selections?: Record<string, any>;
}): S[] {
  const pickedOption = selectedBuildOption(args);
  if (!pickedOption || !Array.isArray(pickedOption.wm_site_modifications)) return args.managedSites;
  const modMap: Record<string, number> = {};
  for (const mod of pickedOption.wm_site_modifications) {
    if (mod && typeof mod.site_domain === 'string' && typeof mod.new_page_count === 'number') {
      modMap[mod.site_domain.toLowerCase()] = mod.new_page_count;
    }
  }
  if (Object.keys(modMap).length === 0) return args.managedSites;
  return args.managedSites.map(s => {
    const key = s.domain.toLowerCase();
    return modMap[key] != null ? { ...s, page_count: modMap[key] } : s;
  });
}

// Apply the full BuildOption -> WM structural change. Modifications
// re-route existing sites. Added build sites become managed sites for
// pricing at the buyer's selected WM tier, but carry onboarding_override
// = 0 because the build fee replaces WM onboarding for the site it
// produces. This is the proposal-wide source of truth used by both WM
// pricing and Schedule A.
export function applyBuildOptionManagedSiteChanges<
  S extends ManagedSiteForPricing
>(args: {
  managedSites: S[];
  allProductVars?: Record<string, any>;
  selections?: Record<string, any>;
}): S[] {
  const pickedOption = selectedBuildOption(args);
  if (!pickedOption) return args.managedSites;

  const withMods = applyBuildOptionSiteModifications({
    managedSites: args.managedSites,
    allProductVars: args.allProductVars,
    selections: args.selections,
  });

  const added = Array.isArray(pickedOption.wm_sites_added)
    ? pickedOption.wm_sites_added
    : [];
  const validAdded = added.filter((site: any) =>
    site
    && (typeof site.domain === 'string' || typeof site.label === 'string')
    && typeof site.page_count_estimate === 'number'
    && Number.isFinite(site.page_count_estimate)
  );
  if (validAdded.length === 0) return withMods;

  const next: S[] = withMods === args.managedSites ? [...args.managedSites] : [...withMods];
  const existingDomains = new Set(
    next
      .map(s => (s.domain || '').trim().toLowerCase())
      .filter(Boolean)
  );
  for (const site of validAdded) {
    const domain = typeof site.domain === 'string' ? site.domain.trim().toLowerCase() : '';
    if (domain && existingDomains.has(domain)) continue;
    if (domain) existingDomains.add(domain);
    const label = typeof site.label === 'string' && site.label.trim()
      ? site.label.trim()
      : null;
    const isFirstSite = next.length === 0;
    next.push({
      domain: domain || '(domain confirmed at signing)',
      label,
      is_primary: isFirstSite,
      page_count: site.page_count_estimate,
      site_type: 'built',
      monthly_override: null,
      // Build-produced site: the build fee covers standing it up, so WM
      // onboarding is 0 for it. This is mechanism (C) per-site override
      // (see ProposalConfig in types.ts), NOT the reissue waiver
      // (config.waive_onboarding, mechanism A). Both can be in play in one
      // proposal (new build site + existing reissued sites) and both yield
      // $0 onboarding via different paths; do not collapse them.
      onboarding_override: 0,
    } as S);
  }
  return next;
}

function baseManagedSitesForBuildOption(args: ProductContext): ManagedSiteForPricing[] {
  const takeovers = extractTakeoverSites(args.allProductVars);
  if (args.managedSites && args.managedSites.length > 0) {
    // Existing managed sites, plus any proposed takeovers not already managed
    // (dedup by domain). Reissue/amendment case.
    const have = new Set(args.managedSites.map(s => (s.domain || '').trim().toLowerCase()));
    return [...args.managedSites, ...takeovers.filter(t => !have.has(t.domain))];
  }
  // Prospect: proposed takeover sites ARE the base existing sites under the
  // engagement. Built sites get layered on by applyBuildOptionManagedSiteChanges.
  if (takeovers.length > 0) return takeovers;
  const pickedOption = selectedBuildOption({
    allProductVars: args.allProductVars,
    selections: args.selections,
  });
  const hasStructuralWmPayload = pickedOption && (
    (Array.isArray(pickedOption.wm_sites_added) && pickedOption.wm_sites_added.length > 0)
    || (Array.isArray(pickedOption.wm_site_modifications) && pickedOption.wm_site_modifications.length > 0)
  );
  if (!hasStructuralWmPayload) return [];
  // The primary managed site is represented by a placeholder routed off WM's
  // own ecosystem (from variables.page_count); build_options.wm_sites_added
  // are ADDITIONAL sites layered on top by applyBuildOptionManagedSiteChanges.
  const sites = numberFromVar(args.variables.site_count, 1);
  return Array.from({ length: Math.max(1, sites) }, (_, i) => ({
    domain: i === 0 ? '(primary domain confirmed at signing)' : `(additional site ${i + 1} domain confirmed at signing)`,
    label: null,
    is_primary: i === 0,
    page_count: null,
    monthly_override: null,
    onboarding_override: null,
  }));
}

// =========================================================================
// Step generation
// =========================================================================

// A multi-site WM monthly + onboarding range across build options. min===max
// means a single value (one option, or all options the same total).
interface TierMoneyRange {
  monthlyMin: number; monthlyMax: number; onbMin: number; onbMax: number; hoursMin: number; hoursMax: number;
}

// Money formatter that shows cents only when present ($894.60), whole
// otherwise ($800). Used for multi-site ranges where the 0.90 additional-site
// factor yields cents, matching the hand-built Raised Bar sample.
function formatMoneyAuto(n: number): string {
  return (Math.round(n * 100) % 100 === 0)
    ? '$' + Math.round(n).toLocaleString('en-US')
    : '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function buildTierOption(args: {
  tierId: TierId;
  ecosystem: Ecosystem;
  sites: number;
  aiRecommendedTier?: TierId | null;
  // Per audit move 5: the AI's reason for recommending this tier
  // surfaces as a sub-line under the Recommended pill. Only set when
  // the tier is the AI-recommended one (skipped for non-matching
  // tiers and for product-default recommendations).
  aiRecommendedRationale?: string;
  // Optional managed sites array. When present and >= 2 sites, the
  // tier card pricing reflects per-site ecosystem routing instead of
  // priming everything off the primary's ecosystem. The features list
  // also gains a per-site breakdown line so the buyer sees how the
  // total is built. Per the 2026-05-24 locked formula. Per-site
  // monthly_override / onboarding_override (if set) bypass the
  // multi-site multiplier for that site.
  managedSites?: Array<{
    domain: string; label?: string | null; is_primary?: boolean;
    page_count?: number | null;
    monthly_override?: number | null;
    onboarding_override?: number | null;
  }>;
  // Reissue waiver: when true the onboarding fee is zeroed in pricing, so
  // the tier card must not advertise the full onboarding cost.
  waiveOnboarding?: boolean;
  // Multi-site total range across build options. When present, the card shows
  // the min-to-max monthly ("depending on your site setup") instead of the
  // single-total path, matching the hand-built Raised Bar sample.
  range?: TierMoneyRange;
}): ProposalStepOption {
  const tier = args.ecosystem.tiers[args.tierId];

  // Path A: per-site ecosystem when managedSites with page_count data
  // is present. Path B: legacy single-eco fallback otherwise.
  let monthly: number;
  let onb: number;
  let cardHours: number;
  let perSiteBreakdown: string | null = null;
  const hasPerSiteData = Array.isArray(args.managedSites)
    && args.managedSites.length > 0
    && args.managedSites.some(s => s.page_count != null);
  if (hasPerSiteData) {
    const { monthlyPerSite, onboardingPerSite, hoursBases } = buildPerSiteBases({
      managedSites: args.managedSites!,
      tierId: args.tierId,
      primaryEcosystemId: args.ecosystem.id,
    });
    monthly = computeMultiSiteSumWithOverrides(monthlyPerSite);
    onb = computeMultiSiteSumWithOverrides(onboardingPerSite);
    cardHours = hoursBases.reduce((a, b) => a + b, 0);
    // Build the per-site breakdown line for the features list.
    // Primary's contribution + each additional site's contribution.
    // Overridden sites contribute their override amount as-is; non-
    // overridden additional sites get the 0.90 multi-site factor.
    const sortedSites = [...args.managedSites!].sort((a, b) => {
      if (!!a.is_primary === !!b.is_primary) return 0;
      return a.is_primary ? -1 : 1;
    });
    const breakdownParts = sortedSites.map((s, i) => {
      const label = s.label && s.label !== s.domain ? s.label : s.domain;
      const { base, isOverride } = monthlyPerSite[i];
      const factor = (i === 0 || isOverride) ? 1 : MULTI_SITE_DISCOUNT;
      const contribution = Math.round(base * factor * 100) / 100;
      return `${formatMoney(contribution)} (${label})`;
    });
    perSiteBreakdown = `Per-site monthly: ${breakdownParts.join(' + ')} = ${formatMoney(monthly)}.`;
  } else {
    monthly = computeMultiSiteMonthly(tier.monthly || 0, args.sites);
    onb = computeMultiSiteOnboarding(tier.onb || 0, args.sites);
    // Hours pool at full rate per site (no discount): full tier hours
    // times the site count.
    cardHours = (tier.hours || 0) * Math.max(1, args.sites);
  }

  // AI's per-prospect tier recommendation overrides the static product
  // default. When AI didn't recommend a tier (or its recommendation is
  // not a valid tier id for this ecosystem), fall back to the tier
  // definition's own `recommended` flag. Per finding 3.
  const recommended = args.aiRecommendedTier
    ? args.aiRecommendedTier === args.tierId
    : !!tier.recommended;

  const features = tier.features ? [...tier.features] : [];
  if (perSiteBreakdown) {
    features.push(perSiteBreakdown);
  }

  // Surface the AI rationale only when THIS tier is the AI-recommended
  // one AND the rationale string is non-empty. Skipped for non-
  // recommended tiers and when the recommendation came from the
  // product's static default (no AI rationale exists in that case).
  const showRationale = args.aiRecommendedTier
    && args.aiRecommendedTier === args.tierId
    && typeof args.aiRecommendedRationale === 'string'
    && args.aiRecommendedRationale.trim().length > 0;

  // Multi-site range across build options (the hand-built Raised Bar pattern):
  // show min-to-max monthly + a "depending on your site setup" subline. Takes
  // precedence over the single-total path above when supplied.
  if (args.range) {
    const { monthlyMin, monthlyMax, onbMin, onbMax, hoursMin, hoursMax } = args.range;
    const isMonthlyRange = Math.round(monthlyMin * 100) !== Math.round(monthlyMax * 100);
    const onbLabel = (Math.round(onbMin * 100) !== Math.round(onbMax * 100))
      ? `${formatMoneyAuto(onbMin)} – ${formatMoneyAuto(onbMax)} one-time setup`
      : `${formatMoneyAuto(onbMin)} one-time setup`;
    return {
      id: args.tierId,
      name: tier.name,
      tagline: tier.tagline,
      recommended,
      recommended_rationale: showRationale ? args.aiRecommendedRationale!.trim() : undefined,
      price_label: isMonthlyRange
        ? `${formatMoneyAuto(monthlyMin)} – ${formatMoneyAuto(monthlyMax)}`
        : formatMoneyAuto(monthlyMin),
      price_suffix: '/ month',
      price_subline: args.waiveOnboarding
        ? 'Setup waived'
        : (isMonthlyRange ? `${onbLabel}, depending on the option you pick` : onbLabel),
      included_hours: hoursMin === hoursMax ? hoursMin : undefined,
      included_hours_label: hoursMin === hoursMax
        ? undefined
        : `${hoursMin} to ${hoursMax} pooled hours per month, depending on the option you pick`,
      features: tier.features ? [...tier.features] : [],
    };
  }

  return {
    id: args.tierId,
    name: tier.name,
    tagline: tier.tagline,
    recommended,
    recommended_rationale: showRationale ? args.aiRecommendedRationale!.trim() : undefined,
    price_label: formatMoney(monthly),
    price_suffix: '/ month',
    price_subline: args.waiveOnboarding
      ? (args.sites > 1
          ? `Setup waived, ${args.sites} sites`
          : `Setup waived`)
      : (args.sites > 1
          ? `${formatMoney(onb)} one-time setup, ${args.sites} sites`
          : `${formatMoney(onb)} one-time setup`),
    included_hours: cardHours,
    features,
  };
}

function formatMoney(n: number): string {
  return '$' + Math.round(n).toLocaleString('en-US');
}

// =========================================================================
// Narrative snippets
// =========================================================================

// Cody-voice defaults. Snippet keys allow per-prospect overrides via
// the narrative-snippets.ts registry; this file provides the baseline
// every WM-in-scope proposal starts from. Replaceable per engagement
// through the wizard's override step.
function buildWebManagementNarrative(ctx: ProductContext): NarrativeSnippetSet {
  const sites = numberFromVar(ctx.variables.site_count, 1);
  const siteWord = sites === 1 ? 'one site' : `${sites} sites`;

  // Engagement-strategy adaptation. Light touch; one additional
  // paragraph at most when the synthesis points to a strong shape.
  // Does NOT name tiers (no-dangling-tier-references rule); steers
  // the framing instead.
  const what_i_see_paragraphs: string[] = [
    `The tier you pick sets how often I update your sites, how fast I respond when something breaks, and how many hands-on hours a month sit in your pool.`,
  ];
  const waived = ctx.waiveOnboarding === true;
  const strategy = ctx.engagementStrategy;
  if (strategy?.cody_time_intensity === 'high') {
    what_i_see_paragraphs.push(
      waived
        ? `The footprint also reads heavy on cleanup. The steady cadence keeps prioritizing stabilization of what is already in place; because this continues an existing engagement, there is no fresh onboarding to repeat.`
        : `The footprint also reads heavy on cleanup. Onboarding focuses on stabilizing what is already in place before tightening the steady cadence.`
    );
  } else if (strategy?.clv_horizon === 'churn-risk') {
    what_i_see_paragraphs.push(
      `Engagement-shape note: the priority of the first 30 days is to set a stable floor under the site, not to expand scope. Stability now, growth conversations after.`
    );
  }

  return {
    intro_lines: [
      `Web Management keeps the ${siteWord} you have under management running, secure, and improving every month.`,
    ],
    what_i_see_paragraphs,
    what_i_recommend_paragraphs: [
      sites === 1
        ? `<strong>Web Management</strong> for the site. The fee covers hosting, daily backups, security and uptime monitoring, updates at the contracted cadence, and a pool of hands-on hours for site work. Unused hours do not roll over.`
        : waived
          ? `<strong>Web Management</strong> for all ${sites} sites under one engagement, billed per site, with the hands-on hours pooled across them. Onboarding is waived because these sites were already onboarded on the prior engagement.`
          : `<strong>Web Management</strong> for all ${sites} sites under one engagement, billed per site, with the hands-on hours pooled into one monthly bucket you draw from wherever the work is. The pool grows with each site; unused hours do not roll over.`,
    ],
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

export const webManagementProduct: ProductDefinition = {
  id: 'web-management',
  name: 'Web Management',
  short_name: 'Web Management',

  variableSchema: VARIABLE_SCHEMA,

  ecosystems: WM_ECOSYSTEMS,

  routeEcosystem(variables) {
    const pageCount = numberFromVar(variables.page_count, NaN);
    if (!Number.isFinite(pageCount)) return null;
    return routeWebManagementEcosystem(pageCount);
  },

  generateSteps(ctx) {
    if (!ctx.ecosystemId) return [];
    const eco = WM_ECOSYSTEMS[ctx.ecosystemId];
    if (!eco) return [];
    const sites = numberFromVar(ctx.variables.site_count, 1);
    // AI's per-prospect tier recommendation, when present, overrides
    // the static "Better is recommended for everyone" default. Per
    // finding 3 in docs/audits/proposal-chain-audit-2026-05-24.md.
    const aiTier = ctx.engagementStrategy?.recommended_tier_per_product?.web_management?.tier;
    const aiRecommendedTier = aiTier === 'good' || aiTier === 'better' || aiTier === 'best'
      ? aiTier as TierId
      : null;
    // Per audit move 5: also pull the rationale so the recommended
    // tier card can show "why this one fits."
    const aiRecommendedRationale = ctx.engagementStrategy?.recommended_tier_per_product?.web_management?.rationale;
    // Thread managedSites into buildTierOption so per-site monthly
    // and the per-site breakdown line render correctly when multi-site.
    const managedSites = ctx.managedSites;
    // Multi-site WM tier range across build options (the hand-built Raised Bar
    // pattern): each build option's effective site list = the takeover/managed
    // base + that option's built sites; the card shows the min-to-max monthly
    // total with a "depending on your site setup" subline. Only used when build
    // options and/or takeover sites exist; a plain managed-client proposal
    // keeps buildTierOption's single-total card.
    const rangeBaseSites = baseManagedSitesForBuildOption(ctx);
    const rangeBuildOpts: any[] = Array.isArray((ctx.allProductVars as any)?.['build']?.build_options)
      ? (ctx.allProductVars as any)['build'].build_options
      : [];
    const rangeSiteLists: ManagedSiteForPricing[][] = rangeBuildOpts.length > 0
      ? rangeBuildOpts.map((o: any) => applyBuildOptionManagedSiteChanges({
          managedSites: rangeBaseSites,
          allProductVars: ctx.allProductVars,
          selections: { build_options: o?.id },
        }))
      : [rangeBaseSites];
    const useTierRange = rangeBuildOpts.length > 0 || extractTakeoverSites(ctx.allProductVars).length > 0;
    const tierRangeFor = (tierId: TierId): TierMoneyRange | undefined => {
      if (!useTierRange) return undefined;
      const totals = rangeSiteLists
        .filter(sl => sl && sl.length > 0 && sl.some(s => s.page_count != null))
        .map(sl => {
          const { monthlyPerSite, onboardingPerSite, hoursBases } = buildPerSiteBases({ managedSites: sl, tierId, primaryEcosystemId: ctx.ecosystemId! });
          const hours = hoursBases.reduce((a, b) => a + b, 0);
          return { monthly: computeMultiSiteSumWithOverrides(monthlyPerSite), onb: computeMultiSiteSumWithOverrides(onboardingPerSite), hours };
        });
      if (totals.length === 0) return undefined;
      const m = totals.map(t => t.monthly), o = totals.map(t => t.onb), h = totals.map(t => t.hours);
      return { monthlyMin: Math.min(...m), monthlyMax: Math.max(...m), onbMin: Math.min(...o), onbMax: Math.max(...o), hoursMin: Math.min(...h), hoursMax: Math.max(...h) };
    };
    const step: ProposalStep = {
      id: 'wm_tier',
      type: 'tier_picker',
      h2: 'Pick a Web Management level',
      prompt: `Good, Better, or Best for Web Management. The level sets how often I update your sites, how fast I respond when something breaks, and how many hands-on hours per month sit in your pool.`,
      options: [
        buildTierOption({ tierId: 'good', ecosystem: eco, sites, aiRecommendedTier, aiRecommendedRationale, managedSites, waiveOnboarding: ctx.waiveOnboarding === true, range: tierRangeFor('good') }),
        buildTierOption({ tierId: 'better', ecosystem: eco, sites, aiRecommendedTier, aiRecommendedRationale, managedSites, waiveOnboarding: ctx.waiveOnboarding === true, range: tierRangeFor('better') }),
        buildTierOption({ tierId: 'best', ecosystem: eco, sites, aiRecommendedTier, aiRecommendedRationale, managedSites, waiveOnboarding: ctx.waiveOnboarding === true, range: tierRangeFor('best') }),
      ],
    };
    return [step];
  },

  generateNarrativeSnippets(ctx) {
    return buildWebManagementNarrative(ctx);
  },

  computePricing(ctx) {
    if (!ctx.ecosystemId || !ctx.tierId) {
      return { monthly: 0, oneTime: 0, breakdown: [], displaySummary: {} };
    }
    const eco = WM_ECOSYSTEMS[ctx.ecosystemId];
    if (!eco) return { monthly: 0, oneTime: 0, breakdown: [], displaySummary: {} };
    const tier = eco.tiers[ctx.tierId];
    if (!tier || tier.monthly == null || tier.onb == null) {
      return { monthly: 0, oneTime: 0, breakdown: [], displaySummary: {} };
    }
    // Two pricing paths:
    //   (1) Per-site ecosystem (2026-05-24 locked formula): ctx.managedSites
    //       is populated with at least one site that has a page_count.
    //       Each site routes to its own ecosystem; bases come from
    //       buildPerSiteBases().
    //   (2) Fallback: no per-site data. All sites priced off the
    //       primary's ecosystem (ctx.ecosystemId). Uses the legacy
    //       single-base helpers, which now produce identical results
    //       to path (1) when all sites are at the same ecosystem.
    let monthly: number;
    let onb: number;
    let sitesCount: number;
    // Apply BuildOption structural changes first so the WM monthly /
    // onboarding line reflects the buyer's selected build shape at the
    // buyer's selected WM tier. Build-produced sites are included here
    // with onboarding_override = 0.
    const modifiedManagedSites = applyBuildOptionManagedSiteChanges({
      managedSites: baseManagedSitesForBuildOption(ctx),
      allProductVars: ctx.allProductVars,
      selections: ctx.selections,
    });
    const hasPerSiteData = modifiedManagedSites && modifiedManagedSites.length > 0
      && modifiedManagedSites.some(s => s.page_count != null);
    if (hasPerSiteData) {
      const { monthlyPerSite, onboardingPerSite } = buildPerSiteBases({
        managedSites: modifiedManagedSites!,
        tierId: ctx.tierId,
        primaryEcosystemId: ctx.ecosystemId,
      });
      monthly = computeMultiSiteSumWithOverrides(monthlyPerSite);
      onb = computeMultiSiteSumWithOverrides(onboardingPerSite);
      sitesCount = modifiedManagedSites!.length;
    } else {
      sitesCount = numberFromVar(ctx.variables.site_count, 1);
      monthly = computeMultiSiteMonthly(tier.monthly, sitesCount);
      onb = computeMultiSiteOnboarding(tier.onb, sitesCount);
    }
    // Reissue / already-onboarded: zero the onboarding fee. Recurring is
    // unaffected. The breakdown keeps a labeled $0 line so the waiver is
    // visible on the proposal and contract instead of silently vanishing.
    const waived = ctx.waiveOnboarding === true;
    const finalOnb = waived ? 0 : onb;
    const onbLabel = waived
      ? `Web Management onboarding (waived, existing client)`
      : `Web Management onboarding (${sitesCount === 1 ? '1 site' : `${sitesCount} sites`}, ${tier.name})`;
    return {
      monthly,
      oneTime: finalOnb,
      breakdown: [
        { label: onbLabel, amount: finalOnb },
      ],
      displaySummary: {
        tier_name: tier.name,
        ecosystem_label: eco.label,
        sites_text: sitesCount === 1 ? '1 site' : `${sitesCount} sites`,
      },
    };
  },

  buildScheduleAContribution(ctx, pricing) {
    if (!ctx.ecosystemId || !ctx.tierId) {
      return { products_purchased: { web_management: false } };
    }
    const eco = WM_ECOSYSTEMS[ctx.ecosystemId];
    const tier = eco?.tiers[ctx.tierId];
    if (!tier) return { products_purchased: { web_management: false } };

    // Reissue / already-onboarded: onboarding is waived. pricing.oneTime
    // is already 0 (computePricing honors the same flag); zero the
    // reference fee and per-site onboarding rows so Schedule A's A.5
    // table agrees with the $0 onboarding total and the A.4 at-signing
    // block. Monthly/recurring is unaffected.
    const waived = ctx.waiveOnboarding === true;

    // Per the 2026-05-24 locked multi-site formula, each site routes
    // to its OWN ecosystem and gets its OWN per-site contribution.
    // Schedule A surfaces these per-site rows so the buyer sees how
    // the total breaks down. When ctx.managedSites is empty/legacy,
    // fall back to placeholder rows priced off the primary's ecosystem.
    type SiteRow = {
      domain: string;
      description: string;
      ecosystem?: string;
      site_type?: string;
      monthly_contribution?: number;
      onboarding_contribution?: number;
      is_primary?: boolean;
    };
    let siteRows: SiteRow[];
    let sites: number;
    let pooledHours: number;
    const effectiveManagedSites = applyBuildOptionManagedSiteChanges({
      managedSites: baseManagedSitesForBuildOption(ctx),
      allProductVars: ctx.allProductVars,
      selections: ctx.selections,
    });
    if (effectiveManagedSites.length > 0) {
      // Apply BuildOption structural changes BEFORE pricing so any
      // option-added build sites and existing-site page-count changes
      // are rendered from the same effective site list used by WM
      // computePricing.
      const sorted = [...effectiveManagedSites].sort((a, b) => {
        if (!!a.is_primary === !!b.is_primary) return a.domain.localeCompare(b.domain);
        return a.is_primary ? -1 : 1;
      });
      // Compute per-site monthly + onboarding contributions using the
      // locked formula. First site (primary) at full base; each
      // additional at base * 0.90, with base routed from that site's
      // own page_count (or primary's ecosystem if null). Per-site
      // monthly_override / onboarding_override (when non-null) replace
      // the formula base AND skip the 0.90 multiplier for that site.
      siteRows = sorted.map((s, idx) => {
        const siteEco = s.page_count != null
          ? (routeWebManagementEcosystem(s.page_count) || ctx.ecosystemId!)
          : ctx.ecosystemId!;
        const siteEcoObj = WM_ECOSYSTEMS[siteEco];
        const siteTier = siteEcoObj?.tiers[ctx.tierId!];
        const monthlyFormulaBase = siteTier?.monthly || 0;
        const onbFormulaBase = siteTier?.onb || 0;
        const monthlyIsOverride = (s as any).monthly_override != null;
        const onbIsOverride = (s as any).onboarding_override != null;
        const monthlyBase = monthlyIsOverride ? (s as any).monthly_override : monthlyFormulaBase;
        const onbBase = onbIsOverride ? (s as any).onboarding_override : onbFormulaBase;
        // Primary or overridden sites skip the multiplier.
        const monthlyFactor = (idx === 0 || monthlyIsOverride) ? 1 : MULTI_SITE_DISCOUNT;
        const onbFactor = (idx === 0 || onbIsOverride) ? 1 : MULTI_SITE_DISCOUNT;
        const siteType = (s as any).site_type || 'managed';
        return {
          domain: s.label && s.label !== s.domain ? `${s.label} (${s.domain})` : s.domain,
          description: siteType === 'takeover' ? 'existing site, taken over'
            : siteType === 'built' ? 'new build'
            : (s.is_primary ? 'primary site' : ''),
          ecosystem: siteEco,
          site_type: siteType,
          monthly_contribution: Math.round(monthlyBase * monthlyFactor * 100) / 100,
          onboarding_contribution: Math.round(onbBase * onbFactor * 100) / 100,
          is_primary: !!s.is_primary,
        };
      });
      sites = sorted.length;
      // Pooled hours = sum of every site's FULL tier hours (no discount,
      // each by that site's own ecosystem+tier). Cody 2026-05-30.
      pooledHours = sorted.reduce((sum, s) => {
        const siteEco = s.page_count != null
          ? (routeWebManagementEcosystem(s.page_count) || ctx.ecosystemId!)
          : ctx.ecosystemId!;
        return sum + (WM_ECOSYSTEMS[siteEco]?.tiers[ctx.tierId!]?.hours || 0);
      }, 0);
    } else {
      sites = numberFromVar(ctx.variables.site_count, 1);
      // No per-site data; placeholder rows at primary's ecosystem.
      const baseMonthly = tier.monthly || 0;
      const baseOnb = tier.onb || 0;
      siteRows = Array.from({ length: sites }, (_, i) => {
        const factor = i === 0 ? 1 : MULTI_SITE_DISCOUNT;
        return {
          domain: i === 0 ? '(primary domain confirmed at signing)' : `(additional site ${i + 1} domain confirmed at signing)`,
          description: '',
          ecosystem: ctx.ecosystemId!,
          monthly_contribution: Math.round(baseMonthly * factor * 100) / 100,
          onboarding_contribution: Math.round(baseOnb * factor * 100) / 100,
          is_primary: i === 0,
        };
      });
      pooledHours = (tier.hours || 0) * Math.max(1, sites);
    }
    return {
      products_purchased: { web_management: true },
      wm_ecosystem_clause: WM_ECOSYSTEM_CLAUSE,
      web_management: {
        tier_name: tier.name,
        sites: waived ? siteRows.map(r => ({ ...r, onboarding_contribution: 0 })) : siteRows,
        site_count: sites,
        monthly_base: tier.monthly || 0,
        monthly_total: Math.round(pricing.monthly * 100) / 100,
        included_hours: pooledHours,
        onboarding_fee: waived ? 0 : (tier.onb || 0),
        onboarding_total: Math.round(pricing.oneTime * 100) / 100,
        update_cadence: tier.update_cadence || 'monthly',
        response_time: tier.response_time || 'standard tier response window',
        quarterly_training_sessions: tier.training_sessions ?? null,
        // Per Cody operating rule (2026-05-26): single billing
        // cadence across all sites under one agreement.
        billing_cadence_note: 'Per-site Web Management monthly fees are prorated at each site\'s go-live date to align with this engagement\'s monthly billing cadence. All sites under this agreement bill on the same monthly date thereafter, on one consolidated invoice.',
      },
      hours_addendum: { included_hours: pooledHours },
      // 2026-06-04 decision: plugin management is folded into the base Web
      // Management price for new clients (it is part of the service the tiers
      // already cover), so no separate $15/site pass-through line. Actual
      // out-of-pocket license/tool costs pass through as Reimbursements
      // (client_expenses) when they occur. ZipKit Homes is grandfathered via
      // their already-signed Schedule A (stored, unchanged). See the pricing
      // memory's 2026-06-04 plugin-fee decision.
      pass_through_items: [],
    };
  },
};
