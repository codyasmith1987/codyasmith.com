// Pricing formula dispatcher for proposals and contract Schedule A.
//
// Extracted from src/pages/portal/api/proposals/[slug]/accept.ts so the
// preview-mode contract page (and any future surface) can compute the
// same totals the proposal accept flow and the email summaries already
// use. Single source of truth for the formula math.

export type PricingResult = {
  oneTime: number;
  monthly: number;
  breakdown: Array<{ label: string; amount: number }>;
  mgmtMonthly: number;
  consultingMonthly: number;
  mgmtTierName: string;
  consultingTierName: string;
  siteSetupShortLabel: string;
  siteSetupLongLabel: string;
};

// raised_bar_v1 -------------------------------------------------------

export const RB_MGMT_TIERS = {
  good:   { name: 'Good',   base: 297,  onb: 800 },
  better: { name: 'Better', base: 497,  onb: 800 },
  best:   { name: 'Best',   base: 647,  onb: 1000 },
} as const;

export const RB_CONSULTING_TIERS = {
  good:   { name: 'Good',   monthly: 497,  audit: 1500 },
  better: { name: 'Better', monthly: 997,  audit: 2500 },
  best:   { name: 'Best',   monthly: 1497, audit: 4000 },
} as const;

export const RB_BUILD_BUILDERS = 5625;
export const RB_BUILD_TAILWATER = 4500;
export const RB_F3_ONBOARDING = 800;

export type RbMgmtTier = keyof typeof RB_MGMT_TIERS;
export type RbConsultingTier = keyof typeof RB_CONSULTING_TIERS;
export type RbOption = 'o1' | 'o2';

export function computeRaisedBarV1(selections: Record<string, string | null>): PricingResult | null {
  const tier = (selections.mgmt_tier || '') as RbMgmtTier;
  const opt = (selections.site_setup || '') as RbOption;
  const consulting = (selections.consulting || '') as 'yes' | 'no' | '';
  const consultingTier = (selections.consulting_tier || '') as RbConsultingTier | '';

  if (!(tier in RB_MGMT_TIERS) || (opt !== 'o1' && opt !== 'o2')) return null;
  if (consulting !== 'yes' && consulting !== 'no') return null;
  if (consulting === 'yes' && !(consultingTier in RB_CONSULTING_TIERS)) return null;

  const sites = opt === 'o2' ? 3 : 2;
  const base = RB_MGMT_TIERS[tier].base;
  const mgmtMo = base + (sites - 1) * base * 0.80;
  const consultingMo = consulting === 'yes' && consultingTier
    ? RB_CONSULTING_TIERS[consultingTier as RbConsultingTier].monthly
    : 0;

  const breakdown: Array<{ label: string; amount: number }> = [];
  breakdown.push({ label: 'Builders site build', amount: RB_BUILD_BUILDERS });
  breakdown.push({ label: 'Builders Web Management onboarding', amount: RB_MGMT_TIERS[tier].onb });
  breakdown.push({ label: 'F3 Properties takeover onboarding', amount: RB_F3_ONBOARDING });
  if (opt === 'o2') {
    breakdown.push({ label: 'Tailwater micro-site build', amount: RB_BUILD_TAILWATER });
    breakdown.push({ label: 'Tailwater multi-site onboarding addition', amount: RB_MGMT_TIERS[tier].onb * 0.25 });
  }
  if (consulting === 'yes' && consultingTier) {
    breakdown.push({
      label: `Marketing Consulting ${RB_CONSULTING_TIERS[consultingTier as RbConsultingTier].name} initial audit`,
      amount: RB_CONSULTING_TIERS[consultingTier as RbConsultingTier].audit,
    });
  }
  const oneTime = breakdown.reduce((s, r) => s + r.amount, 0);
  const monthly = mgmtMo + consultingMo;

  return {
    oneTime,
    monthly,
    breakdown,
    mgmtMonthly: mgmtMo,
    consultingMonthly: consultingMo,
    mgmtTierName: RB_MGMT_TIERS[tier].name,
    consultingTierName: consulting === 'yes' && consultingTier ? RB_CONSULTING_TIERS[consultingTier as RbConsultingTier].name : '',
    siteSetupShortLabel: opt === 'o1' ? 'Single unified site' : 'Split (with Tailwater micro-site)',
    siteSetupLongLabel: opt === 'o1'
      ? 'Option 1: Single unified site (2 sites managed)'
      : 'Option 2: Split setup with micro-site (3 sites managed)',
  };
}

// product_driven_v1 -----------------------------------------------------

// composePricing lives in the products registry; importing it as a
// value here works because products/types.ts and products/index.ts
// only type-import PricingResult from this file (no runtime circular).
import { composePricing } from './products';

// The new formula for proposals built via the product-and-variable
// composer. Reads config.products + config.product_vars, asks each
// product for its pricing contribution, and composes a PricingResult
// in the same shape the legacy raised_bar_v1 emits.
export function computeProductDrivenV1(
  selections: Record<string, string | null>,
  config: any,
): PricingResult | null {
  return composePricing({ config, selections });
}

// Dispatcher ----------------------------------------------------------

// computePricing accepts an optional config arg so product_driven_v1
// can read product_vars off the proposal. Legacy raised_bar_v1 ignores
// it. Backward-compatible: existing callers that don't pass config
// still hit the legacy path correctly.
export function computePricing(
  formula: string,
  selections: Record<string, string | null>,
  config?: any,
): PricingResult | null {
  if (formula === 'raised_bar_v1') return computeRaisedBarV1(selections);
  if (formula === 'product_driven_v1') {
    if (!config) return null;
    return computeProductDrivenV1(selections, config);
  }
  return null;
}
