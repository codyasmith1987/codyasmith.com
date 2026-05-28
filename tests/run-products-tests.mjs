#!/usr/bin/env node
// Product registry unit tests.
//
// Asserts:
//   - WM ecosystem routing thresholds (page count bands).
//   - WM multi-site monthly formula.
//   - WM multi-site onboarding follows the same 0.80 additional-site
//     formula, except built sites carry $0 WM onboarding.
//   - MC ecosystem routing thresholds (revenue bands).
//   - Build subsequent-build discount math (20% off each subsequent).
//   - End-to-end product_driven_v1 pricing matches expected totals.
//   - Schedule A composition for WM populates the WebManagementSection.
//
// Runs via tsx because the modules are TypeScript.

import {
  routeWebManagementEcosystem,
  computeMultiSiteMonthly,
  computeMultiSiteOnboarding,
  computeMultiSiteSum,
  computeMultiSiteSumWithOverrides,
  buildPerSiteBases,
  applyBuildOptionSiteModifications,
  MULTI_SITE_DISCOUNT,
  WM_ECOSYSTEMS,
  webManagementProduct,
} from '../src/lib/products/web-management.ts';
import {
  routeMarketingConsultingEcosystem,
  marketingConsultingProduct,
} from '../src/lib/products/marketing-consulting.ts';
import { computeBuildTotal, buildProduct } from '../src/lib/products/build.ts';
import { composeProposal } from '../src/lib/products/index.ts';
import { computePricing } from '../src/lib/proposal-pricing.ts';
import { buildScheduleA } from '../src/lib/contract-schedule.ts';
import { getSnippetCandidateKeys, lookupSnippetOverride } from '../src/lib/products/narrative-snippets.ts';

