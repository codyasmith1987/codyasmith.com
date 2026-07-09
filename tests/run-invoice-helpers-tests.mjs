import assert from 'node:assert';
import { splitSubtotals, addMonthsToDate, buildDuplicatePayload } from '../src/lib/invoices.ts';

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); console.log(`[PASS] ${name}`); passed++; } catch (e) { console.error(`[FAIL] ${name}: ${e.message}`); failed++; } }
const cents = (n) => Math.round(n * 100) / 100;

// --- splitSubtotals ---
test('splitSubtotals splits services vs reimbursements', () => {
  const r = splitSubtotals([
    { amount: 500, category: 'services' },
    { amount: 330, category: 'services' },
    { amount: 30, category: 'services' },
    { amount: 319.18, category: 'reimbursements' },
  ]);
  assert.strictEqual(cents(r.services), 860);
  assert.strictEqual(cents(r.reimbursements), 319.18);
  assert.strictEqual(cents(r.total), 1179.18);
});

test('splitSubtotals treats NULL/absent category as services (legacy invoices)', () => {
  const r = splitSubtotals([{ amount: 500 }, { amount: 30, category: null }]);
  assert.strictEqual(cents(r.services), 530);
  assert.strictEqual(cents(r.reimbursements), 0);
  assert.strictEqual(cents(r.total), 530);
});

test('splitSubtotals of empty list is all zeros', () => {
  const r = splitSubtotals([]);
  assert.deepStrictEqual(r, { services: 0, reimbursements: 0, pastDue: 0, total: 0 });
});

test('splitSubtotals groups past_due + late_interest into pastDue (not services)', () => {
  const r = splitSubtotals([
    { amount: 1360, category: 'services' },
    { amount: 830, category: 'past_due' },
    { amount: 24.55, category: 'late_interest' },
  ]);
  assert.strictEqual(cents(r.services), 1360);
  assert.strictEqual(cents(r.pastDue), 854.55);
  assert.strictEqual(cents(r.reimbursements), 0);
  assert.strictEqual(cents(r.total), 2214.55);
});

// --- addMonthsToDate ---
test('addMonthsToDate advances one month', () => {
  assert.strictEqual(addMonthsToDate('2026-05-09', 1), '2026-06-09');
});

test('addMonthsToDate rolls the year over', () => {
  assert.strictEqual(addMonthsToDate('2026-12-15', 1), '2027-01-15');
});

test('addMonthsToDate clamps the day to the target month length', () => {
  assert.strictEqual(addMonthsToDate('2026-01-31', 1), '2026-02-28');
  assert.strictEqual(addMonthsToDate('2024-01-31', 1), '2024-02-29'); // leap year
});

test('addMonthsToDate with n=0 is a no-op', () => {
  assert.strictEqual(addMonthsToDate('2026-05-09', 0), '2026-05-09');
});

// --- buildDuplicatePayload ---
test('buildDuplicatePayload rolls the period forward and copies items verbatim', () => {
  const src = {
    title: 'May 2026 Web Management',
    terms_label: 'Upon Receipt',
    tax: 0,
    billing_period_start: '2026-05-09',
    billing_period_end: '2026-06-08',
  };
  const items = [{
    name: 'Web Management - ZipKit Homes',
    sub_description: 'zipkithomes.com service',
    description: 'Web Management - ZipKit Homes',
    frequency: 'monthly',
    category: 'services',
    quantity: 1,
    unit_price: 500,
    amount: 500,
  }];
  const p = buildDuplicatePayload(src, items);
  assert.strictEqual(p.header.title, 'May 2026 Web Management');
  assert.strictEqual(p.header.terms_label, 'Upon Receipt');
  assert.strictEqual(p.header.tax, 0);
  assert.strictEqual(p.header.billing_period_start, '2026-06-09');
  assert.strictEqual(p.header.billing_period_end, '2026-07-08');
  assert.strictEqual(p.items.length, 1);
  assert.strictEqual(p.items[0].name, 'Web Management - ZipKit Homes');
  assert.strictEqual(p.items[0].sub_description, 'zipkithomes.com service');
  assert.strictEqual(p.items[0].frequency, 'monthly');
  assert.strictEqual(p.items[0].category, 'services');
  assert.strictEqual(p.items[0].unit_price, 500);
  // amount is recomputed on insert, not carried in the payload
  assert.ok(!('amount' in p.items[0]));
});

test('buildDuplicatePayload tolerates null periods', () => {
  const p = buildDuplicatePayload(
    { title: null, terms_label: null, tax: 5, billing_period_start: null, billing_period_end: null },
    [],
  );
  assert.strictEqual(p.header.billing_period_start, null);
  assert.strictEqual(p.header.billing_period_end, null);
  assert.strictEqual(p.header.tax, 5);
  assert.strictEqual(p.items.length, 0);
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
