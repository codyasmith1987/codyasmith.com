#!/usr/bin/env node
// Bundled-tier mode golden test.
//
// Bundled mode lets one buyer-facing Good/Better/Best card fuse Web
// Management + Marketing Consulting into a single monthly + a single
// "to start" figure, with an optional add-on (the Raised Bar / Jason 5/22
// shape). The money must stay registry-derived: expandBundleSelections
// turns the single bundle_tier pick into the canonical wm_tier/mc_tier/
// build_options keys, and BOTH the proposal-price path (computePricing ->
// composePricing) and the Schedule A path (buildScheduleA) must expand it
// the same way. This test is the dual-call-site guard: it asserts the
// exact Jason figures emerge from both paths, with and without the
// add-on, with and without a client discount.
//
// Verified targets (Ecosystem A WM 297/497/647 + Ecosystem B MC
// 497/997/1497, 0.80 multi-site, build-produced sites onboarding-waived):
//   monthly  Good 1,031.60  Better 1,891.60  Best 2,661.60
//   to start Good 7,925     Better 8,925     Best 10,625
// Runs via tsx because the modules are TypeScript.

import { computePricing } from '../src/lib/proposal-pricing.ts';
import { buildScheduleA } from '../src/lib/contract-schedule.ts';
import { expandBundleSelections } from '../src/lib/products/index.ts';

const results = [];
function test(name, pass, detail = '') {
  results.push({ name, pass, detail: String(detail).slice(0, 300) });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  if (!pass && detail) console.log(`       ${String(detail).slice(0, 300)}`);
}
const near = (a, b) => Math.abs((a ?? NaN) - b) < 0.005;

// Jason-shaped bundle config. Two base managed sites (F3 takeover with
// full onboarding; Raised Bar Builders build-produced with onboarding
// waived). The Tailwater add-on is modeled as a 2-entry build_options
// array so the existing build-option machinery prices it; the add-on
// "add" picks rb_tailwater (a third managed site + a second build at the
// 20% subsequent-build discount = +$4,500), "skip" picks rb_base.
function bundleConfig(discount_rate = 0) {
  return {
    pricing_formula: 'product_driven_v1',
    discount_rate,
    products: ['web-management', 'marketing-consulting', 'build'],
    product_vars: {
      'web-management': { page_count: 20, site_count: 2 },
      'marketing-consulting': { revenue_band: '1m-to-10m' },
      'build': {
        build_total_pages: 20,
        build_description: 'Raised Bar Builders site',
        build_options: [
          { id: 'rb_base', name: 'Two sites', pitch: 'F3 Properties plus the new Raised Bar Builders site.', pricing_delta: 0 },
          {
            id: 'rb_tailwater',
            name: 'Add the Tailwater pre-sell site',
            pitch: 'A dedicated Tailwater pre-sell micro-site alongside the two managed sites.',
            pricing_delta: 4500,
            wm_sites_added: [{ domain: 'tailwaterhailey.com', label: 'Tailwater', page_count_estimate: 20 }],
          },
        ],
      },
    },
    managed_sites: [
      { domain: 'f3properties.com', label: 'F3 Properties', is_primary: true, page_count: 20 },
      { domain: 'raisedbarbuilders.com', label: 'Raised Bar Builders', is_primary: false, page_count: 20, onboarding_override: 0 },
    ],
    bundle: {
      tiers: {
        good: { wm: 'good', mc: 'good' },
        better: { wm: 'better', mc: 'better' },
        best: { wm: 'best', mc: 'best' },
      },
      addon: { build_option_id: 'rb_tailwater', skip_option_id: 'rb_base', label: 'Tailwater pre-sell site' },
    },
  };
}

// Expected per (tier, addon). monthly = WM(sites,tier) + MC(tier);
// oneTime = WM onboarding + MC audit + build fee.
const CASES = [
  { tier: 'good',   addon: 'skip', monthly: 1031.60, oneTime: 7925,  wmMonthly: 534.60,  wmOnb: 800,  sites: 2, mcRetainer: 497,  mcAudit: 1500 },
  { tier: 'better', addon: 'skip', monthly: 1891.60, oneTime: 8925,  wmMonthly: 894.60,  wmOnb: 800,  sites: 2, mcRetainer: 997,  mcAudit: 2500 },
  { tier: 'best',   addon: 'skip', monthly: 2661.60, oneTime: 10625, wmMonthly: 1164.60, wmOnb: 1000, sites: 2, mcRetainer: 1497, mcAudit: 4000 },
  { tier: 'good',   addon: 'add',  monthly: 1269.20, oneTime: 12425, wmMonthly: 772.20,  wmOnb: 800,  sites: 3, mcRetainer: 497,  mcAudit: 1500 },
  { tier: 'better', addon: 'add',  monthly: 2289.20, oneTime: 13425, wmMonthly: 1292.20, wmOnb: 800,  sites: 3, mcRetainer: 997,  mcAudit: 2500 },
  { tier: 'best',   addon: 'add',  monthly: 3179.20, oneTime: 15125, wmMonthly: 1682.20, wmOnb: 1000, sites: 3, mcRetainer: 1497, mcAudit: 4000 },
];