const results = [];
function test(name, pass, detail = '') {
  results.push({ name, pass, detail: String(detail).slice(0, 300) });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  if (!pass && detail) console.log(`       ${String(detail).slice(0, 300)}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function run() {
  // -------------------------------------------------------------------
  // WM ecosystem routing thresholds
  // -------------------------------------------------------------------
  test('WM: 1 page -> A', routeWebManagementEcosystem(1) === 'A');
  test('WM: 29 pages -> A', routeWebManagementEcosystem(29) === 'A');
  test('WM: 30 pages -> B', routeWebManagementEcosystem(30) === 'B', `got ${routeWebManagementEcosystem(30)}`);
  test('WM: 80 pages -> B', routeWebManagementEcosystem(80) === 'B');
  test('WM: 150 pages -> B (inclusive upper bound)', routeWebManagementEcosystem(150) === 'B', `got ${routeWebManagementEcosystem(150)}`);
  test('WM: 151 pages -> C', routeWebManagementEcosystem(151) === 'C');
  test('WM: 500 pages -> C', routeWebManagementEcosystem(500) === 'C');
  test('WM: null -> null', routeWebManagementEcosystem(null) === null);

  // -------------------------------------------------------------------
  // WM multi-site formula (2026-05-24 locked):
  // Each site routes to its own ecosystem by its own page count. Tier
  // is set once for the engagement. Primary contributes full base;
  // each additional site contributes its OWN ecosystem base * 0.80.
  // Linear, no compounding. Same discount applies to monthly AND
  // onboarding.
  // -------------------------------------------------------------------
  test('WM MULTI_SITE_DISCOUNT = 0.80', MULTI_SITE_DISCOUNT === 0.80);

  // computeMultiSiteSum: per-site array of bases, primary first.
  test('WM sum: empty = 0', computeMultiSiteSum([]) === 0);
  test('WM sum: single site [797] = 797', computeMultiSiteSum([797]) === 797);
  test('WM sum: 2 sites [797, 797] = 797 + 797*0.8 = 1434.6',
    computeMultiSiteSum([797, 797]) === 1434.6,
    `got ${computeMultiSiteSum([797, 797])}`);
  // Mixed ecosystem: primary Eco B Better $797, site2 Eco A Better
  // $497, site3 Eco C Better $1497. Per the locked formula:
  // 797 + 497*0.8 + 1497*0.8 = 797 + 397.6 + 1197.6 = 2392.2
  test('WM sum: mixed-eco [797, 497, 1497] = 2392.2',
    computeMultiSiteSum([797, 497, 1497]) === 2392.2,
    `got ${computeMultiSiteSum([797, 497, 1497])}`);

  // -------------------------------------------------------------------
  // Per-site override sum: pro-bono ($0) and grandfathered carve-outs.
  // Primary always gets full base. Additional sites get 0.80x UNLESS
  // isOverride is true, in which case they get full base because the
  // override IS the price.
  // -------------------------------------------------------------------
  test('override sum: empty = 0',
    computeMultiSiteSumWithOverrides([]) === 0);
  test('override sum: single formula site = full base',
    computeMultiSiteSumWithOverrides([{ base: 797, isOverride: false }]) === 797);
  test('override sum: 2 formula sites = primary + 0.80x additional',
    computeMultiSiteSumWithOverrides([
      { base: 797, isOverride: false },
      { base: 797, isOverride: false },
    ]) === 1434.6);
  test('override sum: pro-bono ($0) additional contributes nothing',
    computeMultiSiteSumWithOverrides([
      { base: 797, isOverride: false },
      { base: 0, isOverride: true },
    ]) === 797);
  test('override sum: grandfathered $500 additional skips 0.80 multiplier',
    computeMultiSiteSumWithOverrides([
      { base: 797, isOverride: false },
      { base: 500, isOverride: true },
    ]) === 1297,
    `got ${computeMultiSiteSumWithOverrides([{ base: 797, isOverride: false }, { base: 500, isOverride: true }])}`);
  test('override sum: mixed formula + override + pro-bono',
    computeMultiSiteSumWithOverrides([
      { base: 797, isOverride: false },  // primary, formula: 797
      { base: 497, isOverride: false },  // additional formula: 497 * 0.8 = 397.6
      { base: 500, isOverride: true },   // grandfathered: 500 (no 0.80)
      { base: 0,   isOverride: true },   // pro-bono: 0
    ]) === 1694.6,
    `got ${computeMultiSiteSumWithOverrides([{base:797,isOverride:false},{base:497,isOverride:false},{base:500,isOverride:true},{base:0,isOverride:true}])}`);
  test('override sum: primary as override still gets full base (idx 0 always full)',
    computeMultiSiteSumWithOverrides([{ base: 1000, isOverride: true }]) === 1000);

  // buildPerSiteBases now returns BOTH the legacy bases arrays AND
  // the override-aware perSite arrays. Confirm both shapes are populated.
  const overrideBases = buildPerSiteBases({
    managedSites: [
      { is_primary: true, page_count: 50, monthly_override: null, onboarding_override: null },
      { is_primary: false, page_count: 50, monthly_override: 200, onboarding_override: 0 },
    ],
    tierId: 'better',
    primaryEcosystemId: 'B',
  });
  test('buildPerSiteBases: primary site monthlyPerSite isOverride=false',
    overrideBases.monthlyPerSite[0].isOverride === false);
  test('buildPerSiteBases: site with monthly_override flags isOverride=true',
    overrideBases.monthlyPerSite[1].isOverride === true);
  test('buildPerSiteBases: site with monthly_override uses override value as base',
    overrideBases.monthlyPerSite[1].base === 200);
  test('buildPerSiteBases: site with onboarding_override=0 (pro-bono) uses 0 as base',
    overrideBases.onboardingPerSite[1].base === 0
    && overrideBases.onboardingPerSite[1].isOverride === true);

  // Legacy single-ecosystem helpers (still used for fallback when no
  // per-site page counts are available). Should yield the same result
  // as the sum form with all sites at the same base.
  test('WM monthly (legacy 1-eco): 1 site at base 497 = 497',
    computeMultiSiteMonthly(497, 1) === 497);
  test('WM monthly (legacy 1-eco): 2 sites at base 497 = 894.6',
    computeMultiSiteMonthly(497, 2) === 894.6,
    `got ${computeMultiSiteMonthly(497, 2)}`);
  test('WM monthly (legacy 1-eco): 3 sites at base 497 = 1292.2',
    computeMultiSiteMonthly(497, 3) === 1292.2,
    `got ${computeMultiSiteMonthly(497, 3)}`);

  // Onboarding now uses the SAME discount as monthly (per Cody's
  // 2026-05-24 decision). Previously full base per site; now 0.80
  // per additional site, primary at full base.
  test('WM onboarding (locked formula): 1 site at base 1200 = 1200',
    computeMultiSiteOnboarding(1200, 1) === 1200);
  test('WM onboarding (locked formula): 2 sites at base 1200 = 1200 + 0.8*1200 = 2160',
    computeMultiSiteOnboarding(1200, 2) === 2160,
    `got ${computeMultiSiteOnboarding(1200, 2)}`);
  test('WM onboarding (locked formula): 3 sites at base 1200 = 1200 + 2*0.8*1200 = 3120',
    computeMultiSiteOnboarding(1200, 3) === 3120,
    `got ${computeMultiSiteOnboarding(1200, 3)}`);

  // buildPerSiteBases: given managedSites + tier + primary ecosystem,
  // returns per-site monthly and onboarding bases. Sites without
  // page_count fall back to the primary ecosystem.
  const perSiteMixed = buildPerSiteBases({
    managedSites: [
      { is_primary: true, page_count: 100 },   // Eco B
      { is_primary: false, page_count: 15 },   // Eco A
      { is_primary: false, page_count: 200 },  // Eco C
    ],
    tierId: 'better',
    primaryEcosystemId: 'B',
  });
  test('WM buildPerSiteBases mixed-eco monthly: [797, 497, 1497]',
    JSON.stringify(perSiteMixed.monthlyBases) === JSON.stringify([797, 497, 1497]),
    `got ${JSON.stringify(perSiteMixed.monthlyBases)}`);
  test('WM buildPerSiteBases mixed-eco onboarding: [1200, 800, 2000]',
    JSON.stringify(perSiteMixed.onboardingBases) === JSON.stringify([1200, 800, 2000]),
    `got ${JSON.stringify(perSiteMixed.onboardingBases)}`);

  // Null page_count falls back to primary's ecosystem.
  const perSiteFallback = buildPerSiteBases({
    managedSites: [
      { is_primary: true, page_count: 100 },   // Eco B
      { is_primary: false, page_count: null }, // unknown -> falls back to B
    ],
    tierId: 'better',
    primaryEcosystemId: 'B',
  });
  test('WM buildPerSiteBases null-fallback uses primary eco for monthly',
    JSON.stringify(perSiteFallback.monthlyBases) === JSON.stringify([797, 797]));

  // -------------------------------------------------------------------
  // WM product computePricing end-to-end at Eco B Better, 1 + 3 sites
  // -------------------------------------------------------------------
  const wmEcoB = WM_ECOSYSTEMS['B'];
  const wmEcoBBetterMonthly = wmEcoB.tiers['better'].monthly;
  const wmEcoBBetterOnb = wmEcoB.tiers['better'].onb;
  test('WM Eco B Better monthly base = 797', wmEcoBBetterMonthly === 797);
  test('WM Eco B Better onb base = 1200', wmEcoBBetterOnb === 1200);

  const wmPricing1Site = webManagementProduct.computePricing({
    ecosystemId: 'B',
    tierId: 'better',
    variables: { page_count: 80, site_count: 1 },
    otherProducts: [],
  });
  test('WM 1 site at Eco B Better: monthly = 797',
    wmPricing1Site.monthly === 797,
    `got ${wmPricing1Site.monthly}`);
  test('WM 1 site at Eco B Better: oneTime = 1200',
    wmPricing1Site.oneTime === 1200,
    `got ${wmPricing1Site.oneTime}`);

  const wmPricing3Sites = webManagementProduct.computePricing({
    ecosystemId: 'B',
    tierId: 'better',
    variables: { page_count: 80, site_count: 3 },
    otherProducts: [],
  });
  // 797 + 2*0.8*797 = 797 + 1275.2 = 2072.2
  test('WM 3 sites at Eco B Better (single-eco fallback): monthly = 2072.2',
    wmPricing3Sites.monthly === 2072.2,
    `got ${wmPricing3Sites.monthly}`);
  // 1200 + 2*0.8*1200 = 1200 + 1920 = 3120 (locked formula, same
  // discount as monthly; previously 3600 with full-base-per-site)
  test('WM 3 sites at Eco B Better (single-eco fallback): onboarding = 3120',
    wmPricing3Sites.oneTime === 3120,
    `got ${wmPricing3Sites.oneTime}`);

  // Per-site ecosystem path: managedSites with page_count values
  // routes each site to its own ecosystem.
  const wmPricingMixed = webManagementProduct.computePricing({
    ecosystemId: 'B', // primary
    tierId: 'better',
    variables: { page_count: 100, site_count: 3 },
    otherProducts: [],
    managedSites: [
      { domain: 'primary.com', is_primary: true, page_count: 100 },   // Eco B
      { domain: 'small.com', is_primary: false, page_count: 15 },     // Eco A
      { domain: 'big.com', is_primary: false, page_count: 200 },      // Eco C
    ],
  });
  test('WM 3 sites mixed-eco (Eco B/A/C) Better: monthly = 2392.2',
    wmPricingMixed.monthly === 2392.2,
    `got ${wmPricingMixed.monthly}`);
  test('WM 3 sites mixed-eco (Eco B/A/C) Better: onboarding = 3440',
    wmPricingMixed.oneTime === 3440,
    `got ${wmPricingMixed.oneTime}`);

  // -------------------------------------------------------------------
  // MC ecosystem routing thresholds
  // -------------------------------------------------------------------
  test('MC: under-1m -> A', routeMarketingConsultingEcosystem('under-1m') === 'A');
  test('MC: 1m-to-10m -> B', routeMarketingConsultingEcosystem('1m-to-10m') === 'B');
  test('MC: over-10m -> C', routeMarketingConsultingEcosystem('over-10m') === 'C');
  test('MC: null -> null', routeMarketingConsultingEcosystem(null) === null);
  test('MC: bogus -> null', routeMarketingConsultingEcosystem('garbage') === null);

  // MC pricing end-to-end at Eco B Best
  const mcPricing = marketingConsultingProduct.computePricing({
    ecosystemId: 'B',
    tierId: 'best',
    variables: { revenue_band: '1m-to-10m' },
    otherProducts: [],
  });
  test('MC Eco B Best monthly = 1497',
    mcPricing.monthly === 1497,
    `got ${mcPricing.monthly}`);
  test('MC Eco B Best audit oneTime = 4000',
    mcPricing.oneTime === 4000,
    `got ${mcPricing.oneTime}`);

  // -------------------------------------------------------------------
  // Build subsequent-build discount: first at full, each subsequent at 80%
  // -------------------------------------------------------------------
  test('Build small x1 = 5625', computeBuildTotal('small', 1) === 5625);
  test('Build mid x1 = 11875', computeBuildTotal('mid', 1) === 11875);
  test('Build large x1 = 22500', computeBuildTotal('large', 1) === 22500);
  // small x2 = 5625 + 0.8*5625 = 10125
  test('Build small x2 = 10125 (first full, second 80% of base)',
    computeBuildTotal('small', 2) === 10125,
    `got ${computeBuildTotal('small', 2)}`);
  // small x3 = 5625 + 2*0.8*5625 = 14625
  test('Build small x3 = 14625',
    computeBuildTotal('small', 3) === 14625,
    `got ${computeBuildTotal('small', 3)}`);
  test('Build with no size = 0', computeBuildTotal(null, 1) === 0);

  // -------------------------------------------------------------------
  // End-to-end: composeProposal for WM-only at Eco B Better, then
  // computePricing through the product_driven_v1 dispatcher.
  // -------------------------------------------------------------------
  const wmOnlyConfig = composeProposal({
    client: { id: 'c1', name: 'Acme Co', slug: 'acme-co' },
    signers: [{ id: 's1', name: 'Jane Doe', email: 'jane@acme.com' }],
    products: ['web-management'],
    product_vars: { 'web-management': { page_count: 80, site_count: 1 } },
    narrative_variables: { urgency: 'tactical' },
  });
  test('composeProposal WM-only: pricing_formula = product_driven_v1',
    wmOnlyConfig.pricing_formula === 'product_driven_v1');
  test('composeProposal WM-only: products = [web-management]',
    eq(wmOnlyConfig.products, ['web-management']));
  test('composeProposal WM-only: title auto-derives "Engagement Proposal for Jane"',
    wmOnlyConfig.title === 'Engagement Proposal for Jane',
    `got "${wmOnlyConfig.title}"`);
  test('composeProposal WM-only: prepared_for = "Jane"',
    wmOnlyConfig.prepared_for === 'Jane');
  test('composeProposal WM-only: steps include wm_tier',
    wmOnlyConfig.steps.some(s => s.id === 'wm_tier'),
    JSON.stringify(wmOnlyConfig.steps.map(s => s.id)));

  // Pricing through dispatcher: prospect picks Better.
  const wmOnlyPricing = computePricing(
    wmOnlyConfig.pricing_formula,
    { wm_tier: 'better' },
    wmOnlyConfig,
  );
  test('WM-only dispatcher: monthly = 797',
    wmOnlyPricing.monthly === 797, `got ${wmOnlyPricing?.monthly}`);
  test('WM-only dispatcher: oneTime = 1200',
    wmOnlyPricing.oneTime === 1200, `got ${wmOnlyPricing?.oneTime}`);
  test('WM-only dispatcher: mgmtTierName = Better',
    wmOnlyPricing.mgmtTierName === 'Better', `got ${wmOnlyPricing?.mgmtTierName}`);

  // -------------------------------------------------------------------
  // End-to-end: composeProposal for WM + MC at Eco B both, prospect
  // picks WM Better and MC yes Best.
  // -------------------------------------------------------------------
  const comboConfig = composeProposal({
    client: { id: 'c2', name: 'Mid Co', slug: 'mid-co' },
    signers: [{ id: 's1', name: 'Bob Smith', email: 'bob@mid.com' }],
    products: ['web-management', 'marketing-consulting'],
    product_vars: {
      'web-management': { page_count: 80, site_count: 1 },
      'marketing-consulting': { revenue_band: '1m-to-10m' },
    },
    narrative_variables: { urgency: 'growth' },
  });
  test('composeProposal WM+MC: products in registry order',
    eq(comboConfig.products, ['web-management', 'marketing-consulting']));
  test('composeProposal WM+MC: steps include mc_yes_no and mc_tier (gated)',
    comboConfig.steps.some(s => s.id === 'mc_yes_no')
      && comboConfig.steps.some(s => s.id === 'mc_tier' && s.show_when?.mc_yes_no === 'yes'),
    JSON.stringify(comboConfig.steps.map(s => ({ id: s.id, show_when: s.show_when }))));

  // Prospect picks WM Better + MC yes/Best.
  const comboPricing = computePricing(
    comboConfig.pricing_formula,
    { wm_tier: 'better', mc_yes_no: 'yes', mc_tier: 'best' },
    comboConfig,
  );
  test('WM+MC dispatcher: monthly = 797 + 1497 = 2294',
    comboPricing.monthly === 2294, `got ${comboPricing?.monthly}`);
  test('WM+MC dispatcher: oneTime = 1200 + 4000 = 5200',
    comboPricing.oneTime === 5200, `got ${comboPricing?.oneTime}`);
  test('WM+MC dispatcher: mgmtTierName = Better',
    comboPricing.mgmtTierName === 'Better');
  test('WM+MC dispatcher: consultingTierName = Best',
    comboPricing.consultingTierName === 'Best');

  // Prospect declines MC (mc_yes_no=no): only WM monthly.
  const comboPricingNo = computePricing(
    comboConfig.pricing_formula,
    { wm_tier: 'better', mc_yes_no: 'no' },
    comboConfig,
  );
  test('WM+MC declined: monthly = 797 (WM only)',
    comboPricingNo.monthly === 797, `got ${comboPricingNo?.monthly}`);
  test('WM+MC declined: oneTime = 1200 (WM only)',
    comboPricingNo.oneTime === 1200, `got ${comboPricingNo?.oneTime}`);

  // -------------------------------------------------------------------
  // Schedule A composition for WM
  // -------------------------------------------------------------------
  const scheduleA = buildScheduleA({
    proposalConfig: wmOnlyConfig,
    draftSelections: { wm_tier: 'better' },
    pricing: null,
    clientMetadata: {},
    effectiveDate: '2026-05-23',
  });
  test('ScheduleA: WM section present',
    !!scheduleA.web_management,
    JSON.stringify(Object.keys(scheduleA)));
  test('ScheduleA: WM tier_name = Better',
    scheduleA.web_management?.tier_name === 'Better',
    `got ${scheduleA.web_management?.tier_name}`);
  test('ScheduleA: WM monthly_total = 797',
    scheduleA.web_management?.monthly_total === 797,
    `got ${scheduleA.web_management?.monthly_total}`);
  test('ScheduleA: WM included_hours = 8 (Eco B Better hours)',
    scheduleA.web_management?.included_hours === 8,
    `got ${scheduleA.web_management?.included_hours}`);
  test('ScheduleA: products_purchased.web_management = true',
    scheduleA.products_purchased?.web_management === true);

  // -------------------------------------------------------------------
  // Build standalone end-to-end
  // -------------------------------------------------------------------
  const buildConfig = composeProposal({
    client: { id: 'c3', name: 'Build Co', slug: 'build-co' },
    signers: [{ id: 's1', name: 'Carol Lee', email: 'carol@build.com' }],
    products: ['build'],
    product_vars: { 'build': { build_size: 'mid', build_count: 1, build_description: 'new website' } },
  });
  const buildPricing = computePricing(buildConfig.pricing_formula, {}, buildConfig);
  test('Build mid x1 dispatcher: oneTime = 11875',
    buildPricing.oneTime === 11875, `got ${buildPricing?.oneTime}`);
  test('Build mid x1 dispatcher: monthly = 0',
    buildPricing.monthly === 0, `got ${buildPricing?.monthly}`);

  // -------------------------------------------------------------------
  // Build multi-option (Raised Bar pattern) — finding 7.
  // When build_options has 2+ entries, the product emits a picker
  // step + rollout_scenarios keyed by option id, applies pricing
  // deltas from the picked option, and surfaces the option name in
  // Schedule A's build SOW reference.
  // -------------------------------------------------------------------
  const sampleBuildOptions = [
    {
      id: 'unified',
      name: 'Option 1: Unified site',
      pitch: 'One site with a focused section for the pre-sell.',
      pricing_delta: 0,
      rollout_phases: [
        { phase_num: 'Phase 1', h3: 'Build the unified site', html: 'Sections inside.' },
      ],
      schedule_a_note: 'Single site build covering both the brand and the pre-sell section.',
    },
    {
      id: 'split',
      name: 'Option 2: Split setup',
      pitch: 'A standalone pre-sell micro-site plus a separate brand site.',
      pricing_delta: 4500,
      rollout_phases: [
        { phase_num: 'Phase 1', h3: 'Micro-site first', html: 'Launch the pre-sell.' },
        { phase_num: 'Phase 2', h3: 'Brand site after', html: 'Once the pre-sell is live.' },
      ],
      schedule_a_note: 'Two separate Build SOWs: one for the micro-site, one for the brand site.',
    },
  ];

  // Step generation
  const buildStepsCtx = {
    ecosystemId: 'mid',
    tierId: null,
    variables: { build_size: 'mid', build_count: 1, build_options: sampleBuildOptions },
    otherProducts: [],
  };
  const buildSteps = buildProduct.generateSteps(buildStepsCtx);
  test('Build options: emits binary_picker step when 2 options present',
    buildSteps.length === 1 && buildSteps[0].id === 'build_options' && buildSteps[0].type === 'binary_picker',
    JSON.stringify(buildSteps.map(s => ({ id: s.id, type: s.type }))));
  test('Build options: step options match input options by id',
    buildSteps[0].options.length === 2
      && buildSteps[0].options[0].id === 'unified'
      && buildSteps[0].options[1].id === 'split');
  test('Build options: first option marked recommended (default)',
    buildSteps[0].options[0].recommended === true && buildSteps[0].options[1].recommended === false);
  test('Build options: pricing_delta surfaces as price_subline',
    buildSteps[0].options[1].price_subline === '+$4,500 vs default',
    `got ${buildSteps[0].options[1].price_subline}`);

  // Single option = no picker emitted
  const buildSingleOptCtx = {
    ecosystemId: 'mid',
    tierId: null,
    variables: { build_size: 'mid', build_count: 1, build_options: [sampleBuildOptions[0]] },
    otherProducts: [],
  };
  test('Build options: single option = no picker (skipped, needs 2+)',
    buildProduct.generateSteps(buildSingleOptCtx).length === 0);

  // Narrative scenarios
  const buildSnippets = buildProduct.generateNarrativeSnippets(buildStepsCtx);
  test('Build options: emits rollout_scenarios keyed by option id',
    buildSnippets.rollout_scenarios !== undefined
      && 'unified' in buildSnippets.rollout_scenarios
      && 'split' in buildSnippets.rollout_scenarios);
  test('Build options: rollout_scenario_step = build_options',
    buildSnippets.rollout_scenario_step === 'build_options');
  test('Build options: scenario phases carry through from BuildOption',
    buildSnippets.rollout_scenarios.split.phases.length === 2
      && buildSnippets.rollout_scenarios.split.phases[0].phase_num === 'Phase 1');

  // Pricing delta applied when an option is picked
  const buildPickedUnified = buildProduct.computePricing({
    ...buildStepsCtx,
    selections: { build_options: 'unified' },
  });
  test('Build options: picking unified (delta 0) keeps base total',
    buildPickedUnified.oneTime === 11875,
    `got ${buildPickedUnified.oneTime}`);

  const buildPickedSplit = buildProduct.computePricing({
    ...buildStepsCtx,
    selections: { build_options: 'split' },
  });
  test('Build options: picking split (+$4,500) bumps total to 16375',
    buildPickedSplit.oneTime === 16375,
    `got ${buildPickedSplit.oneTime}`);
  test('Build options: split adjustment surfaces as breakdown line',
    buildPickedSplit.breakdown.some(b => b.label.includes('Option 2: Split setup') && b.amount === 4500),
    JSON.stringify(buildPickedSplit.breakdown));

  // Nothing picked yet (default proposal-render state)
  const buildPickedNone = buildProduct.computePricing(buildStepsCtx);
  test('Build options: no selection = base total only (no delta applied)',
    buildPickedNone.oneTime === 11875,
    `got ${buildPickedNone.oneTime}`);

  // Schedule A note reflects the picked option
  const buildScheduleSplit = buildProduct.buildScheduleAContribution({
    ...buildStepsCtx,
    selections: { build_options: 'split' },
  }, buildPickedSplit);
  test('Build options: Schedule A build_sow_ref includes picked option name',
    buildScheduleSplit.build_sow_ref && buildScheduleSplit.build_sow_ref.includes('Option 2: Split setup'),
    String(buildScheduleSplit.build_sow_ref).slice(0, 200));
  test('Build options: Schedule A build_sow_ref includes schedule_a_note',
    buildScheduleSplit.build_sow_ref && buildScheduleSplit.build_sow_ref.includes('Two separate Build SOWs'),
    String(buildScheduleSplit.build_sow_ref).slice(0, 200));

  // -------------------------------------------------------------------
  // Finding 3: AI per-prospect tier recommendation reaches the
  // prospect's tier picker. Replaces the static "Better is recommended"
  // default with whichever tier AI picked for THIS prospect.
  // -------------------------------------------------------------------

  // No AI tier rec: WM tier_picker has Better marked recommended (product default)
  const wmStepsNoAI = webManagementProduct.generateSteps({
    ecosystemId: 'B',
    tierId: null,
    variables: { page_count: 80, site_count: 1 },
    otherProducts: [],
  });
  test('AI tier rec absent: WM Better still recommended (product default)',
    wmStepsNoAI[0].options.find(o => o.id === 'better').recommended === true);
  test('AI tier rec absent: WM Best not recommended',
    wmStepsNoAI[0].options.find(o => o.id === 'best').recommended === false);

  // AI recommends Best for WM
  const wmStepsAIBest = webManagementProduct.generateSteps({
    ecosystemId: 'B',
    tierId: null,
    variables: { page_count: 80, site_count: 1 },
    otherProducts: [],
    engagementStrategy: {
      sales_angles: [],
      recommended_tier_per_product: {
        web_management: { tier: 'best', rationale: 'high-touch, high time intensity' },
      },
    },
  });
  test('AI rec Best for WM: Best marked recommended',
    wmStepsAIBest[0].options.find(o => o.id === 'best').recommended === true);
  test('AI rec Best for WM: Better NO LONGER recommended (override)',
    wmStepsAIBest[0].options.find(o => o.id === 'better').recommended === false);

  // AI recommends Good for MC; MC standalone (no other products)
  const mcStepsAIGood = marketingConsultingProduct.generateSteps({
    ecosystemId: 'B',
    tierId: null,
    variables: { revenue_band: '1m-to-10m' },
    otherProducts: [],
    engagementStrategy: {
      sales_angles: [],
      recommended_tier_per_product: {
        marketing_consulting: { tier: 'good', rationale: 'low intensity, door-opener fit' },
      },
    },
  });
  test('AI rec Good for MC standalone: Good marked recommended',
    mcStepsAIGood[0].options.find(o => o.id === 'good').recommended === true);
  test('AI rec Good for MC standalone: Better NO LONGER recommended',
    mcStepsAIGood[0].options.find(o => o.id === 'better').recommended === false);

  // AI rec for WM doesn't bleed into MC's own picker (when both in scope)
  const mcStepsCombined = marketingConsultingProduct.generateSteps({
    ecosystemId: 'B',
    tierId: null,
    variables: { revenue_band: '1m-to-10m' },
    otherProducts: [{ id: 'web-management', tierId: null }],
    engagementStrategy: {
      sales_angles: [],
      recommended_tier_per_product: {
        web_management: { tier: 'best' },
        // MC has no rec; should fall back to product default (Better)
      },
    },
  });
  // The gated tier_picker is the second step (index 1).
  const mcTierStep = mcStepsCombined.find(s => s.id === 'mc_tier');
  test('AI rec for WM does not affect MC: MC Better still recommended',
    mcTierStep.options.find(o => o.id === 'better').recommended === true);

  // Invalid AI tier value: silently falls back to product default
  const wmStepsBadAI = webManagementProduct.generateSteps({
    ecosystemId: 'B',
    tierId: null,
    variables: { page_count: 80, site_count: 1 },
    otherProducts: [],
    engagementStrategy: {
      sales_angles: [],
      recommended_tier_per_product: {
        web_management: { tier: 'platinum' /* not a valid tier */ },
      },
    },
  });
  test('AI invalid tier: WM falls back to product default (Better)',
    wmStepsBadAI[0].options.find(o => o.id === 'better').recommended === true);

  // -------------------------------------------------------------------
  // Finding 4: closer tie-back. The "How this works in practice"
  // closer accepts an optional final paragraph from the matched
  // snippet's closer_tie_back field. Composer appends only when
  // present. When absent, closer reads complete without it.
  // -------------------------------------------------------------------
  // Stage a registry override that contributes a closer_tie_back.
  // (Inline test mock; the real registry lives in narrative-snippets.ts.)
  // We test the composer's append behavior indirectly via composeProposal
  // by passing a known engagement_strategy + checking the closer's tail.

  // Default (no tie-back snippet): closer has 3 paragraphs.
  const closerNoTieBack = composeProposal({
    client: { id: 'ctb1', name: 'Plain Co', slug: 'plain-co' },
    signers: [{ id: 's1', name: 'Pat Doe', email: 'pat@plain.com' }],
    products: ['web-management'],
    product_vars: { 'web-management': { page_count: 80, site_count: 1 } },
  });
  const closerNoTieBackSection = closerNoTieBack.narrative.sections.find(s => s.h2 === 'How this works in practice');
  test('Finding 4: closer has 3 paragraphs when no tie-back snippet matches',
    closerNoTieBackSection && closerNoTieBackSection.paragraphs.length === 3,
    `got ${closerNoTieBackSection?.paragraphs.length}`);

  // Verify the closer paragraphs match expected content (sanity check).
  test('Finding 4: closer paragraph 1 mentions month one onboarding',
    closerNoTieBackSection.paragraphs[0].includes('Month one is onboarding'));
  test('Finding 4: closer last paragraph is change-order language',
    closerNoTieBackSection.paragraphs[2].includes('change order'));

  // -------------------------------------------------------------------
  // Phase 2: engagement-strategy synthesis flows to the composer.
  // Opener (The Situation) renders from sales_angles; closer (How this
  // works in practice) renders boundary language; per-product paragraphs
  // adapt to clv_horizon / cody_time_intensity. None of it names tiers.
  // -------------------------------------------------------------------

  // (a) composeProposal with strategy: opener + closer present
  const strategyConfig = composeProposal({
    client: { id: 'c4', name: 'Strategy Co', slug: 'strategy-co' },
    signers: [{ id: 's1', name: 'Dana Park', email: 'dana@strategy.com' }],
    products: ['web-management', 'marketing-consulting'],
    product_vars: {
      'web-management': { page_count: 80, site_count: 1 },
      'marketing-consulting': { revenue_band: '1m-to-10m' },
    },
    narrative_variables: { urgency: 'growth' },
    engagement_strategy: {
      sales_angles: [
        { angle: 'The site reads like it was set up once and left alone.', supporting_evidence: 'no copyright update past 2022' },
        { angle: 'Leadership messaging is buried below the fold on the homepage.', supporting_evidence: 'h2 placement' },
        { angle: 'Three product lines share one contact form with no routing.', supporting_evidence: 'contact page form action' },
      ],
      clv_horizon: 'long-term-stable',
      cody_time_intensity: 'medium',
    },
  });
  const strategySections = strategyConfig.narrative.sections;
  test('Phase 2: opener section "The Situation" rendered',
    strategySections.some(s => s.h2 === 'The Situation'),
    JSON.stringify(strategySections.map(s => s.h2)));
  test('Phase 2: opener paragraph contains all three angles',
    (() => {
      const opener = strategySections.find(s => s.h2 === 'The Situation');
      if (!opener) return false;
      const text = opener.paragraphs.join(' ');
      return text.includes('set up once and left alone')
        && text.includes('Leadership messaging is buried')
        && text.includes('Three product lines share');
    })());
  test('Phase 2: closer section "How this works in practice" rendered',
    strategySections.some(s => s.h2 === 'How this works in practice'),
    JSON.stringify(strategySections.map(s => s.h2)));
  test('Phase 2: closer mentions WM hours pool',
    (() => {
      const closer = strategySections.find(s => s.h2 === 'How this works in practice');
      return !!closer && closer.paragraphs.some(p => /pool of hours|hours per cycle/i.test(p));
    })());
  test('Phase 2: closer mentions MC strategy cadence',
    (() => {
      const closer = strategySections.find(s => s.h2 === 'How this works in practice');
      return !!closer && closer.paragraphs.some(p => /strategy-call/i.test(p));
    })());
  test('Phase 2: closer mentions decision turnaround (5 business days)',
    (() => {
      const closer = strategySections.find(s => s.h2 === 'How this works in practice');
      return !!closer && closer.paragraphs.some(p => /five business days/i.test(p));
    })());
  test('Phase 2: closer mentions change orders',
    (() => {
      const closer = strategySections.find(s => s.h2 === 'How this works in practice');
      return !!closer && closer.paragraphs.some(p => /change order/i.test(p));
    })());
  // NOTE on inline adaptations after Phase 3: when a registry snippet
  // matches the combo, it REPLACES per-bucket inline content. The
  // Phase 2 inline adaptations (MC long-term-stable wording, WM
  // high-intensity wording) only fire when no snippet matches OR when
  // the matched snippet does not define the bucket. Snippet 4 (the
  // WM+MC catch-all) defines only what_i_recommend, so what_i_see
  // still falls through to inline for combos that land there.
  // The fixture below uses urgency=maintenance to land on snippet 4
  // catch-all (no what_i_see), so the inline adaptation does fire.
  const strategyMaintenance = composeProposal({
    client: { id: 'cM', name: 'Maintenance Co', slug: 'maintenance-co' },
    signers: [{ id: 's1', name: 'Maint Lee', email: 'maint@m.com' }],
    products: ['web-management', 'marketing-consulting'],
    product_vars: {
      'web-management': { page_count: 80, site_count: 1 },
      'marketing-consulting': { revenue_band: '1m-to-10m' },
    },
    narrative_variables: { urgency: 'maintenance' },
    engagement_strategy: {
      sales_angles: [],
      clv_horizon: 'long-term-stable',
      cody_time_intensity: 'medium',
    },
  });
  test('Phase 2: MC "long-term-stable" inline adaptation still fires for catch-all combo',
    (() => {
      const see = strategyMaintenance.narrative.sections.find(s => s.h2 === 'What I see in your business');
      return !!see && see.paragraphs.some(p => /outside thinker you call/i.test(p));
    })());
  test('Phase 2: no tier names appear in client copy (good/better/best)',
    (() => {
      const sections = strategySections.filter(s => s.h2 !== 'What I recommend');
      const text = sections.flatMap(s => s.paragraphs).join(' ').toLowerCase();
      // "Good" alone is fine as a word; "Better" can appear in compounds
      // ("better off"). The risk is the exact tier-label tokens.
      // Check for phrases that would dangle: "the Good tier", "tier Good",
      // "Better tier", etc.
      return !/\b(good|better|best)\s+tier\b/.test(text)
        && !/\btier\s+(good|better|best)\b/.test(text);
    })());

  // (b) WM cody_time_intensity=high inline adaptation. After Phase 3,
  // all three WM ecosystems have snippets that replace what_i_see.
  // To exercise the adaptation, the fixture omits page_count so the
  // WM routing returns null (no ecosystem), and the lookup falls
  // through with no registry match. Inline what_i_see + adaptation
  // fires.
  const highTimeConfig = composeProposal({
    client: { id: 'c5', name: 'Heavy Co', slug: 'heavy-co' },
    signers: [{ id: 's1', name: 'Eli Roy', email: 'eli@heavy.com' }],
    products: ['web-management'],
    // page_count omitted on purpose; WM routes to null ecosystem.
    product_vars: { 'web-management': { site_count: 1 } },
    engagement_strategy: {
      sales_angles: [{ angle: 'Site is on an outdated stack.', supporting_evidence: 'wp-version meta' }],
      clv_horizon: 'medium-term',
      cody_time_intensity: 'high',
    },
  });
  test('Phase 2: WM cody_time_intensity=high inline adaptation fires when no snippet matches',
    (() => {
      const see = highTimeConfig.narrative.sections.find(s => s.h2 === 'What I see in your business');
      return !!see && see.paragraphs.some(p => /heavy on cleanup|stabilizing what is already in place/i.test(p));
    })());

  // (b.2) Move 1: internal_gaps surface as "Where the work is"
  // section between "What I see" and "What I recommend." High +
  // medium severity only; low gets dropped. Product attribution
  // appears when in-scope.
  const gapsConfig = composeProposal({
    client: { id: 'cgap', name: 'Gap Co', slug: 'gap-co' },
    signers: [{ id: 's1', name: 'Ana Lee', email: 'ana@gap.com' }],
    products: ['web-management', 'marketing-consulting'],
    product_vars: {
      'web-management': { page_count: 80, site_count: 1 },
      'marketing-consulting': { revenue_band: '1m-to-10m' },
    },
    engagement_strategy: {
      sales_angles: [{ angle: 'They sell quality.', supporting_evidence: 'homepage hero' }],
      internal_gaps: [
        { gap: 'Privacy policy still shows 2022 copyright', evidence: 'footer scrape', severity: 'medium', product_implication: 'web_management' },
        { gap: 'Product pages lack clear calls to action', evidence: 'pages all dead-end', severity: 'medium', product_implication: 'marketing_consulting' },
        { gap: 'Typo on About page', evidence: 'paragraph 3', severity: 'low' },
      ],
    },
  });
  const workSection = gapsConfig.narrative.sections.find(s => s.h2 === 'Where the work is');
  test('Move 1: "Where the work is" section renders when internal_gaps present',
    !!workSection);
  test('Move 1: section appears between "What I see" and "What I recommend"',
    (() => {
      const idxSee = gapsConfig.narrative.sections.findIndex(s => s.h2 === 'What I see in your business');
      const idxWork = gapsConfig.narrative.sections.findIndex(s => s.h2 === 'Where the work is');
      const idxRec = gapsConfig.narrative.sections.findIndex(s => s.h2 === 'What I recommend');
      return idxSee < idxWork && idxWork < idxRec;
    })());
  test('Move 1: low-severity gaps are dropped',
    (() => {
      const text = (workSection?.paragraphs || []).join(' ');
      return !text.toLowerCase().includes('typo');
    })());
  test('Move 1: medium and high severity gaps surface',
    (() => {
      const text = (workSection?.paragraphs || []).join(' ');
      return /privacy policy/i.test(text) && /calls to action/i.test(text);
    })());
  test('Move 1: in-scope product attribution renders inline',
    (() => {
      const text = (workSection?.paragraphs || []).join(' ');
      return /<strong>Web Management<\/strong>/.test(text) && /<strong>Marketing Consulting<\/strong>/.test(text);
    })());
  test('Move 1: no em or en dashes in the work section',
    (() => {
      const text = (workSection?.paragraphs || []).join(' ');
      return !/[–—]/.test(text);
    })());

  // No internal_gaps = no "Where the work is" section.
  const noGapsConfig = composeProposal({
    client: { id: 'cnogap', name: 'No Gap Co', slug: 'no-gap-co' },
    signers: [{ id: 's1', name: 'Ben Lee', email: 'ben@nogap.com' }],
    products: ['web-management'],
    product_vars: { 'web-management': { page_count: 80, site_count: 1 } },
    engagement_strategy: {
      sales_angles: [{ angle: 'Quality matters here.', supporting_evidence: 'hero text' }],
    },
  });
  test('Move 1: no internal_gaps = no "Where the work is" section',
    !noGapsConfig.narrative.sections.some(s => s.h2 === 'Where the work is'));

  // (c) composeProposal WITHOUT engagement_strategy still composes
  // cleanly (no opener; closer still renders; no errors).
  const noStrategyConfig = composeProposal({
    client: { id: 'c6', name: 'Plain Co', slug: 'plain-co' },
    signers: [{ id: 's1', name: 'Fay Lee', email: 'fay@plain.com' }],
    products: ['web-management'],
    product_vars: { 'web-management': { page_count: 80, site_count: 1 } },
  });
  test('Phase 2: no strategy = no opener',
    !noStrategyConfig.narrative.sections.some(s => s.h2 === 'The Situation'));
  test('Phase 2: no strategy = closer still present',
    noStrategyConfig.narrative.sections.some(s => s.h2 === 'How this works in practice'));

  // (d) Em / en dash guard on the new strategy-driven sections.
  test('Phase 2: opener has no em or en dashes',
    (() => {
      const opener = strategySections.find(s => s.h2 === 'The Situation');
      const text = (opener?.paragraphs || []).join(' ');
      return !/[–—]/.test(text);
    })());
  test('Phase 2: closer has no em or en dashes',
    (() => {
      const closer = strategySections.find(s => s.h2 === 'How this works in practice');
      const text = (closer?.paragraphs || []).join(' ');
      return !/[–—]/.test(text);
    })());

  // -------------------------------------------------------------------
  // Phase 3: snippet registry lookup wires combo-level snippets into
  // the composer. Each of the 8 hand-authored snippets must fire under
  // the right combination of products + ecosystem + urgency, hold the
  // voice rules, and stay clear of dangling tier references.
  // -------------------------------------------------------------------

  // (a) Snippet 1 fires for WM only / B / tactical and carries the
  // expected "Predictability is the trade" anchor sentence.
  const sn1 = composeProposal({
    client: { id: 'sc1', name: 'Acme Industries', slug: 'acme-industries' },
    signers: [{ id: 's1', name: 'Pat Lee', email: 'pat@acme.com' }],
    products: ['web-management'],
    product_vars: { 'web-management': { page_count: 80, site_count: 1 } },
    narrative_variables: { urgency: 'tactical' },
  });
  test('Phase 3 #1: WM-B-tactical snippet fires (Predictability is the trade)',
    (() => {
      const rec = sn1.narrative.sections.find(s => s.h2 === 'What I recommend');
      return !!rec && rec.paragraphs.some(p => p.includes('Predictability is the trade'));
    })());
  test('Phase 3 #1: client name substituted',
    (() => {
      const see = sn1.narrative.sections.find(s => s.h2 === 'What I see in your business');
      return !!see && see.paragraphs.some(p => p.includes("Acme Industries"));
    })());

  // (b) Snippet 2 fires for WM+MC / B / growth and carries the
  // "Strategy is named in one place" anchor sentence.
  const sn2 = composeProposal({
    client: { id: 'sc2', name: 'Mid Market Co', slug: 'mid-market-co' },
    signers: [{ id: 's1', name: 'Sam Doe', email: 'sam@mm.com' }],
    products: ['web-management', 'marketing-consulting'],
    product_vars: {
      'web-management': { page_count: 80, site_count: 1 },
      'marketing-consulting': { revenue_band: '1m-to-10m' },
    },
    narrative_variables: { urgency: 'growth', industry: 'professional-services' },
  });
  test('Phase 3 #2: WM+MC-B-growth snippet fires (Strategy is named in one place)',
    (() => {
      const rec = sn2.narrative.sections.find(s => s.h2 === 'What I recommend');
      return !!rec && rec.paragraphs.some(p => p.includes('Strategy is named in one place'));
    })());
  test('Phase 3 #2: industry phrase substituted (professional services)',
    (() => {
      const see = sn2.narrative.sections.find(s => s.h2 === 'What I see in your business');
      return !!see && see.paragraphs.some(p => p.includes('professional services businesses'));
    })());

  // (c) Snippet 3 fires for WM only / B / growth (not tactical, so
  // snippet 1 misses; falls to ::B::*).
  const sn3 = composeProposal({
    client: { id: 'sc3', name: 'Calm Co', slug: 'calm-co' },
    signers: [{ id: 's1', name: 'Riley Roe', email: 'riley@calm.com' }],
    products: ['web-management'],
    product_vars: { 'web-management': { page_count: 80, site_count: 1 } },
    narrative_variables: { urgency: 'growth' },
  });
  test('Phase 3 #3: WM-B-* fallback fires (slow erosion)',
    (() => {
      const see = sn3.narrative.sections.find(s => s.h2 === 'What I see in your business');
      return !!see && see.paragraphs.some(p => p.includes('slow erosion'));
    })());

  // (d) Snippet 4 (catch-all WM+MC) fires when ecosystem or urgency
  // does not match snippet 2's B+growth. Try ecosystem A or maintenance.
  const sn4 = composeProposal({
    client: { id: 'sc4', name: 'Catchall Co', slug: 'catchall-co' },
    signers: [{ id: 's1', name: 'Kay Lee', email: 'kay@catch.com' }],
    products: ['web-management', 'marketing-consulting'],
    product_vars: {
      'web-management': { page_count: 80, site_count: 1 },
      'marketing-consulting': { revenue_band: 'under-1m' },
    },
    narrative_variables: { urgency: 'maintenance' },
  });
  test('Phase 3 #4: WM+MC catch-all fires (execution layer wording)',
    (() => {
      const rec = sn4.narrative.sections.find(s => s.h2 === 'What I recommend');
      return !!rec && rec.paragraphs.some(p => p.includes('execution layer'));
    })());
  test('Phase 3 #4: catch-all falls back to inline what_i_see (not from snippet)',
    (() => {
      const see = sn4.narrative.sections.find(s => s.h2 === 'What I see in your business');
      // Snippet 4 does not define what_i_see; inline WM + MC defaults
      // both appear.
      return !!see && see.paragraphs.length >= 1;
    })());

  // (e) Snippet 5 (Build + WM) fires and contributes rollout_phases.
  const sn5 = composeProposal({
    client: { id: 'sc5', name: 'New Build Co', slug: 'new-build-co' },
    signers: [{ id: 's1', name: 'Jess Lee', email: 'jess@nb.com' }],
    products: ['web-management', 'build'],
    product_vars: {
      'web-management': { page_count: 80, site_count: 1 },
      'build': { build_size: 'mid', build_count: 1, build_description: 'new marketing site' },
    },
    narrative_variables: { urgency: 'tactical', industry: 'contractor' },
  });
  test('Phase 3 #5: Build+WM snippet fires (build is the entry, WM is the relationship)',
    (() => {
      const rec = sn5.narrative.sections.find(s => s.h2 === 'What I recommend');
      return !!rec && rec.paragraphs.some(p => p.includes('build is the entry'));
    })());
  test('Phase 3 #5: rollout phases present (3 phases)',
    (() => {
      const phases = sn5.narrative.rollout?.phases || [];
      return phases.length === 3
        && phases[0].h3 === 'Scoping, design, and build'
        && phases[1].h3 === 'Launch and handoff to management'
        && phases[2].h3 === 'Ongoing site management';
    })());

  // (f) Snippet 6 (MC only / B) fires.
  const sn6 = composeProposal({
    client: { id: 'sc6', name: 'MC Co', slug: 'mc-co' },
    signers: [{ id: 's1', name: 'Lou Ray', email: 'lou@mc.com' }],
    products: ['marketing-consulting'],
    product_vars: { 'marketing-consulting': { revenue_band: '1m-to-10m' } },
    narrative_variables: { urgency: 'growth' },
  });
  test('Phase 3 #6: MC-only B snippet fires (thinking-partner subscription)',
    (() => {
      const rec = sn6.narrative.sections.find(s => s.h2 === 'What I recommend');
      return !!rec && rec.paragraphs.some(p => p.includes('thinking-partner subscription'));
    })());

  // (g) Snippet 7 (WM large) fires.
  const sn7 = composeProposal({
    client: { id: 'sc7', name: 'Big Footprint Co', slug: 'big-co' },
    signers: [{ id: 's1', name: 'Cam Roe', email: 'cam@big.com' }],
    products: ['web-management'],
    product_vars: { 'web-management': { page_count: 400, site_count: 1 } },
    narrative_variables: { urgency: 'maintenance' },
  });
  test('Phase 3 #7: WM-C snippet fires (operating infrastructure)',
    (() => {
      const intro = sn7.narrative.intro || '';
      const see = sn7.narrative.sections.find(s => s.h2 === 'What I see in your business');
      const seeText = (see?.paragraphs || []).join(' ');
      return seeText.includes('operating infrastructure')
        || intro.includes('operating infrastructure');
    })());

  // (h) Snippet 8 (WM small) fires.
  const sn8 = composeProposal({
    client: { id: 'sc8', name: 'Solo Op', slug: 'solo-op' },
    signers: [{ id: 's1', name: 'Avery Tay', email: 'avery@solo.com' }],
    products: ['web-management'],
    product_vars: { 'web-management': { page_count: 10, site_count: 1 } },
    narrative_variables: { urgency: 'maintenance' },
  });
  test('Phase 3 #8: WM-A snippet fires (small by design)',
    (() => {
      const see = sn8.narrative.sections.find(s => s.h2 === 'What I see in your business');
      return !!see && see.paragraphs.some(p => p.includes('small by design'));
    })());

  // (i) Voice guards: no em or en dashes in any snippet-emitted text.
  // No tier-name dangling references ("Better tier", "tier Good").
  for (const [label, cfg] of [['#1', sn1], ['#2', sn2], ['#3', sn3], ['#4', sn4], ['#5', sn5], ['#6', sn6], ['#7', sn7], ['#8', sn8]]) {
    const allText = (cfg.narrative.intro || '') + ' '
      + cfg.narrative.sections.flatMap(s => s.paragraphs).join(' ')
      + ' ' + (cfg.narrative.rollout?.phases || []).map(p => p.html).join(' ');
    test(`Phase 3 ${label}: no em or en dashes`, !/[–—]/.test(allText));
    test(`Phase 3 ${label}: no "tier Good/Better/Best" dangling refs`,
      !/\b(good|better|best)\s+tier\b/i.test(allText)
        && !/\btier\s+(good|better|best)\b/i.test(allText));
  }

  // (j) Fallback: a product mix with no matching snippet keeps inline
  // defaults. Use Training-only as the test fixture (Training has no
  // dedicated snippet in the registry).
  const fallbackCfg = composeProposal({
    client: { id: 'fb1', name: 'Training Only Co', slug: 'training-co' },
    signers: [{ id: 's1', name: 'Drew Smith', email: 'drew@to.com' }],
    products: ['training'],
    product_vars: { 'training': { mode: 'al-a-carte' } },
  });
  test('Phase 3 fallback: training-only composes without registry match',
    fallbackCfg.products?.length === 1 && fallbackCfg.products[0] === 'training');

  // -------------------------------------------------------------------
  // Move 2: closer_tie_back wired in all 8 existing snippets.
  // Each snippet's tie-back fires only when sales_angles[0] is present
  // and renders as the closer's final paragraph using the prospect's
  // own value prop.
  // -------------------------------------------------------------------
  const tieBackAngle = "Quality engineered solutions delivered fast.";

  // Sample each of the 8 keys with a representative compose and a
  // strategy that carries one sales angle. The closer should end with
  // the tie-back paragraph that contains the angle text verbatim.
  const tieBackCases = [
    { name: 'snippet 1 (WM B tactical)', combo: ['web-management'],
      vars: { 'web-management': { page_count: 80, site_count: 1 } },
      nv: { urgency: 'tactical' } },
    { name: 'snippet 2 (WM+MC B growth)', combo: ['web-management', 'marketing-consulting'],
      vars: { 'web-management': { page_count: 80, site_count: 1 }, 'marketing-consulting': { revenue_band: '1m-to-10m' } },
      nv: { urgency: 'growth', industry: 'professional-services' } },
    { name: 'snippet 3 (WM B *)', combo: ['web-management'],
      vars: { 'web-management': { page_count: 80, site_count: 1 } },
      nv: { urgency: 'growth' } },
    { name: 'snippet 4 (WM+MC catch-all)', combo: ['web-management', 'marketing-consulting'],
      vars: { 'web-management': { page_count: 15, site_count: 1 }, 'marketing-consulting': { revenue_band: 'under-1m' } },
      nv: { urgency: 'maintenance' } },
    { name: 'snippet 5 (Build+WM)', combo: ['web-management', 'build'],
      vars: { 'web-management': { page_count: 80, site_count: 1 }, 'build': { build_size: 'small', build_count: 1, build_description: 'A new marketing site' } },
      nv: { urgency: 'tactical' } },
    { name: 'snippet 6 (MC B)', combo: ['marketing-consulting'],
      vars: { 'marketing-consulting': { revenue_band: '1m-to-10m' } },
      nv: { urgency: 'growth' } },
    { name: 'snippet 7 (WM C)', combo: ['web-management'],
      vars: { 'web-management': { page_count: 200, site_count: 1 } },
      nv: { urgency: 'tactical' } },
    { name: 'snippet 8 (WM A)', combo: ['web-management'],
      vars: { 'web-management': { page_count: 15, site_count: 1 } },
      nv: { urgency: 'tactical' } },
  ];

  for (const tc of tieBackCases) {
    const cfg = composeProposal({
      client: { id: 'tb-' + tc.name, name: 'Tie Back Co', slug: 'tie-back-co' },
      signers: [{ id: 's1', name: 'Sam Tester', email: 'sam@tb.com' }],
      products: tc.combo,
      product_vars: tc.vars,
      narrative_variables: tc.nv,
      engagement_strategy: {
        sales_angles: [{ angle: tieBackAngle, supporting_evidence: 'hero text' }],
      },
    });
    const closer = cfg.narrative.sections.find(s => s.h2 === 'How this works in practice');
    test(`Move 2: ${tc.name} closer_tie_back fires when sales_angles[0] present`,
      !!closer && closer.paragraphs.some(p => p.includes(tieBackAngle)));
    test(`Move 2: ${tc.name} tie-back is the closer's final paragraph`,
      !!closer && closer.paragraphs.length > 0 && closer.paragraphs[closer.paragraphs.length - 1].includes(tieBackAngle));
    test(`Move 2: ${tc.name} no em or en dashes in tie-back`,
      (() => {
        if (!closer) return true;
        const last = closer.paragraphs[closer.paragraphs.length - 1] || '';
        return !/[–—]/.test(last);
      })());
  }

  // Snippet 1 without sales_angles = no tie-back appended.
  const sn1NoStrategy = composeProposal({
    client: { id: 'tb-empty', name: 'No Strategy Co', slug: 'no-strategy-co' },
    signers: [{ id: 's1', name: 'Cal Tester', email: 'cal@ns.com' }],
    products: ['web-management'],
    product_vars: { 'web-management': { page_count: 80, site_count: 1 } },
    narrative_variables: { urgency: 'tactical' },
  });
  test('Move 2: no sales_angles = no tie-back in closer',
    (() => {
      const closer = sn1NoStrategy.narrative.sections.find(s => s.h2 === 'How this works in practice');
      if (!closer) return true;
      return !closer.paragraphs.some(p => p.includes('Your own pitch leads with this:'));
    })());

  // -------------------------------------------------------------------
  // ClickUp 86ba3ww35 fix: composePricing now reads managed_sites
  // snapshot from config and threads it through buildContextForProduct,
  // matching what Schedule A does. Verifies proposal-page pricing
  // does NOT diverge from Schedule A for multi-site clients.
  // -------------------------------------------------------------------
  const multiSiteCfg = composeProposal({
    client: { id: 'ms1', name: 'Multi Site Co', slug: 'multi-site-co' },
    signers: [{ id: 's1', name: 'Mo Lee', email: 'm@ms.com' }],
    products: ['web-management'],
    product_vars: { 'web-management': { page_count: 80, site_count: 2 } },
    managedSites: [
      { domain: 'main.example.com', label: null, is_primary: true, page_count: 80 },
      { domain: 'micro.example.com', label: null, is_primary: false, page_count: 15 },
    ],
  });
  test('composePricing fix: managed_sites snapshot persists on config',
    Array.isArray(multiSiteCfg.managed_sites) && multiSiteCfg.managed_sites.length === 2);

  const proposalPagePricing = computePricing(
    multiSiteCfg.pricing_formula,
    { wm_tier: 'better' },
    multiSiteCfg,
  );
  const parityScheduleA = buildScheduleA({
    proposalConfig: multiSiteCfg,
    draftSelections: { wm_tier: 'better' },
    pricing: proposalPagePricing,
    clientMetadata: {
      legal_entity_name: 'Multi Site Co',
      entity_type: 'limited liability company',
      state_of_organization: 'Utah',
      primary_contact_name: 'Mo Lee',
      primary_contact_email: 'm@ms.com',
      primary_contact_role: 'Owner',
      principal_office_address: '1 Test St, Test City, UT 84720',
    },
    effectiveDate: '2026-05-26',
    managedSites: [
      { domain: 'main.example.com', label: null, is_primary: true, page_count: 80 },
      { domain: 'micro.example.com', label: null, is_primary: false, page_count: 15 },
    ],
  });
  const scheduleMonthly = parityScheduleA.web_management?.monthly_total;
  // Schedule A rounds to whole dollars; composePricing keeps cents.
  // The fix's goal is that BOTH paths use per-site routing (not that
  // they're penny-identical). Rounded equality is the real check —
  // before the fix, composePricing fell back to single-eco and the
  // gap was hundreds of dollars per month, not a rounding penny.
  test('composePricing fix: proposal-page WM monthly == Schedule A WM monthly (multi-site, rounded)',
    proposalPagePricing &&
    typeof scheduleMonthly === 'number' &&
    Math.round(proposalPagePricing.monthly) === scheduleMonthly,
    `proposal=${proposalPagePricing?.monthly} schedule=${scheduleMonthly}`);
  test('composePricing fix: proposal-page total uses per-site routing (not single-eco fallback)',
    proposalPagePricing &&
    // Single-eco fallback would be 1 site at $797 = $797; per-site for
    // 80+15 pages at Eco A + B should land near $1,194-1,195.
    proposalPagePricing.monthly > 1000,
    `got monthly=${proposalPagePricing?.monthly}`);

  const singleCfg = composeProposal({
    client: { id: 'ss1', name: 'Single Site Co', slug: 'single-site-co' },
    signers: [{ id: 's1', name: 'So Lee', email: 's@ss.com' }],
    products: ['web-management'],
    product_vars: { 'web-management': { page_count: 80, site_count: 1 } },
  });
  const singlePricing = computePricing(
    singleCfg.pricing_formula,
    { wm_tier: 'better' },
    singleCfg,
  );
  test('composePricing fix: single-site case unchanged (no regression)',
    singlePricing?.monthly === 797, `got ${singlePricing?.monthly}`);

  // -------------------------------------------------------------------
  // Move 9: per-product sales-angle line prepended to "What I
  // recommend" from sales_angles[].product_implication.
  // -------------------------------------------------------------------
  const angleCfg = composeProposal({
    client: { id: 'ag1', name: 'Angle Co', slug: 'angle-co' },
    signers: [{ id: 's1', name: 'Sy Lee', email: 's@ag.com' }],
    products: ['web-management', 'marketing-consulting'],
    product_vars: {
      'web-management': { page_count: 80, site_count: 1 },
      'marketing-consulting': { revenue_band: '1m-to-10m' },
    },
    engagement_strategy: {
      sales_angles: [
        { angle: 'Quality is our priority', supporting_evidence: 'hero', product_implication: 'web_management' },
        { angle: 'Personalized engineering at every step', supporting_evidence: 'about page', product_implication: 'marketing_consulting' },
        { angle: 'Designed faster than the industry average', supporting_evidence: 'about page', product_implication: 'build' },
        { angle: 'Generic angle', supporting_evidence: 'somewhere', product_implication: 'none' },
      ],
    },
  });
  const angleRecSection = angleCfg.narrative.sections.find(s => s.h2 === 'What I recommend');
  test('Move 9: per-product sales-angle line appears for WM',
    !!angleRecSection && angleRecSection.paragraphs.some(p =>
      p.includes('<strong>Web Management</strong> carries your own line forward:') &&
      p.includes('Quality is our priority')));
  test('Move 9: per-product sales-angle line appears for MC',
    !!angleRecSection && angleRecSection.paragraphs.some(p =>
      p.includes('<strong>Marketing Consulting</strong> carries your own line forward:') &&
      p.includes('Personalized engineering')));
  test('Move 9: angle for out-of-scope product (Build) is NOT included',
    !!angleRecSection && !angleRecSection.paragraphs.some(p =>
      p.includes('<strong>Build</strong> carries your own line forward:')));
  test('Move 9: generic angle (product_implication=none) is NOT surfaced per-product',
    !!angleRecSection && !angleRecSection.paragraphs.some(p =>
      p.includes('Generic angle')));
  test('Move 9: angle lines come BEFORE the inline product pitch paragraphs',
    (() => {
      if (!angleRecSection) return false;
      const angleIdx = angleRecSection.paragraphs.findIndex(p => p.includes('carries your own line forward'));
      const inlineIdx = angleRecSection.paragraphs.findIndex(p =>
        p.startsWith('I recommend') || p.includes('I recommend <strong>'));
      return angleIdx >= 0 && (inlineIdx === -1 || angleIdx < inlineIdx);
    })());

  const noImplCfg = composeProposal({
    client: { id: 'ag2', name: 'No Impl Co', slug: 'no-impl-co' },
    signers: [{ id: 's1', name: 'Sy Lee', email: 's@ni.com' }],
    products: ['web-management'],
    product_vars: { 'web-management': { page_count: 80, site_count: 1 } },
    engagement_strategy: {
      sales_angles: [
        { angle: 'Generic A', supporting_evidence: 'x' },
        { angle: 'Generic B', supporting_evidence: 'y', product_implication: 'none' },
      ],
    },
  });
  const noImplRec = noImplCfg.narrative.sections.find(s => s.h2 === 'What I recommend');
  test('Move 9: no product_implication = no angle lines',
    !!noImplRec && !noImplRec.paragraphs.some(p => p.includes('carries your own line forward')));

  // -------------------------------------------------------------------
  // Move 8: per-product rationale appended to "What I recommend" from
  // engagement_strategy.recommended_product_mix.
  // -------------------------------------------------------------------
  const mixCfg = composeProposal({
    client: { id: 'mx1', name: 'Mix Co', slug: 'mix-co' },
    signers: [{ id: 's1', name: 'Lo Lee', email: 'l@mix.com' }],
    products: ['web-management', 'marketing-consulting'],
    product_vars: {
      'web-management': { page_count: 80, site_count: 1 },
      'marketing-consulting': { revenue_band: '1m-to-10m' },
    },
    engagement_strategy: {
      sales_angles: [{ angle: 'They sell quality.', supporting_evidence: 'hero' }],
      recommended_product_mix: {
        web_management: { recommended: true, rationale: 'The 80-page site needs steady upkeep and security coverage.', confidence: 'high' },
        marketing_consulting: { recommended: true, rationale: 'Growth-mode messaging needs thinking-partner work on top of execution.', confidence: 'medium' },
        build: { recommended: false, rationale: 'The current site is functional; no build is needed.', confidence: 'high' },
      },
    },
  });
  const recSection = mixCfg.narrative.sections.find(s => s.h2 === 'What I recommend');
  test('Move 8: "Why Web Management?" paragraph appended to "What I recommend"',
    !!recSection && recSection.paragraphs.some(p => p.includes('<strong>Why Web Management?</strong>') && p.includes('steady upkeep')));
  test('Move 8: "Why Marketing Consulting?" paragraph appended',
    !!recSection && recSection.paragraphs.some(p => p.includes('<strong>Why Marketing Consulting?</strong>') && p.includes('thinking-partner')));
  test('Move 8: out-of-scope product (Build) is NOT included',
    !!recSection && !recSection.paragraphs.some(p => p.includes('<strong>Why Build?</strong>')));
  test('Move 8: rationale paragraphs end with sentence punctuation',
    (() => {
      const matches = (recSection?.paragraphs || []).filter(p => p.includes('<strong>Why '));
      return matches.length > 0 && matches.every(p => /[.!?]$/.test(p));
    })());
  test('Move 8: confidence is NOT surfaced in buyer-facing copy',
    (() => {
      const all = JSON.stringify(mixCfg.narrative);
      return !/confidence|high confidence|medium confidence/i.test(all);
    })());

  // No recommended_product_mix = no extra paragraphs appended.
  const noMixCfg = composeProposal({
    client: { id: 'mx2', name: 'No Mix Co', slug: 'no-mix-co' },
    signers: [{ id: 's1', name: 'Lo Lee', email: 'l@nomix.com' }],
    products: ['web-management'],
    product_vars: { 'web-management': { page_count: 80, site_count: 1 } },
    engagement_strategy: {
      sales_angles: [{ angle: 'Quality matters.', supporting_evidence: 'hero' }],
    },
  });
  const noMixRec = noMixCfg.narrative.sections.find(s => s.h2 === 'What I recommend');
  test('Move 8: no recommended_product_mix = no "Why" paragraphs',
    !!noMixRec && !noMixRec.paragraphs.some(p => p.includes('<strong>Why ')));

  // -------------------------------------------------------------------
  // Move 5: AI rationale surfaces under Recommended pill on tier cards.
  // -------------------------------------------------------------------
  const rationaleCfg = composeProposal({
    client: { id: 'rc1', name: 'Rationale Co', slug: 'rationale-co' },
    signers: [{ id: 's1', name: 'Vi Lee', email: 'v@rc.com' }],
    products: ['web-management'],
    product_vars: { 'web-management': { page_count: 80, site_count: 1 } },
    engagement_strategy: {
      sales_angles: [],
      recommended_tier_per_product: {
        web_management: {
          tier: 'best',
          rationale: 'Best fits the active growth posture and the multi-site footprint coming online next quarter.',
        },
      },
    },
  });
  const wmStep = rationaleCfg.steps.find(s => s.id === 'wm_tier');
  const bestOpt = wmStep?.options.find(o => o.id === 'best');
  const betterOpt = wmStep?.options.find(o => o.id === 'better');
  test('Move 5: AI rationale appears on the recommended tier card',
    !!bestOpt && bestOpt.recommended === true && typeof bestOpt.recommended_rationale === 'string' && bestOpt.recommended_rationale.includes('active growth'));
  test('Move 5: non-recommended tier cards have no rationale',
    !!betterOpt && !betterOpt.recommended_rationale);

  const defaultRecCfg = composeProposal({
    client: { id: 'rc2', name: 'Default Co', slug: 'default-co' },
    signers: [{ id: 's1', name: 'Vi Lee', email: 'v@dc.com' }],
    products: ['web-management'],
    product_vars: { 'web-management': { page_count: 80, site_count: 1 } },
  });
  const defaultBetter = defaultRecCfg.steps.find(s => s.id === 'wm_tier')?.options.find(o => o.id === 'better');
  test('Move 5: no AI rationale = no rationale on default-recommended card',
    !!defaultBetter && defaultBetter.recommended === true && !defaultBetter.recommended_rationale);

  const mcRationaleCfg = composeProposal({
    client: { id: 'rc3', name: 'MC Rationale Co', slug: 'mc-rationale-co' },
    signers: [{ id: 's1', name: 'Vi Lee', email: 'v@mc.com' }],
    products: ['marketing-consulting'],
    product_vars: { 'marketing-consulting': { revenue_band: '1m-to-10m' } },
    engagement_strategy: {
      sales_angles: [],
      recommended_tier_per_product: {
        marketing_consulting: {
          tier: 'good',
          rationale: 'Good fits the budget for an audit-first start; can step up after the first cycle.',
        },
      },
    },
  });
  const mcStep = mcRationaleCfg.steps.find(s => s.id === 'mc_tier');
  const mcGood = mcStep?.options.find(o => o.id === 'good');
  test('Move 5: MC tier card surfaces AI rationale',
    !!mcGood && mcGood.recommended === true && typeof mcGood.recommended_rationale === 'string' && mcGood.recommended_rationale.includes('audit-first'));

  // -------------------------------------------------------------------
  // Move 4: snippet key gains a fourth segment for focusPrimary.
  // 4-segment keys are tried first when focus is set; 3-segment
  // keys (existing snippets) still match as fallback. No focus =
  // identical candidate ladder to today.
  // -------------------------------------------------------------------
  const noFocusKeys = getSnippetCandidateKeys({
    productId: 'web-management',
    otherProductIds: [],
    ecosystemId: 'B',
    urgency: 'tactical',
  });
  test('Move 4: no focus = 6 candidates (3-segment only)',
    noFocusKeys.length === 6, `got ${noFocusKeys.length}`);
  test('Move 4: no focus = backward-compatible 3-segment keys present',
    noFocusKeys.includes('web-management::B::tactical') &&
    noFocusKeys.includes('web-management::*::*'));
  test('Move 4: no focus = no 4-segment keys',
    noFocusKeys.every(k => k.split('::').length === 3));

  const withFocusKeys = getSnippetCandidateKeys({
    productId: 'web-management',
    otherProductIds: [],
    ecosystemId: 'B',
    urgency: 'tactical',
    focusPrimary: 'takeover',
  });
  test('Move 4: with focus = 12 candidates (6 four-seg + 6 three-seg)',
    withFocusKeys.length === 12, `got ${withFocusKeys.length}`);
  test('Move 4: with focus = 4-seg key for primary combo comes first',
    withFocusKeys[0] === 'web-management::B::tactical::takeover');
  test('Move 4: with focus = 3-seg keys still in ladder for fallback',
    withFocusKeys.includes('web-management::B::tactical') &&
    withFocusKeys.includes('web-management::*::*'));
  test('Move 4: 4-seg combo keys come BEFORE 3-seg combo keys',
    withFocusKeys.indexOf('web-management::B::tactical::takeover') < withFocusKeys.indexOf('web-management::B::tactical'));

  const comboFocusKeys = getSnippetCandidateKeys({
    productId: 'web-management',
    otherProductIds: ['marketing-consulting'],
    ecosystemId: 'B',
    urgency: 'growth',
    focusPrimary: 'pre-sell',
  });
  test('Move 4: combo 4-seg ranks before single-product 4-seg',
    comboFocusKeys.indexOf('marketing-consulting+web-management::B::growth::pre-sell') <
    comboFocusKeys.indexOf('web-management::B::growth::pre-sell'));

  const wmBtacticalTakeover = lookupSnippetOverride({
    productId: 'web-management',
    otherProductIds: [],
    ecosystemId: 'B',
    urgency: 'tactical',
    focusPrimary: 'takeover',
  });
  test('Move 4: 4-seg lookup falls back to 3-seg snippet when no 4-seg authored',
    typeof wmBtacticalTakeover === 'function');

  const focusCompose = composeProposal({
    client: { id: 'fc1', name: 'Focus Co', slug: 'focus-co' },
    signers: [{ id: 's1', name: 'Tess Lee', email: 't@focus.com' }],
    products: ['web-management'],
    product_vars: { 'web-management': { page_count: 80, site_count: 1 } },
    narrative_variables: { urgency: 'tactical', focus: ['takeover'] },
  });
  test('Move 4: compose with focus still fires existing 3-seg snippet',
    (() => {
      const rec = focusCompose.narrative.sections.find(s => s.h2 === 'What I recommend');
      return !!rec && rec.paragraphs.some(p => p.includes('Predictability is the trade'));
    })());

  // -------------------------------------------------------------------
  // Move 3: persona_axes flow through composeProposal into the
  // engagement strategy on the returned config. (The actual DB join
  // happens at create.ts time; here we verify the type plumbing.)
  // -------------------------------------------------------------------
  const personaCfg = composeProposal({
    client: { id: 'pc1', name: 'Persona Co', slug: 'persona-co' },
    signers: [{ id: 's1', name: 'Quincy Lee', email: 'q@persona.com' }],
    products: ['web-management'],
    product_vars: { 'web-management': { page_count: 80, site_count: 1 } },
    engagement_strategy: {
      sales_angles: [{ angle: 'They sell quality.', supporting_evidence: 'hero text' }],
      persona_axes: {
        email: 'q@persona.com',
        name: 'Quincy Lee',
        sun_moon: 'sun',
        beach_mountain: 'mountain',
        spring_fall: 'spring',
        stars_clouds: 'clouds',
      },
    },
  });
  test('Move 3: persona_axes survive composeProposal',
    personaCfg.engagement_strategy?.persona_axes?.sun_moon === 'sun' &&
    personaCfg.engagement_strategy?.persona_axes?.beach_mountain === 'mountain' &&
    personaCfg.engagement_strategy?.persona_axes?.spring_fall === 'spring' &&
    personaCfg.engagement_strategy?.persona_axes?.stars_clouds === 'clouds');
  test('Move 3: persona_axes do NOT appear in narrative copy by default',
    (() => {
      const all = JSON.stringify(personaCfg.narrative);
      // The axes themselves should not leak into copy without a
      // snippet author choosing to surface them.
      return !/sun_moon|persona_axes|stars_clouds/.test(all);
    })());
  const noPersonaCfg = composeProposal({
    client: { id: 'pc2', name: 'No Persona Co', slug: 'no-persona-co' },
    signers: [{ id: 's1', name: 'Reagan Lee', email: 'r@nopersona.com' }],
    products: ['web-management'],
    product_vars: { 'web-management': { page_count: 80, site_count: 1 } },
    engagement_strategy: {
      sales_angles: [{ angle: 'They sell quality.', supporting_evidence: 'hero text' }],
    },
  });
  test('Move 3: missing persona_axes = strategy still composes cleanly',
    !!noPersonaCfg.engagement_strategy &&
    (noPersonaCfg.engagement_strategy.persona_axes === undefined ||
     noPersonaCfg.engagement_strategy.persona_axes === null));

  // -------------------------------------------------------------------
  // Cross-product BuildOption -> WM effects (Raised Bar pattern).
  // Compose a WM (Eco B Better) + Build (small) proposal with 2
  // build_options:
  //   o1: no WM delta, no extra sites
  //   o2: +1 added build site, priced dynamically from the buyer's
  //       selected WM tier; no WM onboarding on the built site
  // Pricing changes with the picked option; Schedule A WM site rows
  // grow accordingly.
  // -------------------------------------------------------------------
  const jasonCfg = composeProposal({
    client: { id: 'jr1', name: 'Jason Roth Practice', slug: 'jr-practice' },
    signers: [{ id: 's1', name: 'Jason Roth', email: 'jr@jrp.com' }],
    products: ['web-management', 'build'],
    product_vars: {
      'web-management': { page_count: 80, site_count: 1 },
      'build': {
        build_size: 'small',
        build_count: 1,
        build_description: 'Test build',
        build_options: [
          {
            id: 'o1',
            name: 'Option 1: Single site',
            pitch: 'Just the one site.',
            pricing_delta: 0,
            wm_sites_added: [],
          },
          {
            id: 'o2',
            name: 'Option 2: Split setup',
            pitch: 'Adds a micro-site.',
            pricing_delta: 4500,
            wm_sites_added: [
              { domain: 'micro.example.com', label: 'Micro-site', page_count_estimate: 10 },
            ],
          },
        ],
      },
    },
  });

  // Pricing on o1: WM Eco B Better ($797 monthly, $1200 onboarding) +
  // Build small ($5625) + no deltas
  const o1Pricing = computePricing(
    jasonCfg.pricing_formula,
    { wm_tier: 'better', build_options: 'o1' },
    jasonCfg,
  );
  test('cross-product o1: monthly = 797 (no WM delta)',
    o1Pricing.monthly === 797, `got ${o1Pricing?.monthly}`);
  test('cross-product o1: oneTime = 1200 + 5625 = 6825 (no Build/WM delta)',
    o1Pricing.oneTime === 6825, `got ${o1Pricing?.oneTime}`);

  // Pricing on o2: WM base 797 + added Eco A Better site at 0.80
  // (497 * .80 = 397.60) = 1194.60; Build base 5625 +
  // pricing_delta 4500 = 10125; WM onboarding remains 1200 because
  // the build fee replaces WM onboarding for the built micro-site.
  const o2Pricing = computePricing(
    jasonCfg.pricing_formula,
    { wm_tier: 'better', build_options: 'o2' },
    jasonCfg,
  );
  test('cross-product o2: monthly = 1194.6 (WM tier-selected dynamic added site)',
    o2Pricing.monthly === 1194.6, `got ${o2Pricing?.monthly}`);
  test('cross-product o2: oneTime = 1200 + 5625 + 4500 = 11325 (build replaces added-site WM onboarding)',
    o2Pricing.oneTime === 11325, `got ${o2Pricing?.oneTime}`);
  test('cross-product o2: breakdown does not include legacy static WM adjustment lines',
    !o2Pricing.breakdown.some(b => b.label.includes('Web Management adjustment')),
    JSON.stringify(o2Pricing.breakdown));

  // Schedule A on o2: WM section's sites array gets the added micro-site row.
  const o2Schedule = buildScheduleA({
    proposalConfig: jasonCfg,
    draftSelections: { wm_tier: 'better', build_options: 'o2' },
    pricing: o2Pricing,
    clientMetadata: {
      legal_entity_name: 'Jason Roth Practice',
      entity_type: 'limited liability company',
      state_of_organization: 'Utah',
      primary_contact_name: 'Jason Roth',
      primary_contact_email: 'jr@jrp.com',
      primary_contact_role: 'Owner',
      principal_office_address: '1 Test St, Test City, UT 84720',
    },
    effectiveDate: '2026-05-25',
  });
  const o2WmSites = o2Schedule.web_management?.sites || [];
  test('cross-product o2: Schedule A WM gains the added micro-site row',
    o2WmSites.some(s => (s.domain || '').includes('micro.example.com')),
    `got ${JSON.stringify(o2WmSites.map(s => s.domain))}`);
  test('cross-product o2: Schedule A WM site_count reflects added site',
    o2Schedule.web_management?.site_count >= 2,
    `got ${o2Schedule.web_management?.site_count}`);
  const microRow = o2WmSites.find(s => (s.domain || '').includes('micro.example.com'));
  test('cross-product o2: added build site has dynamic monthly contribution at selected tier',
    microRow?.monthly_contribution === 397.6,
    `got ${JSON.stringify(microRow)}`);
  test('cross-product o2: added build site has zero WM onboarding contribution',
    microRow?.onboarding_contribution === 0,
    `got ${JSON.stringify(microRow)}`);

  // Schedule A on o1: no added rows.
  const o1Schedule = buildScheduleA({
    proposalConfig: jasonCfg,
    draftSelections: { wm_tier: 'better', build_options: 'o1' },
    pricing: o1Pricing,
    clientMetadata: {
      legal_entity_name: 'Jason Roth Practice',
      entity_type: 'limited liability company',
      state_of_organization: 'Utah',
      primary_contact_name: 'Jason Roth',
      primary_contact_email: 'jr@jrp.com',
      primary_contact_role: 'Owner',
      principal_office_address: '1 Test St, Test City, UT 84720',
    },
    effectiveDate: '2026-05-25',
  });
  test('cross-product o1: Schedule A WM has no added rows',
    !(o1Schedule.web_management?.sites || []).some(s => (s.domain || '').includes('micro.example.com')),
    `got ${JSON.stringify((o1Schedule.web_management?.sites || []).map(s => s.domain))}`);

  // -------------------------------------------------------------------
  // BuildOption wm_site_modifications: re-route an existing managed
  // site's ecosystem when an option is picked. The composer mutates
  // managedSites internally so both computePricing and buildScheduleA
  // see the post-option page count, producing matching numbers.
  // -------------------------------------------------------------------
  const modHelperOriginal = [
    { domain: 'example.com', is_primary: true, page_count: 21 },
    { domain: 'other.example.com', is_primary: false, page_count: 50 },
  ];
  const modHelperResult = applyBuildOptionSiteModifications({
    managedSites: modHelperOriginal,
    allProductVars: {
      build: {
        build_options: [
          { id: 'm1', wm_site_modifications: [{ site_domain: 'example.com', new_page_count: 35 }] },
        ],
      },
    },
    selections: { build_options: 'm1' },
  });
  test('applyBuildOptionSiteModifications: mutates matching site page_count',
    modHelperResult[0].page_count === 35,
    `got ${modHelperResult[0].page_count}`);
  test('applyBuildOptionSiteModifications: leaves non-matching site untouched',
    modHelperResult[1].page_count === 50,
    `got ${modHelperResult[1].page_count}`);
  test('applyBuildOptionSiteModifications: does not mutate the input array',
    modHelperOriginal[0].page_count === 21,
    `got ${modHelperOriginal[0].page_count}`);
  const modHelperNoOp = applyBuildOptionSiteModifications({
    managedSites: modHelperOriginal,
    allProductVars: { build: { build_options: [{ id: 'm1', wm_site_modifications: [] }] } },
    selections: { build_options: 'm1' },
  });
  test('applyBuildOptionSiteModifications: empty modifications returns input ref',
    modHelperNoOp === modHelperOriginal);
  const modHelperNoMatch = applyBuildOptionSiteModifications({
    managedSites: modHelperOriginal,
    allProductVars: {
      build: {
        build_options: [
          { id: 'm1', wm_site_modifications: [{ site_domain: 'unknown.com', new_page_count: 99 }] },
        ],
      },
    },
    selections: { build_options: 'm1' },
  });
  test('applyBuildOptionSiteModifications: non-matching domain is a no-op',
    modHelperNoMatch[0].page_count === 21 && modHelperNoMatch[1].page_count === 50);

  // Integration: composeProposal + buildScheduleA with managedSites
  // passed directly to Schedule A. Same client with 1 managed site
  // (example.com at 21 pages, Eco A). Two options:
  //   mo1: no modifications -> site stays Eco A
  //   mo2: modify example.com to 35 pages -> site bumps to Eco B
  // Better tier numbers: Eco A 497/800, Eco B 797/1200.
  //
  // NB: composePricing (proposal page price) currently does NOT receive
  // managedSites, so modifications can't be reflected there yet. That's
  // a pre-existing architectural gap (multi-site clients see fallback
  // pricing on the proposal page). Schedule A is what binds; that path
  // does receive managedSites and is what this test verifies.
  const modCfg = composeProposal({
    client: { id: 'mod1', name: 'Mod Test Client', slug: 'mod-test' },
    signers: [{ id: 's1', name: 'Test Signer', email: 'test@example.com' }],
    products: ['web-management', 'build'],
    product_vars: {
      'web-management': { page_count: 21, site_count: 1 },
      'build': {
        build_size: 'small',
        build_count: 1,
        build_description: 'Page additions',
        build_options: [
          { id: 'mo1', name: 'Option 1: Stay at current size', pitch: 'No content changes.', pricing_delta: 0 },
          {
            id: 'mo2',
            name: 'Option 2: Add 10 pages to existing site',
            pitch: 'Bumps the site from Eco A to Eco B.',
            pricing_delta: 0,
            wm_site_modifications: [
              { site_domain: 'example.com', new_page_count: 35, note: 'adds 10 pages' },
            ],
          },
        ],
      },
    },
  });

  const modManagedSites = [
    { domain: 'example.com', is_primary: true, page_count: 21, label: null },
  ];

  const mo2Schedule = buildScheduleA({
    proposalConfig: modCfg,
    draftSelections: { wm_tier: 'better', build_options: 'mo2' },
    pricing: null,
    clientMetadata: {
      legal_entity_name: 'Mod Test Client',
      entity_type: 'limited liability company',
      state_of_organization: 'Utah',
      primary_contact_name: 'Test Signer',
      primary_contact_email: 'test@example.com',
      primary_contact_role: 'Owner',
      principal_office_address: '1 Test St, Test City, UT 84720',
    },
    effectiveDate: '2026-05-25',
    managedSites: modManagedSites,
  });
  const mo2WmSites = mo2Schedule.web_management?.sites || [];
  test('modification mo2: Schedule A renders example.com at Eco B',
    mo2WmSites.some(s => (s.domain || '').includes('example.com') && s.ecosystem === 'B'),
    `got ${JSON.stringify(mo2WmSites.map(s => ({ d: s.domain, e: s.ecosystem })))}`);
  test('modification mo2: Schedule A site has Eco B monthly contribution (797)',
    mo2WmSites.some(s => (s.domain || '').includes('example.com') && s.monthly_contribution === 797),
    `got ${JSON.stringify(mo2WmSites.map(s => ({ d: s.domain, m: s.monthly_contribution })))}`);
  test('modification mo2: Schedule A WM monthly_total = 797 (per-site re-priced at Eco B)',
    mo2Schedule.web_management?.monthly_total === 797,
    `got ${mo2Schedule.web_management?.monthly_total}`);
  test('modification mo2: Schedule A WM onboarding_total = 1200 (Eco B Better)',
    mo2Schedule.web_management?.onboarding_total === 1200,
    `got ${mo2Schedule.web_management?.onboarding_total}`);

  const mo1Schedule = buildScheduleA({
    proposalConfig: modCfg,
    draftSelections: { wm_tier: 'better', build_options: 'mo1' },
    pricing: null,
    clientMetadata: {
      legal_entity_name: 'Mod Test Client',
      entity_type: 'limited liability company',
      state_of_organization: 'Utah',
      primary_contact_name: 'Test Signer',
      primary_contact_email: 'test@example.com',
      primary_contact_role: 'Owner',
      principal_office_address: '1 Test St, Test City, UT 84720',
    },
    effectiveDate: '2026-05-25',
    managedSites: modManagedSites,
  });
  const mo1WmSites = mo1Schedule.web_management?.sites || [];
  test('modification mo1 (no mods): Schedule A renders example.com at Eco A',
    mo1WmSites.some(s => (s.domain || '').includes('example.com') && s.ecosystem === 'A'),
    `got ${JSON.stringify(mo1WmSites.map(s => ({ d: s.domain, e: s.ecosystem })))}`);
  test('modification mo1: Schedule A WM monthly_total = 497 (Eco A Better, no mod)',
    mo1Schedule.web_management?.monthly_total === 497,
    `got ${mo1Schedule.web_management?.monthly_total}`);
  test('modification mo1: input managedSites are not mutated (page_count still 21)',
    modManagedSites[0].page_count === 21);

  // -------------------------------------------------------------------
  // Schedule A with per-site monthly_override / onboarding_override.
  // Pro-bono ($0) and grandfathered ($500-ish dollar amount) cases.
  // Override skips the multi-site 0.80 multiplier AND bypasses
  // ecosystem routing for that site's per-site contribution.
  // -------------------------------------------------------------------
  const overrideCfg = composeProposal({
    client: { id: 'or-client', name: 'Override Test Client', slug: 'override-test' },
    signers: [{ name: 'Test Signer', email: 'test@example.com', role: 'Owner' }],
    products: ['web-management'],
    product_vars: {
      'web-management': { page_count: 50, site_count: 3 },
    },
    narrative_variables: {},
    managedSites: [
      // Primary: formula
      { domain: 'primary.com', label: 'Primary', is_primary: true, page_count: 50 },
      // Pro-bono: $0 override on both monthly and onboarding
      { domain: 'charity.org', label: 'Charity', is_primary: false, page_count: 50,
        monthly_override: 0, onboarding_override: 0 },
      // Grandfathered: $500 monthly, $0 onboarding (legacy ZKH-style)
      { domain: 'legacy.com', label: 'Legacy', is_primary: false, page_count: 50,
        monthly_override: 500, onboarding_override: 0 },
    ],
  });
  const overrideSchedule = buildScheduleA({
    proposalConfig: overrideCfg,
    draftSelections: { wm_tier: 'better' },
    pricing: null,
    clientMetadata: {
      legal_entity_name: 'Override Test Client',
      entity_type: 'limited liability company',
      state_of_organization: 'Utah',
      primary_contact_name: 'Test Signer',
      primary_contact_email: 'test@example.com',
      primary_contact_role: 'Owner',
      principal_office_address: '1 Test St, Test City, UT 84720',
    },
    effectiveDate: '2026-05-26',
    managedSites: overrideCfg.managed_sites,
  });
  const overrideRows = overrideSchedule.web_management?.sites || [];
  const charityRow = overrideRows.find(s => (s.domain || '').includes('charity.org'));
  const legacyRow = overrideRows.find(s => (s.domain || '').includes('legacy.com'));
  const primaryRow = overrideRows.find(s => (s.domain || '').includes('primary.com'));

  test('override schedule A: primary site contribution unaffected (797)',
    primaryRow?.monthly_contribution === 797,
    `got ${primaryRow?.monthly_contribution}`);
  test('override schedule A: pro-bono site contributes $0 monthly',
    charityRow?.monthly_contribution === 0,
    `got ${charityRow?.monthly_contribution}`);
  test('override schedule A: pro-bono site contributes $0 onboarding',
    charityRow?.onboarding_contribution === 0,
    `got ${charityRow?.onboarding_contribution}`);
  test('override schedule A: grandfathered site contributes $500 monthly (no 0.80x)',
    legacyRow?.monthly_contribution === 500,
    `got ${legacyRow?.monthly_contribution}`);
  test('override schedule A: grandfathered site contributes $0 onboarding (override)',
    legacyRow?.onboarding_contribution === 0,
    `got ${legacyRow?.onboarding_contribution}`);
  // Total = 797 (primary) + 0 (pro-bono) + 500 (grandfathered) = 1297
  test('override schedule A: WM monthly_total = 1297 (primary + pro-bono + grandfathered)',
    overrideSchedule.web_management?.monthly_total === 1297,
    `got ${overrideSchedule.web_management?.monthly_total}`);
  // Onboarding total = 1200 (primary Eco B Better) + 0 + 0 = 1200
  test('override schedule A: WM onboarding_total = 1200 (only primary contributes)',
    overrideSchedule.web_management?.onboarding_total === 1200,
    `got ${overrideSchedule.web_management?.onboarding_total}`);

  // -------------------------------------------------------------------
  // Schedule A applies client-level discount_rate uniformly to every
  // monetary field. KelseyVerse-style 100% off must show $0 across
  // the board in Schedule A, matching the proposal page total.
  // Pre-this-PR bug: discount only applied in composePricing, never
  // in buildScheduleA, so the two disagreed for any non-zero discount.
  // Bug found during the post-session audit; this test prevents
  // regression and would have caught it pre-deploy.
  // -------------------------------------------------------------------
  const discountCfg = composeProposal({
    client: { id: 'discount-test', name: 'Discount Test Client', slug: 'discount-test', discount_rate: 0.5 },
    signers: [{ name: 'Test', email: 'test@example.com', role: 'Owner' }],
    products: ['web-management'],
    product_vars: { 'web-management': { page_count: 50, site_count: 1 } },
    narrative_variables: {},
    managedSites: [
      { domain: 'discount-test.com', label: 'Primary', is_primary: true, page_count: 50 },
    ],
  });
  const discountSchedule = buildScheduleA({
    proposalConfig: discountCfg,
    draftSelections: { wm_tier: 'better' },
    pricing: null,
    clientMetadata: {
      legal_entity_name: 'Discount Test Client',
      entity_type: 'limited liability company',
      state_of_organization: 'Utah',
      primary_contact_name: 'Test',
      primary_contact_email: 'test@example.com',
      primary_contact_role: 'Owner',
      principal_office_address: '1 Test St, Test City, UT 84720',
    },
    effectiveDate: '2026-05-26',
    managedSites: discountCfg.managed_sites,
  });
  test('Schedule A 50% discount: WM monthly_total halved (797 to 398.50)',
    discountSchedule.web_management?.monthly_total === 398.5,
    `got ${discountSchedule.web_management?.monthly_total}`);
  test('Schedule A 50% discount: per-site monthly_contribution halved',
    discountSchedule.web_management?.sites?.[0]?.monthly_contribution === 398.5,
    `got ${discountSchedule.web_management?.sites?.[0]?.monthly_contribution}`);

  // 100% discount: every monetary field must be exactly 0 (KelseyVerse).
  const kelseyCfg = composeProposal({
    client: { id: 'kelsey-test', name: 'KelseyVerse', slug: 'kelseyverse', discount_rate: 1.0 },
    signers: [{ name: 'K', email: 'k@example.com', role: 'Owner' }],
    products: ['web-management', 'marketing-consulting'],
    product_vars: {
      'web-management': { page_count: 50, site_count: 1 },
      'marketing-consulting': { revenue: 500000 },
    },
    narrative_variables: {},
    managedSites: [
      { domain: 'kelseyverse.com', label: 'Primary', is_primary: true, page_count: 50 },
    ],
  });
  const kelseySchedule = buildScheduleA({
    proposalConfig: kelseyCfg,
    draftSelections: { wm_tier: 'better', mc_tier: 'better' },
    pricing: null,
    clientMetadata: {
      legal_entity_name: 'KelseyVerse',
      entity_type: 'limited liability company',
      state_of_organization: 'Utah',
      primary_contact_name: 'K',
      primary_contact_email: 'k@example.com',
      primary_contact_role: 'Owner',
      principal_office_address: '1 Test St, Test City, UT 84720',
    },
    effectiveDate: '2026-05-26',
    managedSites: kelseyCfg.managed_sites,
  });
  test('Schedule A 100% discount (KelseyVerse): WM monthly_total = 0',
    kelseySchedule.web_management?.monthly_total === 0,
    `got ${kelseySchedule.web_management?.monthly_total}`);
  test('Schedule A 100% discount (KelseyVerse): WM onboarding_fee = 0',
    kelseySchedule.web_management?.onboarding_fee === 0,
    `got ${kelseySchedule.web_management?.onboarding_fee}`);
  test('Schedule A 100% discount (KelseyVerse): every per-site contribution = 0',
    (kelseySchedule.web_management?.sites || []).every(s =>
      (s.monthly_contribution === 0 || s.monthly_contribution == null) &&
      (s.onboarding_contribution === 0 || s.onboarding_contribution == null)
    ));

  // Regression: no discount = full base (797 for Eco B Better, 1 site).
  const noDiscountCfg = composeProposal({
    client: { id: 'nodiscount', name: 'No Discount', slug: 'no-discount' },
    signers: [{ name: 'X', email: 'x@example.com', role: 'Owner' }],
    products: ['web-management'],
    product_vars: { 'web-management': { page_count: 50, site_count: 1 } },
    narrative_variables: {},
    managedSites: [
      { domain: 'nodiscount.com', is_primary: true, page_count: 50 },
    ],
  });
  const noDiscountSchedule = buildScheduleA({
    proposalConfig: noDiscountCfg,
    draftSelections: { wm_tier: 'better' },
    pricing: null,
    clientMetadata: {
      legal_entity_name: 'No Discount',
      entity_type: 'limited liability company',
      state_of_organization: 'Utah',
      primary_contact_name: 'X',
      primary_contact_email: 'x@example.com',
      primary_contact_role: 'Owner',
      principal_office_address: '1 Test St',
    },
    effectiveDate: '2026-05-26',
    managedSites: noDiscountCfg.managed_sites,
  });
  test('Schedule A no discount: WM monthly_total at full base (797)',
    noDiscountSchedule.web_management?.monthly_total === 797,
    `got ${noDiscountSchedule.web_management?.monthly_total}`);

  // -------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass);
  console.log(`\n${passed}/${results.length} passed`);
  if (failed.length > 0) {
    console.log('\nFailed:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

run().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
