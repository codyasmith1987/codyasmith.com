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
  WM_ECOSYSTEMS,
  webManagementProduct,
} from '../src/lib/products/web-management.ts';
import {
  routeMarketingConsultingEcosystem,
  marketingConsultingProduct,
} from '../src/lib/products/marketing-consulting.ts';
import { computeBuildTotal } from '../src/lib/products/build.ts';
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
  // WM multi-site monthly: base + (n-1) * base * 0.80
  // -------------------------------------------------------------------
  test('WM monthly: 1 site at base 497 = 497',
    computeMultiSiteMonthly(497, 1) === 497);
  test('WM monthly: 2 sites at base 497 = 497 + 0.8*497 = 894.6',
    computeMultiSiteMonthly(497, 2) === 894.6,
    `got ${computeMultiSiteMonthly(497, 2)}`);
  test('WM monthly: 3 sites at base 497 = 497 + 2*0.8*497 = 1292.2',
    computeMultiSiteMonthly(497, 3) === 1292.2,
    `got ${computeMultiSiteMonthly(497, 3)}`);

  // -------------------------------------------------------------------
  // WM multi-site ONBOARDING gotcha: per-site at full ecosystem base
  // (NOT discounted, per 05 Section 4)
  // -------------------------------------------------------------------
  test('WM onboarding gotcha: 1 site at base 1200 = 1200',
    computeMultiSiteOnboarding(1200, 1) === 1200);
  test('WM onboarding gotcha: 2 sites at base 1200 = 2400 (NOT 1200 + 300)',
    computeMultiSiteOnboarding(1200, 2) === 2400,
    `got ${computeMultiSiteOnboarding(1200, 2)}`);
  test('WM onboarding gotcha: 3 sites at base 1200 = 3600',
    computeMultiSiteOnboarding(1200, 3) === 3600,
    `got ${computeMultiSiteOnboarding(1200, 3)}`);

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
  test('WM 3 sites at Eco B Better: monthly = 2072.2',
    wmPricing3Sites.monthly === 2072.2,
    `got ${wmPricing3Sites.monthly}`);
  // 1200 * 3 = 3600 (per-site full base, NOT discounted)
  test('WM 3 sites at Eco B Better: onboarding = 3600 (per-site full base)',
    wmPricing3Sites.oneTime === 3600,
    `got ${wmPricing3Sites.oneTime}`);

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
  test('Phase 2: MC "long-term-stable" adapts what-i-see paragraph',
    (() => {
      const see = strategySections.find(s => s.h2 === 'What I see in your business');
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

  // (b) composeProposal with cody_time_intensity = high triggers
  // WM "heavy on cleanup" framing.
  const highTimeConfig = composeProposal({
    client: { id: 'c5', name: 'Heavy Co', slug: 'heavy-co' },
    signers: [{ id: 's1', name: 'Eli Roy', email: 'eli@heavy.com' }],
    products: ['web-management'],
    product_vars: { 'web-management': { page_count: 80, site_count: 1 } },
    engagement_strategy: {
      sales_angles: [{ angle: 'Site is on an outdated stack.', supporting_evidence: 'wp-version meta' }],
      clv_horizon: 'medium-term',
      cody_time_intensity: 'high',
    },
  });
  test('Phase 2: WM cody_time_intensity=high adds cleanup framing',
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
