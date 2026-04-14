// Phase 1 Step 5 — unit tests for getCurrentBillingPeriod.
//
// The old implementation had an off-by-one for billingDay=1 (end =
// 'YYYY-MM-00') and fragile string math that broke on month/year wraps.
// These tests pin the contract for every interesting (billingDay, now)
// combination. No test framework — plain assertions that exit non-zero
// on failure.
//
// Run: npx tsx scripts/phase1-test-billing-period.ts

import { getCurrentBillingPeriod } from '../src/lib/billing';

interface Case {
  label: string;
  billingDay: number;
  now: Date;
  expect: { start: string; end: string };
}

// Use UTC constructors so the test is host-TZ independent. The function
// uses only getUTC* methods internally; passing local Dates would give
// different answers on different machines.
const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));

const CASES: Case[] = [
  // billing_day=1: the "bug" case from the old implementation.
  { label: 'day=1, Apr 1',  billingDay: 1, now: d(2026, 4, 1),  expect: { start: '2026-04-01', end: '2026-04-30' } },
  { label: 'day=1, Apr 15', billingDay: 1, now: d(2026, 4, 15), expect: { start: '2026-04-01', end: '2026-04-30' } },
  { label: 'day=1, Apr 30', billingDay: 1, now: d(2026, 4, 30), expect: { start: '2026-04-01', end: '2026-04-30' } },

  // Mid-month billing: typical case.
  { label: 'day=9, Apr 1',  billingDay: 9,  now: d(2026, 4, 1),  expect: { start: '2026-03-09', end: '2026-04-08' } },
  { label: 'day=9, Apr 8',  billingDay: 9,  now: d(2026, 4, 8),  expect: { start: '2026-03-09', end: '2026-04-08' } },
  { label: 'day=9, Apr 9',  billingDay: 9,  now: d(2026, 4, 9),  expect: { start: '2026-04-09', end: '2026-05-08' } },
  { label: 'day=9, Apr 30', billingDay: 9,  now: d(2026, 4, 30), expect: { start: '2026-04-09', end: '2026-05-08' } },

  // day=28, boundary with Feb.
  { label: 'day=28, Feb 27', billingDay: 28, now: d(2026, 2, 27), expect: { start: '2026-01-28', end: '2026-02-27' } },
  { label: 'day=28, Feb 28', billingDay: 28, now: d(2026, 2, 28), expect: { start: '2026-02-28', end: '2026-03-27' } },
  { label: 'day=28, Mar 1',  billingDay: 28, now: d(2026, 3, 1),  expect: { start: '2026-02-28', end: '2026-03-27' } },

  // Year wrap.
  { label: 'day=15, Jan 1',  billingDay: 15, now: d(2026, 1, 1),  expect: { start: '2025-12-15', end: '2026-01-14' } },
  { label: 'day=15, Jan 14', billingDay: 15, now: d(2026, 1, 14), expect: { start: '2025-12-15', end: '2026-01-14' } },
  { label: 'day=15, Jan 15', billingDay: 15, now: d(2026, 1, 15), expect: { start: '2026-01-15', end: '2026-02-14' } },
  { label: 'day=15, Dec 15', billingDay: 15, now: d(2026, 12, 15), expect: { start: '2026-12-15', end: '2027-01-14' } },
  { label: 'day=15, Dec 31', billingDay: 15, now: d(2026, 12, 31), expect: { start: '2026-12-15', end: '2027-01-14' } },

  // Clamp: day=0 and day=31 should both clamp to the valid range.
  { label: 'day=0 (clamps to 1), Apr 5',  billingDay: 0,  now: d(2026, 4, 5),  expect: { start: '2026-04-01', end: '2026-04-30' } },
  { label: 'day=31 (clamps to 28), Apr 5', billingDay: 31, now: d(2026, 4, 5), expect: { start: '2026-03-28', end: '2026-04-27' } },
];

let failed = 0;
for (const c of CASES) {
  const got = getCurrentBillingPeriod(c.billingDay, c.now);
  const pass = got.start === c.expect.start && got.end === c.expect.end;
  if (pass) {
    console.log(`  PASS  ${c.label.padEnd(38)} → ${got.start} .. ${got.end}`);
  } else {
    console.error(`  FAIL  ${c.label.padEnd(38)} expected ${c.expect.start}..${c.expect.end}  got ${got.start}..${got.end}`);
    failed++;
  }
}

console.log();
if (failed > 0) {
  console.error(`${failed} failing`);
  process.exit(1);
}
console.log(`All ${CASES.length} cases passed ✓`);
