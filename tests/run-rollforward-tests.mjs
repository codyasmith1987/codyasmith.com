import assert from 'node:assert';
import { accruedInterest, computeRollForwardLines, LATE_INTEREST_CATEGORY, PAST_DUE_CATEGORY } from '../src/lib/billing.ts';

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); console.log(`[PASS] ${name}`); passed++; } catch (e) { console.error(`[FAIL] ${name}: ${e.message}`); failed++; } }
const at = (s) => new Date(s);
const near = (a, b) => Math.abs(a - b) < 0.005;

// --- accruedInterest (simple, 1.5%/mo, from invoice date) ---

test('no interest before/at the invoice date', () => {
  assert.strictEqual(accruedInterest(1000, '2026-06-01', at('2026-06-01T00:00:00Z')), 0);
  assert.strictEqual(accruedInterest(1000, '2026-06-01', at('2026-05-20T00:00:00Z')), 0);
});

test('no interest on a non-positive base or bad date', () => {
  assert.strictEqual(accruedInterest(0, '2026-06-01', at('2026-07-01T00:00:00Z')), 0);
  assert.strictEqual(accruedInterest(-50, '2026-06-01', at('2026-07-01T00:00:00Z')), 0);
  assert.strictEqual(accruedInterest(1000, null, at('2026-07-01T00:00:00Z')), 0);
  assert.strictEqual(accruedInterest(1000, 'not-a-date', at('2026-07-01T00:00:00Z')), 0);
});

test('30 days on $1000 ~= $1000 * 0.18/365 * 30 = $14.79', () => {
  // dailyRate = 0.015*12/365 = 0.000493...; *30*1000 = 14.79
  assert.ok(near(accruedInterest(1000, '2026-06-01', at('2026-07-01T00:00:00Z')), 14.79), `got ${accruedInterest(1000, '2026-06-01', at('2026-07-01T00:00:00Z'))}`);
});

test('365 days on $1000 = $180.00 (18%/yr)', () => {
  assert.ok(near(accruedInterest(1000, '2026-06-01', at('2027-06-01T00:00:00Z')), 180.00), `got ${accruedInterest(1000, '2026-06-01', at('2027-06-01T00:00:00Z'))}`);
});

test('interest is LINEAR in time (simple): 60 days = 2 x 30 days', () => {
  const d30 = accruedInterest(1360, '2026-06-01', at('2026-07-01T00:00:00Z'));
  const d60 = accruedInterest(1360, '2026-06-01', at('2026-07-31T00:00:00Z'));
  assert.ok(near(d60, d30 * 2), `d30=${d30} d60=${d60}`);
});

// --- computeRollForwardLines ---

const items = (arr) => arr.map(([category, amount]) => ({ category, amount }));

test('simple overdue invoice -> past_due principal + one interest line', () => {
  const lines = computeRollForwardLines(
    { invoice_number: 'INV-2026-0003', issued_date: '2026-05-09' },
    items([['services', 830], ['services', 500], ['reimbursements', 30]]),
    at('2026-06-08T00:00:00Z'),
  );
  assert.strictEqual(lines.length, 2, 'principal + interest');
  const pd = lines.find(l => l.category === PAST_DUE_CATEGORY);
  const li = lines.find(l => l.category === LATE_INTEREST_CATEGORY);
  assert.ok(pd && near(pd.amount, 1360), `principal ${pd?.amount}`);
  assert.ok(li && li.amount > 0, 'interest line present');
  assert.ok(li.name.includes('INV-2026-0003'));
});

test('interest base EXCLUDES prior late_interest lines (no interest-on-interest)', () => {
  // an already-rolled invoice: $1000 principal + $20 prior interest
  const lines = computeRollForwardLines(
    { invoice_number: 'INV-2026-0005', issued_date: '2026-06-01' },
    items([['past_due', 1000], ['late_interest', 20]]),
    at('2026-07-01T00:00:00Z'),
  );
  const pd = lines.find(l => l.category === PAST_DUE_CATEGORY);
  const interestLines = lines.filter(l => l.category === LATE_INTEREST_CATEGORY);
  // carried principal is the $1000 (NOT the $20 interest)
  assert.ok(near(pd.amount, 1000), `principal ${pd.amount}`);
  // new interest is computed on $1000 only (~$14.79 for 30 days), not $1020
  const newInterest = interestLines.find(l => l.name.startsWith('Late interest'));
  assert.ok(near(newInterest.amount, 14.79), `new interest ${newInterest.amount}`);
  // the $20 prior interest is carried as a NON-bearing line
  const prior = interestLines.find(l => l.name.startsWith('Prior late interest'));
  assert.ok(prior && near(prior.amount, 20), `prior interest ${prior?.amount}`);
});

test('segmented roll-forwards sum to simple-from-original (linearity, within per-segment rounding)', () => {
  // P=1000, issued day 0. Roll 1 at day 30: interest = 1000*r*30.
  const i1 = accruedInterest(1000, '2026-06-01', at('2026-07-01T00:00:00Z'));
  // New invoice issued day 30, principal still 1000 (interest excluded), prior interest i1 carried non-bearing.
  // Roll 2 at day 60: new interest on 1000 from day 30 = 1000*r*30.
  const i2 = accruedInterest(1000, '2026-07-01', at('2026-07-31T00:00:00Z'));
  // total charged on principal = i1 + i2; simple-from-original over 60 days.
  // Each segment rounds to cents independently, so the sum can differ from the
  // single-shot figure by up to a cent per segment -- the principle is exact
  // (simple interest is linear in time); only sub-cent rounding drifts.
  const simple60 = accruedInterest(1000, '2026-06-01', at('2026-07-31T00:00:00Z'));
  assert.ok(Math.abs((i1 + i2) - simple60) <= 0.02, `i1+i2=${i1 + i2} simple60=${simple60}`);
});

test('not-yet-accrued (issued in the future) -> only the principal line', () => {
  const lines = computeRollForwardLines(
    { invoice_number: 'INV-X', issued_date: '2026-12-01' },
    items([['services', 500]]),
    at('2026-06-08T00:00:00Z'),
  );
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].category, PAST_DUE_CATEGORY);
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
