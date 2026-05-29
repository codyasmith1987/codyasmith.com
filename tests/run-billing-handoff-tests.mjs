#!/usr/bin/env node
// Billing-handoff derivation test.
//
// ensureBillingContractFromAgreement is DB-bound, but the terms it bills
// are derived purely from the signed Schedule A by deriveBillingTerms.
// This locks that derivation: recurring = WM monthly total + MC retainer,
// the at-signing total matches the Schedule A "Amount due at signing"
// block (and pricing.atSigning), and a build-only engagement is a
// one-time fixed contract with no recurring. Runs via tsx (TS modules).

import { computePricing } from '../src/lib/proposal-pricing.ts';
import { buildScheduleA } from '../src/lib/contract-schedule.ts';
import { deriveBillingTerms } from '../src/lib/contract-handoff.ts';

const results = [];
function test(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  if (!pass && detail) console.log(`       ${String(detail).slice(0, 300)}`);
}
const near = (a, b) => Math.abs((a ?? NaN) - b) < 0.005;

function scheduleFor(products, productVars, selections, opts = {}) {
  const config = { pricing_formula: 'product_driven_v1', products, product_vars: productVars, ...(opts.extraConfig || {}) };
  const pricing = computePricing('product_driven_v1', selections, config);
  const scheduleA = buildScheduleA({
    proposalConfig: config,
    draftSelections: selections,
    pricing,
    clientMetadata: {},
    effectiveDate: '2026-06-01',
    billingAnchorDay: opts.billingAnchorDay,
  });
  return { pricing, scheduleA };
}

function run() {
  // WM + MC retainer.
  {
    const { pricing, scheduleA } = scheduleFor(
      ['web-management', 'marketing-consulting'],
      { 'web-management': { page_count: 7, site_count: 1 }, 'marketing-consulting': { revenue_band: '1m-to-10m' } },
      { wm_tier: 'better', mc_yes_no: 'yes', mc_tier: 'better' },
    );
    const t = deriveBillingTerms(scheduleA, scheduleA.hours_and_rates.billing_anchor_day);
    const expectedRecurring = (scheduleA.web_management?.monthly_total || 0) + (scheduleA.marketing_consulting?.monthly_retainer || 0);
    test('WM+MC: recurring = WM total + MC retainer', near(t.recurring, Math.round(expectedRecurring * 100) / 100),
      `recurring ${t.recurring} vs ${expectedRecurring}`);
    test('WM+MC: isRecurring true', t.isRecurring === true);
    test('WM+MC: contract type retainer', t.contractType === 'retainer');
    test('WM+MC: cadence monthly', t.cadence === 'monthly');
    test('WM+MC: included hours carried from Schedule A', t.includedHours === (scheduleA.hours_and_rates.included_hours ?? scheduleA.web_management?.included_hours));
    test('WM+MC: overage rate 100', t.overageRate === 100);
    test('WM+MC: at-signing total equals Schedule A block total', near(t.atSigningTotal, scheduleA.amount_due_at_signing.total));
    test('WM+MC: at-signing total equals pricing.atSigning', near(t.atSigningTotal, pricing.atSigning));
    const itemSum = Math.round(t.atSigningItems.reduce((s, li) => s + li.amount, 0) * 100) / 100;
    test('WM+MC: at-signing items sum to total', near(itemSum, t.atSigningTotal), `items ${itemSum} vs ${t.atSigningTotal}`);
  }

  // Build only -> one-time fixed, no recurring.
  {
    const { pricing, scheduleA } = scheduleFor(
      ['build'],
      { 'build': { build_total_pages: 20, build_description: 'A net-new site' } },
      {},
    );
    const t = deriveBillingTerms(scheduleA, null);
    test('Build-only: recurring is 0', t.recurring === 0);
    test('Build-only: isRecurring false', t.isRecurring === false);
    test('Build-only: contract type fixed', t.contractType === 'fixed');
    test('Build-only: cadence one-time', t.cadence === 'one-time');
    test('Build-only: at-signing total equals the build fee (pricing.atSigning)', near(t.atSigningTotal, pricing.atSigning) && t.atSigningTotal >= 5625);
  }

  // Billing anchor day flows through and clamps to a month-safe range.
  {
    const { scheduleA } = scheduleFor(
      ['web-management'],
      { 'web-management': { page_count: 7, site_count: 1 } },
      { wm_tier: 'good' },
      { billingAnchorDay: 31 },
    );
    const t = deriveBillingTerms(scheduleA, 31);
    test('Anchor day clamps 31 -> 28 (month-safe)', t.billingDay === 28, `got ${t.billingDay}`);
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exit(1);
}

run();
