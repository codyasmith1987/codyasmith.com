#!/usr/bin/env node
// Proposal-vs-Schedule A render parity tests. Audit Finding 6.
//
// For each (product, ecosystem, tier) combination, asserts that:
//   - The composed proposal's tier-card price_label matches the
//     tier definition's monthly fee.
//   - The composed pricing result's monthly + oneTime match the
//     tier definition.
//   - The Schedule A built from the same draft selection carries
//     the same monthly_base, monthly_total, and included_hours as
//     the tier definition.
//   - WM hours and MC hours in Schedule A match the tier's hours.
//
// Runs via tsx because the modules are TypeScript:
//   npx tsx tests/run-proposal-render-tests.mjs
//
// The audit spot-checked WM at Eco B Better and found no drift.
// This harness covers all 9 WM combos and all 9 MC combos plus
// WM+MC combos. Catches regressions introduced when a tier
// definition changes but Schedule A or the proposal renderer
// falls behind.

import { WM_ECOSYSTEMS } from '../src/lib/products/web-management.ts';
import { MC_ECOSYSTEMS } from '../src/lib/products/marketing-consulting.ts';
import { composeProposal } from '../src/lib/products/index.ts';
import { computePricing } from '../src/lib/proposal-pricing.ts';
import { buildScheduleA } from '../src/lib/contract-schedule.ts';

const results = [];
function test(name, pass, detail = '') {
  results.push({ name, pass, detail: String(detail).slice(0, 300) });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  if (!pass && detail) console.log(`       ${String(detail).slice(0, 300)}`);
}

const CLIENT = { id: 'render-test', name: 'Render Test Co', slug: 'render-test' };
const SIGNERS = [{ id: 's1', name: 'Render Test', email: 'render@test.com' }];

// Page counts that map cleanly to each WM ecosystem:
// Eco A < 30 pages, Eco B 30-150, Eco C > 150.
const WM_PAGES_BY_ECO = { A: 10, B: 80, C: 200 };

// Revenue bands per MC ecosystem (from MC routing rules).
// Eco A: under-1m. Eco B: 1m-to-10m. Eco C: over-10m.
const MC_REVENUE_BY_ECO = { A: 'under-1m', B: '1m-to-10m', C: 'over-10m' };

function buildScheduleAFor(config, draftSelections) {
  const pricing = computePricing(config.pricing_formula, draftSelections, config);
  return {
    pricing,
    schedule: buildScheduleA({
      proposalConfig: config,
      draftSelections,
      pricing,
      clientMetadata: {
        legal_entity_name: CLIENT.name,
        entity_type: 'limited liability company',
        state_of_organization: 'Utah',
        primary_contact_name: SIGNERS[0].name,
        primary_contact_email: SIGNERS[0].email,
        primary_contact_role: 'Owner',
        principal_office_address: '1 Test St, Test City, UT 84720',
      },
      effectiveDate: '2026-05-25',
    }),
  };
}

