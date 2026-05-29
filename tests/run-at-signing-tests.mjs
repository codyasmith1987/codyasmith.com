#!/usr/bin/env node
// At-signing total engine test.
//
// Contract section 5.2: the amount due at signing is every one-time fee
// (onboarding, audit, build, all 100% at signing) PLUS the first month of
// every recurring fee, and work does not begin until it clears. The pricing
// engine now exposes PricingResult.atSigning so every downstream surface
// (proposal page, emails, Schedule A, contract, the at-signing invoice) reads
// one canonical number instead of mislabeling oneTime alone as "at signing"
// (the bug that let ZipKit/Sven underpay by a month). Since builds are paid in
// full at signing, the correct figure is exactly oneTime + monthly. This test
// locks that invariant across both formula paths, with build, and with a
// client discount. Runs via tsx because the modules are TypeScript.

import { computePricing } from '../src/lib/proposal-pricing.ts';

const results = [];
function test(name, pass, detail = '') {
  results.push({ name, pass, detail: String(detail).slice(0, 300) });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  if (!pass && detail) console.log(`       ${String(detail).slice(0, 300)}`);
}
const cents = (n) => Math.round((n ?? NaN) * 100) / 100;
const near = (a, b) => Math.abs((a ?? NaN) - b) < 0.005;

function checkInvariant(label, p) {
  if (!p) { test(`${label}: pricing computed`, false, 'null pricing'); return; }
  test(`${label}: atSigning is a number`, typeof p.atSigning === 'number', `got ${p.atSigning}`);
  test(`${label}: atSigning === oneTime + monthly`, near(p.atSigning, cents(p.oneTime + p.monthly)),
    `atSigning ${p.atSigning} vs oneTime ${p.oneTime} + monthly ${p.monthly} = ${cents(p.oneTime + p.monthly)}`);
  test(`${label}: atSigning exceeds the one-time alone (includes first month)`, p.atSigning > p.oneTime || p.monthly === 0,
    `atSigning ${p.atSigning} should be > oneTime ${p.oneTime} when monthly ${p.monthly} > 0`);
}

const pdConfig = (extra = {}) => ({
  pricing_formula: 'product_driven_v1',
  products: ['web-management', 'marketing-consulting'],
  product_vars: {
    'web-management': { page_count: 7, site_count: 1 },
    'marketing-consulting': { revenue_band: '1m-to-10m' },
  },
  ...extra,
});

function run() {
  // raised_bar_v1, both shapes.
  checkInvariant('raised_bar split + consulting',
    computePricing('raised_bar_v1', { mgmt_tier: 'better', site_setup: 'o2', consulting: 'yes', consulting_tier: 'better' }));
  checkInvariant('raised_bar unified, no consulting',
    computePricing('raised_bar_v1', { mgmt_tier: 'good', site_setup: 'o1', consulting: 'no' }));

  // product_driven_v1: WM + MC.
  checkInvariant('product_driven WM+MC',
    computePricing('product_driven_v1', { wm_tier: 'better', mc_yes_no: 'yes', mc_tier: 'better' }, pdConfig()));

  // product_driven_v1: WM + MC + build (full build is due at signing, so still oneTime + monthly).
  {
    const cfg = pdConfig();
    cfg.products = ['web-management', 'marketing-consulting', 'build'];
    cfg.product_vars['build'] = { build_total_pages: 20, build_description: 'A net-new site' };
    const p = computePricing('product_driven_v1', { wm_tier: 'better', mc_yes_no: 'yes', mc_tier: 'better' }, cfg);
    checkInvariant('product_driven WM+MC+build', p);
    test('product_driven build: build fee lands in the at-signing total', !!p && p.oneTime >= 5625,
      `oneTime ${p?.oneTime} should include the full small build ($5,625) at signing`);
  }

  // With a client discount, the invariant holds on the post-discount figures.
  checkInvariant('product_driven WM+MC, 10% discount',
    computePricing('product_driven_v1', { wm_tier: 'better', mc_yes_no: 'yes', mc_tier: 'better' }, pdConfig({ discount_rate: 0.10 })));

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exit(1);
}

run();
