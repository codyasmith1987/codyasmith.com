#!/usr/bin/env node
// Product registry unit tests.
//
// Asserts:
//   - WM ecosystem routing thresholds (page count bands).
//   - WM multi-site monthly formula.
//   - WM multi-site onboarding is per-site at FULL ecosystem base
//     (the gotcha per 05 Section 4; NOT the multi-site discount).
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
  buildPerSiteBases,
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
  // Cross-product BuildOption -> WM effects (Raised Bar pattern).
  // Compose a WM (Eco B Better) + Build (small) proposal with 2
  // build_options:
  //   o1: no WM delta, no extra sites
  //   o2: +$200 monthly, +$500 onboarding, +1 added site
  // Pricing changes with the picked option; Schedule A WM site rows
  // grow accordingly. Audit 2026-05-25 cross-product extension.
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
            wm_monthly_delta: 0,
            wm_onboarding_delta: 0,
            wm_sites_added: [],
          },
          {
            id: 'o2',
            name: 'Option 2: Split setup',
            pitch: 'Adds a micro-site.',
            pricing_delta: 4500,
            wm_monthly_delta: 200,
            wm_onboarding_delta: 500,
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

  // Pricing on o2: WM base 797 + delta 200 = 997; Build base 5625 +
  // pricing_delta 4500 = 10125; WM onboarding 1200 + delta 500 = 1700;
  // total oneTime = 10125 + 1700 = 11825
  const o2Pricing = computePricing(
    jasonCfg.pricing_formula,
    { wm_tier: 'better', build_options: 'o2' },
    jasonCfg,
  );
  test('cross-product o2: monthly = 997 (WM +200)',
    o2Pricing.monthly === 997, `got ${o2Pricing?.monthly}`);
  test('cross-product o2: oneTime = 1200 + 500 + 5625 + 4500 = 11825 (WM onb +500, Build +4500)',
    o2Pricing.oneTime === 11825, `got ${o2Pricing?.oneTime}`);
  test('cross-product o2: breakdown includes WM monthly adjustment line',
    o2Pricing.breakdown.some(b => b.label.includes('Web Management adjustment') && b.amount === 200),
    JSON.stringify(o2Pricing.breakdown));
  test('cross-product o2: breakdown includes WM onboarding adjustment line',
    o2Pricing.breakdown.some(b => b.label.includes('Web Management onboarding adjustment') && b.amount === 500),
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