function run() {
  const config = bundleConfig();

  for (const c of CASES) {
    const label = `${c.tier}/${c.addon}`;
    // Pass RAW bundle selections to BOTH paths; each must expand internally.
    const raw = { bundle_tier: c.tier, bundle_addon: c.addon };

    // --- Price path ---
    const pricing = computePricing('product_driven_v1', raw, config);
    test(`${label}: price path monthly = ${c.monthly}`, !!pricing && near(pricing.monthly, c.monthly), pricing ? `got ${pricing.monthly}` : 'null pricing');
    test(`${label}: price path one-time = ${c.oneTime}`, !!pricing && near(pricing.oneTime, c.oneTime), pricing ? `got ${pricing.oneTime}` : 'null pricing');

    // --- Schedule A path (raw selections; must expand internally) ---
    const sa = buildScheduleA({
      proposalConfig: config,
      draftSelections: raw,
      pricing,
      clientMetadata: {},
      effectiveDate: '2026-06-01',
    });
    const wm = sa.web_management;
    const mc = sa.marketing_consulting;
    test(`${label}: Schedule A WM monthly_total = ${c.wmMonthly}`, !!wm && near(wm.monthly_total, c.wmMonthly), wm ? `got ${wm.monthly_total}` : 'no WM section');
    test(`${label}: Schedule A WM onboarding_total = ${c.wmOnb}`, !!wm && near(wm.onboarding_total, c.wmOnb), wm ? `got ${wm.onboarding_total}` : 'no WM section');
    test(`${label}: Schedule A WM site_count = ${c.sites}`, !!wm && wm.site_count === c.sites, wm ? `got ${wm.site_count}` : 'no WM section');
    test(`${label}: Schedule A MC retainer = ${c.mcRetainer}`, !!mc && near(mc.monthly_retainer, c.mcRetainer), mc ? `got ${mc.monthly_retainer}` : 'no MC section');
    test(`${label}: Schedule A MC audit = ${c.mcAudit}`, !!mc && near(mc.initial_audit_fee, c.mcAudit), mc ? `got ${mc.initial_audit_fee}` : 'no MC section');

    // --- Dual-call-site parity: the price-path monthly must equal the
    // Schedule A WM monthly_total + MC retainer (build adds 0 monthly).
    // This is the guard that expandBundleSelections ran in BOTH paths and
    // resolved the same per-product tiers.
    const saMonthly = (wm?.monthly_total ?? 0) + (mc?.monthly_retainer ?? 0);
    test(`${label}: price/Schedule A monthly parity`, !!pricing && near(pricing.monthly, saMonthly), `price ${pricing?.monthly} vs schedule ${saMonthly}`);

    // --- Build-produced sites carry zero WM onboarding contribution. ---
    const nonPrimary = (wm?.sites || []).filter(s => !s.is_primary);
    const allWaived = nonPrimary.length > 0 && nonPrimary.every(s => near(s.onboarding_contribution, 0));
    test(`${label}: build/additional sites have $0 WM onboarding`, allWaived, JSON.stringify(nonPrimary.map(s => [s.domain, s.onboarding_contribution])));
  }

  // --- Discount: both paths must discount uniformly and stay in parity. ---
  {
    const config10 = bundleConfig(0.10);
    const raw = { bundle_tier: 'better', bundle_addon: 'skip' };
    const pricing = computePricing('product_driven_v1', raw, config10);
    const sa = buildScheduleA({ proposalConfig: config10, draftSelections: raw, pricing, clientMetadata: {}, effectiveDate: '2026-06-01' });
    const saMonthly = (sa.web_management?.monthly_total ?? 0) + (sa.marketing_consulting?.monthly_retainer ?? 0);
    test('discount 10%: price path monthly = 1702.44', near(pricing?.monthly, 1702.44), `got ${pricing?.monthly}`);
    test('discount 10%: price/Schedule A monthly parity', near(pricing?.monthly, saMonthly), `price ${pricing?.monthly} vs schedule ${saMonthly}`);
  }

  // --- Helper unit: expansion shape. ---
  {
    const config = bundleConfig();
    const skip = expandBundleSelections(config, { bundle_tier: 'better', bundle_addon: 'skip' });
    test('expand better/skip sets wm_tier=better, mc_yes_no=yes, mc_tier=better, build_options=rb_base',
      skip.wm_tier === 'better' && skip.mc_yes_no === 'yes' && skip.mc_tier === 'better' && skip.build_options === 'rb_base',
      JSON.stringify(skip));
    const add = expandBundleSelections(config, { bundle_tier: 'best', bundle_addon: 'add' });
    test('expand best/add sets wm_tier=best, mc_tier=best, build_options=rb_tailwater',
      add.wm_tier === 'best' && add.mc_tier === 'best' && add.build_options === 'rb_tailwater',
      JSON.stringify(add));
    const noPick = expandBundleSelections(config, { bundle_tier: '' });
    test('expand with no bundle_tier returns selections unchanged', noPick.wm_tier === undefined, JSON.stringify(noPick));
  }

  // --- Non-bundle proposals are untouched (byte-for-byte, same reference). ---
  {
    const plain = { pricing_formula: 'product_driven_v1', products: ['web-management'], product_vars: {} };
    const sel = { wm_tier: 'better' };
    const out = expandBundleSelections(plain, sel);
    test('non-bundle config: expandBundleSelections is a no-op (same reference)', out === sel, 'expected identity return');
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exit(1);
}

run();
