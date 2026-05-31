#!/usr/bin/env node
// Onboarding-waiver test (reissue / already-onboarded clients).
//
// config.waive_onboarding zeros the one-time setup fees (WM onboarding,
// MC initial audit) while leaving recurring fees and the first month
// untouched. This is the existing-client reissue path (e.g. ZipKit
// Homes); pro-bono uses the client discount instead. Verifies the
// proposal-page pricing, the Schedule A section fields, and the A.4
// at-signing block all agree. Runs via tsx (TS modules).

import { computePricing } from '../src/lib/proposal-pricing.ts';
import { buildScheduleA } from '../src/lib/contract-schedule.ts';
import { deriveBillingTerms } from '../src/lib/contract-handoff.ts';
import { composeProposal } from '../src/lib/products/index.ts';

const results = [];
function test(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  if (!pass && detail) console.log(`       ${String(detail).slice(0, 300)}`);
}
const near = (a, b) => Math.abs((a ?? NaN) - b) < 0.005;

const baseConfig = (waive) => ({
  pricing_formula: 'product_driven_v1',
  products: ['web-management', 'marketing-consulting'],
  product_vars: {
    'web-management': { page_count: 7, site_count: 1 },
    'marketing-consulting': { revenue_band: '1m-to-10m' },
  },
  ...(waive ? { waive_onboarding: true } : {}),
});
const selections = { wm_tier: 'better', mc_yes_no: 'yes', mc_tier: 'better' };

function run() {
  const without = computePricing('product_driven_v1', selections, baseConfig(false));
  const waived = computePricing('product_driven_v1', selections, baseConfig(true));

  test('Baseline has a positive one-time (onboarding + audit)', without.oneTime > 0, `oneTime ${without.oneTime}`);
  test('Waiver zeros the one-time total', near(waived.oneTime, 0), `oneTime ${waived.oneTime}`);
  test('Waiver leaves recurring unchanged', near(waived.monthly, without.monthly),
    `waived ${waived.monthly} vs ${without.monthly}`);
  test('Waiver at-signing equals first month only', near(waived.atSigning, waived.monthly),
    `atSigning ${waived.atSigning} vs monthly ${waived.monthly}`);
  test('Waiver saved exactly the one-time amount', near(without.atSigning - waived.atSigning, without.oneTime),
    `diff ${without.atSigning - waived.atSigning} vs oneTime ${without.oneTime}`);

  // Schedule A under the waiver.
  const scheduleA = buildScheduleA({
    proposalConfig: baseConfig(true),
    draftSelections: selections,
    pricing: waived,
    clientMetadata: {},
    effectiveDate: '2026-06-01',
  });
  test('Schedule A: WM onboarding total is 0', scheduleA.web_management?.onboarding_total === 0,
    `onboarding_total ${scheduleA.web_management?.onboarding_total}`);
  test('Schedule A: WM onboarding reference fee is 0', scheduleA.web_management?.onboarding_fee === 0);
  test('Schedule A: every per-site onboarding contribution is 0',
    (scheduleA.web_management?.sites || []).every(s => (s.onboarding_contribution ?? 0) === 0));
  test('Schedule A: MC initial audit is 0', scheduleA.marketing_consulting?.initial_audit_fee === 0,
    `audit ${scheduleA.marketing_consulting?.initial_audit_fee}`);
  test('Schedule A: monthly retainer unaffected', scheduleA.marketing_consulting?.monthly_retainer > 0);

  const ads = scheduleA.amount_due_at_signing;
  test('Schedule A: at-signing total equals first month only', !!ads && near(ads.total, waived.monthly),
    ads ? `total ${ads.total} vs ${waived.monthly}` : 'no block');
  test('Schedule A: at-signing has no positive one-time (onboarding/audit) line',
    !!ads && !ads.line_items.some(li => /onboarding|audit/i.test(li.label) && li.amount > 0.005));
  test('Schedule A: at-signing is all first-month lines',
    !!ads && ads.line_items.length > 0 && ads.line_items.every(li => /First month/i.test(li.label)));

  // Billing handoff derivation under the waiver.
  const terms = deriveBillingTerms(scheduleA, scheduleA.hours_and_rates.billing_anchor_day);
  test('Handoff: recurring unaffected by waiver', near(terms.recurring, without.monthly));
  test('Handoff: at-signing total equals first month only', near(terms.atSigningTotal, waived.monthly));

  // Narrative consistency: a waived (reissue) proposal must not promise
  // onboarding/audit in copy while the fees are priced $0. Compose a full
  // WM+MC proposal both ways and compare the rendered config strings.
  {
    const composeArgs = {
      client: { id: 'c-test', name: 'Test Client', slug: 'test-client', discount_rate: 0 },
      signers: [{ id: 's1', email: 'a@example.com', name: 'A Signer' }],
      products: ['web-management', 'marketing-consulting'],
      product_vars: {
        'web-management': { page_count: 7, site_count: 1 },
        'marketing-consulting': { revenue_band: '1m-to-10m' },
      },
    };
    const plain = JSON.stringify(composeProposal({ ...composeArgs, waive_onboarding: false }));
    const waived = JSON.stringify(composeProposal({ ...composeArgs, waive_onboarding: true }));

    // Sanity: the default proposal DOES carry the first-time fee. Under the
    // bounded MC model the signing fee is the month-one discovery/research
    // fee, shown as a "$X at signing" subline on the MC cards (the old
    // "audit at the start" feature copy was removed in the restructure).
    test('Narrative: default proposal shows a MC fee at signing', /\$[\d,]+ at signing/i.test(plain));
    test('Narrative: default proposal says "Month one is onboarding"', /Month one is onboarding/i.test(plain));

    // Waived proposal must drop both.
    test('Narrative (waived): no "$X at signing" MC fee promise', !/\$[\d,]+ at signing/i.test(waived),
      'waived config still shows a dollar MC fee at signing');
    test('Narrative (waived): no "Month one is onboarding"', !/Month one is onboarding/i.test(waived),
      'waived config still contains "Month one is onboarding"');
    // And carries the waiver-aware framing instead.
    test('Narrative (waived): uses already-on-file / continuation framing',
      /already on file|continues where we left off|already been onboarded|already onboarded/i.test(waived));

    // Tier cards: WM + MC sublines must not advertise a fee when waived.
    test('Tier cards: default WM card shows a "$X onboarding" subline', /\$[\d,]+ onboarding/i.test(plain));
    test('Tier cards (waived): no "$X onboarding" subline anywhere', !/\$[\d,]+ onboarding/i.test(waived),
      'waived config still shows a dollar onboarding amount on a tier card');
    test('Tier cards (waived): WM card shows "Onboarding waived"', /Onboarding waived/i.test(waived));
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exit(1);
}

run();