async function run() {
  // -------------------------------------------------------------------
  // WM ecosystem x tier parity
  // -------------------------------------------------------------------
  console.log('\n--- WM ecosystem x tier parity ---\n');
  for (const ecoId of ['A', 'B', 'C']) {
    const eco = WM_ECOSYSTEMS[ecoId];
    const pageCount = WM_PAGES_BY_ECO[ecoId];
    for (const tierId of ['good', 'better', 'best']) {
      const tier = eco.tiers[tierId];
      const label = `WM Eco${ecoId} ${tierId}`;

      const config = composeProposal({
        client: CLIENT,
        signers: SIGNERS,
        products: ['web-management'],
        product_vars: { 'web-management': { page_count: pageCount, site_count: 1 } },
        narrative_variables: {},
      });

      // Tier card from composed proposal steps.
      const wmStep = config.steps.find(s => s.id === 'wm_tier');
      const option = wmStep?.options?.find(o => o.id === tierId);
      test(`${label}: tier option exists in wm_tier step`,
        !!option, JSON.stringify(wmStep?.options?.map(o => o.id)));
      if (option) {
        const expectedPriceText = '$' + Math.round(tier.monthly).toLocaleString();
        test(`${label}: tier option price_label = ${expectedPriceText}`,
          option.price_label === expectedPriceText,
          `got "${option.price_label}"`);
        test(`${label}: tier option price_suffix = "/ month"`,
          option.price_suffix === '/ month',
          `got "${option.price_suffix}"`);
        const expectedOnbText = '$' + Math.round(tier.onb).toLocaleString();
        test(`${label}: tier option price_subline includes onb ${expectedOnbText}`,
          option.price_subline?.includes(expectedOnbText),
          `got "${option.price_subline}"`);
      }

      const { pricing, schedule } = buildScheduleAFor(config, { wm_tier: tierId });

      test(`${label}: pricing.monthly === tier.monthly (${tier.monthly})`,
        pricing.monthly === tier.monthly,
        `got ${pricing.monthly}`);
      test(`${label}: pricing.oneTime === tier.onb (${tier.onb})`,
        pricing.oneTime === tier.onb,
        `got ${pricing.oneTime}`);

      test(`${label}: Schedule A web_management.monthly_base === tier.monthly`,
        schedule.web_management?.monthly_base === tier.monthly,
        `got ${schedule.web_management?.monthly_base}`);
      test(`${label}: Schedule A web_management.monthly_total === tier.monthly (single site)`,
        schedule.web_management?.monthly_total === tier.monthly,
        `got ${schedule.web_management?.monthly_total}`);
      test(`${label}: Schedule A web_management.included_hours === tier.hours (${tier.hours})`,
        schedule.web_management?.included_hours === tier.hours,
        `got ${schedule.web_management?.included_hours}`);
    }
  }

  // -------------------------------------------------------------------
  // MC ecosystem x tier parity
  // -------------------------------------------------------------------
  console.log('\n--- MC ecosystem x tier parity ---\n');
  for (const ecoId of ['A', 'B', 'C']) {
    const eco = MC_ECOSYSTEMS[ecoId];
    const revenueBand = MC_REVENUE_BY_ECO[ecoId];
    for (const tierId of ['good', 'better', 'best']) {
      const tier = eco.tiers[tierId];
      const label = `MC Eco${ecoId} ${tierId}`;

      const config = composeProposal({
        client: CLIENT,
        signers: SIGNERS,
        products: ['marketing-consulting'],
        product_vars: { 'marketing-consulting': { revenue_band: revenueBand } },
        narrative_variables: {},
      });

      const mcStep = config.steps.find(s => s.id === 'mc_tier');
      const option = mcStep?.options?.find(o => o.id === tierId);
      test(`${label}: tier option exists in mc_tier step`,
        !!option, JSON.stringify(mcStep?.options?.map(o => o.id)));
      if (option) {
        const expectedPriceText = '$' + Math.round(tier.monthly).toLocaleString();
        test(`${label}: tier option price_label = ${expectedPriceText}`,
          option.price_label === expectedPriceText,
          `got "${option.price_label}"`);
      }

      const { pricing, schedule } = buildScheduleAFor(config, {
        mc_yes_no: 'yes',
        mc_tier: tierId,
      });

      test(`${label}: pricing.monthly === tier.monthly (${tier.monthly})`,
        pricing.monthly === tier.monthly,
        `got ${pricing.monthly}`);

      test(`${label}: Schedule A marketing_consulting present`,
        !!schedule.marketing_consulting,
        'marketing_consulting section missing on Schedule A');

      if (schedule.marketing_consulting) {
        // NOTE: MC uses monthly_retainer; WM uses monthly_base + monthly_total.
        // Naming inconsistency between sections — noted for future
        // schema unification but not a drift bug. Both come from the
        // same tier definition.
        test(`${label}: Schedule A marketing_consulting.monthly_retainer === tier.monthly`,
          schedule.marketing_consulting.monthly_retainer === tier.monthly,
          `got ${schedule.marketing_consulting.monthly_retainer}`);
        test(`${label}: Schedule A marketing_consulting.initial_audit_fee === tier.audit`,
          schedule.marketing_consulting.initial_audit_fee === tier.audit,
          `got ${schedule.marketing_consulting.initial_audit_fee}`);
        // Hours live in the shared hours_and_rates section. For
        // MC-only proposals, hours_and_rates.included_hours should
        // match the MC tier's hours.
        if (tier.hours != null) {
          test(`${label}: Schedule A hours_and_rates.included_hours === tier.hours (${tier.hours})`,
            schedule.hours_and_rates?.included_hours === tier.hours,
            `got ${schedule.hours_and_rates?.included_hours}`);
        }
      }
    }
  }

  // -------------------------------------------------------------------
  // WM + MC combo parity (the most common engagement shape)
  // -------------------------------------------------------------------
  console.log('\n--- WM + MC combo parity ---\n');
  for (const wmEco of ['A', 'B', 'C']) {
    for (const mcEco of ['A', 'B', 'C']) {
      const wmTier = WM_ECOSYSTEMS[wmEco].tiers.better;
      const mcTier = MC_ECOSYSTEMS[mcEco].tiers.better;
      const label = `Combo WM_Eco${wmEco}+MC_Eco${mcEco} better/better`;

      const config = composeProposal({
        client: CLIENT,
        signers: SIGNERS,
        products: ['web-management', 'marketing-consulting'],
        product_vars: {
          'web-management': { page_count: WM_PAGES_BY_ECO[wmEco], site_count: 1 },
          'marketing-consulting': { revenue_band: MC_REVENUE_BY_ECO[mcEco] },
        },
        narrative_variables: {},
      });

      const { pricing, schedule } = buildScheduleAFor(config, {
        wm_tier: 'better',
        mc_yes_no: 'yes',
        mc_tier: 'better',
      });

      const expectedMonthly = wmTier.monthly + mcTier.monthly;
      test(`${label}: pricing.monthly === wm+mc sum (${expectedMonthly})`,
        pricing.monthly === expectedMonthly,
        `got ${pricing.monthly}`);

      test(`${label}: Schedule A WM monthly_total === wm tier`,
        schedule.web_management?.monthly_total === wmTier.monthly,
        `got ${schedule.web_management?.monthly_total}`);

      test(`${label}: Schedule A MC monthly_retainer === mc tier`,
        schedule.marketing_consulting?.monthly_retainer === mcTier.monthly,
        `got ${schedule.marketing_consulting?.monthly_retainer}`);
    }
  }

  // -------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log(`\n=== Render parity test summary: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const r of results.filter(r => !r.pass)) {
      console.log(`  - ${r.name}: ${r.detail}`);
    }
    process.exit(1);
  }
}

run().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(2);
});
