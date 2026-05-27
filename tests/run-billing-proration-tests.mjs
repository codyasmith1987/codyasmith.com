#!/usr/bin/env node
// First-period proration calculator tests.
//
// Covers: standard mid-month go-live, go-live ON anchor day (full
// period), go-live after anchor day (rolls to next month), 31-day
// month, 28-day February, anchor day > target month length (clamps),
// edge cases at year boundary.

import { proratedFirstPeriod } from '../src/lib/billing-proration.ts';

const results = [];
function test(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${pass ? '' : ': ' + detail}`);
}

async function run() {
  // Standard case: anchor day 1, go-live March 15, monthly $300.
  // First period = March 15 to April 1 = 17 days. April has 30 days.
  // Prorated = 300 * 17/30 = $170.00
  const r1 = proratedFirstPeriod({ goLiveDate: '2026-03-15', monthlyFee: 300, anchorDay: 1 });
  test('standard mid-month: March 15 to April 1, anchor=1, $300 monthly',
    r1.first_period_days === 17 && r1.days_in_anchor_period === 30 && r1.prorated_amount === 170,
    JSON.stringify(r1));

  // Go-live BEFORE anchor day in same month: anchor day 15, go-live
  // March 5, monthly $300. First period = March 5 to March 15 = 10
  // days. March has 31 days. Prorated = 300 * 10/31 = $96.77
  const r2 = proratedFirstPeriod({ goLiveDate: '2026-03-05', monthlyFee: 300, anchorDay: 15 });
  test('before anchor in same month: March 5 to March 15, anchor=15, $300',
    r2.first_period_days === 10 && r2.days_in_anchor_period === 31 && Math.abs(r2.prorated_amount - 96.77) < 0.01,
    JSON.stringify(r2));

  // Go-live ON anchor day: full month period, no proration discount.
  // Anchor 1, go-live March 1. Next anchor is April 1. First period =
  // March 1 to April 1 = 31 days. April has 30 days. Result = 300 *
  // 31/30 = $310. (Yes, more than monthly because go-live month is
  // longer than the next month — this is the formula's correct edge
  // behavior; the next full invoice cycles correctly.)
  const r3 = proratedFirstPeriod({ goLiveDate: '2026-03-01', monthlyFee: 300, anchorDay: 1 });
  test('on anchor day: March 1 to April 1, anchor=1',
    r3.first_period_days === 31 && r3.days_in_anchor_period === 30,
    JSON.stringify(r3));

  // Go-live AFTER anchor day: rolls to next month's anchor.
  // Anchor 5, go-live March 20. Next anchor = April 5. Days = 16.
  // April has 30 days. Prorated = 300 * 16/30 = $160
  const r4 = proratedFirstPeriod({ goLiveDate: '2026-03-20', monthlyFee: 300, anchorDay: 5 });
  test('after anchor, rolls to next month: March 20 to April 5',
    r4.first_period_days === 16 && r4.days_in_anchor_period === 30 && r4.prorated_amount === 160,
    JSON.stringify(r4));

  // 31-day month: January 31 days, anchor=15, go-live Jan 20.
  // First period = Jan 20 to Feb 15 = 26 days. Feb has 28 (2026 not
  // leap). Prorated = 300 * 26/28 = $278.57
  const r5 = proratedFirstPeriod({ goLiveDate: '2026-01-20', monthlyFee: 300, anchorDay: 15 });
  test('31-day month with Feb anchor: Jan 20 to Feb 15',
    r5.first_period_days === 26 && r5.days_in_anchor_period === 28 && Math.abs(r5.prorated_amount - 278.57) < 0.01,
    JSON.stringify(r5));

  // Anchor day > target month: anchor 31, go-live Feb 5. Next anchor
  // clamps to Feb 28. Period = Feb 5 to Feb 28 = 23 days. Feb=28.
  // Prorated = 300 * 23/28 = $246.43
  const r6 = proratedFirstPeriod({ goLiveDate: '2026-02-05', monthlyFee: 300, anchorDay: 31 });
  test('anchor 31, Feb target clamps to 28',
    r6.first_period_days === 23 && r6.days_in_anchor_period === 28 && Math.abs(r6.prorated_amount - 246.43) < 0.01,
    JSON.stringify(r6));
  test('clamped first_full_billing_date is Feb 28',
    r6.first_full_billing_date === '2026-02-28',
    `got ${r6.first_full_billing_date}`);

  // Year boundary: anchor 1, go-live Dec 20. Next anchor = Jan 1 next
  // year. Days = 12. Jan = 31 days. Prorated = 300 * 12/31 = $116.13
  const r7 = proratedFirstPeriod({ goLiveDate: '2026-12-20', monthlyFee: 300, anchorDay: 1 });
  test('year boundary: Dec 20 to Jan 1',
    r7.first_period_days === 12 && r7.days_in_anchor_period === 31 && Math.abs(r7.prorated_amount - 116.13) < 0.01,
    JSON.stringify(r7));
  test('year-boundary first_full_billing_date in next year',
    r7.first_full_billing_date === '2027-01-01',
    `got ${r7.first_full_billing_date}`);

  // Zero monthly: prorated zero.
  const r8 = proratedFirstPeriod({ goLiveDate: '2026-03-15', monthlyFee: 0, anchorDay: 1 });
  test('zero monthly fee: prorated zero',
    r8.prorated_amount === 0);

  // Validation: invalid anchor day rejects.
  try {
    proratedFirstPeriod({ goLiveDate: '2026-03-15', monthlyFee: 300, anchorDay: 0 });
    test('anchorDay=0 rejected', false, 'should have thrown');
  } catch (err) {
    test('anchorDay=0 rejected', true);
  }
  try {
    proratedFirstPeriod({ goLiveDate: '2026-03-15', monthlyFee: 300, anchorDay: 32 });
    test('anchorDay=32 rejected', false, 'should have thrown');
  } catch (err) {
    test('anchorDay=32 rejected', true);
  }

  // Negative monthly rejects.
  try {
    proratedFirstPeriod({ goLiveDate: '2026-03-15', monthlyFee: -100, anchorDay: 1 });
    test('negative monthly rejected', false, 'should have thrown');
  } catch (err) {
    test('negative monthly rejected', true);
  }

  // Invalid date rejects.
  try {
    proratedFirstPeriod({ goLiveDate: 'not-a-date', monthlyFee: 300, anchorDay: 1 });
    test('invalid date rejected', false, 'should have thrown');
  } catch (err) {
    test('invalid date rejected', true);
  }

  // Accept ISO datetime, not just date.
  const r9 = proratedFirstPeriod({ goLiveDate: '2026-03-15T14:30:00Z', monthlyFee: 300, anchorDay: 1 });
  test('ISO datetime accepted',
    r9.first_period_days === 17 && r9.prorated_amount === 170);

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
