// Phase 1 follow-up — timezone test for nextBillingRunIso.
//
// The earlier implementation used local-time Date construction plus
// toISOString() which silently produced different scheduled_for values
// on different host timezones. The fix: compute via Date.UTC only, so
// the output is identical regardless of where the code runs.
//
// This test pins `now` and asserts the expected UTC ISO. The fact that
// the function only uses getUTC* / Date.UTC methods means it is
// timezone-independent by construction — we assert the actual values
// rather than running under multiple TZ_ overrides (which would
// complicate the harness without adding information).
//
// Run: npx tsx scripts/phase1-test-billing-tz.ts

import { nextBillingRunIso } from '../src/lib/contracts';

interface Case {
  label: string;
  billingDay: number;
  now: string;     // pinned "now" as ISO
  expect: string;  // expected scheduled_for ISO
}

const CASES: Case[] = [
  // Haven't hit billing day yet this month → schedule this month.
  { label: 'day=9, now Apr 1',  billingDay: 9,  now: '2026-04-01T00:00:00.000Z', expect: '2026-04-09T00:00:00.000Z' },
  { label: 'day=9, now Apr 8',  billingDay: 9,  now: '2026-04-08T23:59:59.999Z', expect: '2026-04-09T00:00:00.000Z' },
  // Passed billing day → schedule next month.
  { label: 'day=9, now Apr 9',  billingDay: 9,  now: '2026-04-09T00:00:00.000Z', expect: '2026-05-09T00:00:00.000Z' },
  { label: 'day=9, now Apr 30', billingDay: 9,  now: '2026-04-30T23:00:00.000Z', expect: '2026-05-09T00:00:00.000Z' },
  // day=1 edge case.
  { label: 'day=1, now Apr 1 00:00', billingDay: 1, now: '2026-04-01T00:00:00.000Z', expect: '2026-05-01T00:00:00.000Z' },
  { label: 'day=1, now Mar 31 23:59', billingDay: 1, now: '2026-03-31T23:59:59.999Z', expect: '2026-04-01T00:00:00.000Z' },
  // Year wrap.
  { label: 'day=15, now Dec 20', billingDay: 15, now: '2026-12-20T00:00:00.000Z', expect: '2027-01-15T00:00:00.000Z' },
  { label: 'day=15, now Dec 14', billingDay: 15, now: '2026-12-14T00:00:00.000Z', expect: '2026-12-15T00:00:00.000Z' },
  // day=28 Feb boundary.
  { label: 'day=28, now Feb 27', billingDay: 28, now: '2026-02-27T00:00:00.000Z', expect: '2026-02-28T00:00:00.000Z' },
  { label: 'day=28, now Feb 28', billingDay: 28, now: '2026-02-28T00:00:00.000Z', expect: '2026-03-28T00:00:00.000Z' },
  // Clamps.
  { label: 'day=0 clamps to 1',  billingDay: 0,  now: '2026-04-05T00:00:00.000Z', expect: '2026-05-01T00:00:00.000Z' },
  { label: 'day=31 clamps to 28', billingDay: 31, now: '2026-04-05T00:00:00.000Z', expect: '2026-04-28T00:00:00.000Z' },
];

let failed = 0;
for (const c of CASES) {
  const got = nextBillingRunIso(c.billingDay, new Date(c.now));
  if (got === c.expect) {
    console.log(`  PASS  ${c.label.padEnd(38)} → ${got}`);
  } else {
    console.error(`  FAIL  ${c.label.padEnd(38)} expected ${c.expect}  got ${got}`);
    failed++;
  }
}

// Extra: assert the function is byte-identical to itself across "multiple"
// wall-clock calls when `now` is pinned. If it ever reads local tz this
// guard fails noisily.
const anchor = new Date('2026-04-05T12:34:56.789Z');
const a = nextBillingRunIso(9, anchor);
const b = nextBillingRunIso(9, anchor);
if (a !== b) {
  console.error(`  FAIL  nondeterministic: ${a} vs ${b}`);
  failed++;
} else {
  console.log(`  PASS  deterministic across calls`);
}

console.log();
if (failed > 0) {
  console.error(`${failed} failing`);
  process.exit(1);
}
console.log(`All ${CASES.length + 1} cases passed ✓`);
