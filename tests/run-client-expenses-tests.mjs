import assert from 'node:assert';
import { expenseDueForBilling } from '../src/lib/client-expenses.ts';

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); console.log(`[PASS] ${name}`); passed++; } catch (e) { console.error(`[FAIL] ${name}: ${e.message}`); failed++; } }

const asOf = '2026-06-09';

test('monthly is always due', () => {
  assert.strictEqual(expenseDueForBilling({ frequency: 'monthly', last_billed_on: null, active: 1 }, asOf), true);
  assert.strictEqual(expenseDueForBilling({ frequency: 'monthly', last_billed_on: '2026-06-01', active: 1 }, asOf), true);
});

test('one_time is due only when never billed', () => {
  assert.strictEqual(expenseDueForBilling({ frequency: 'one_time', last_billed_on: null, active: 1 }, asOf), true);
  assert.strictEqual(expenseDueForBilling({ frequency: 'one_time', last_billed_on: '2026-01-01', active: 1 }, asOf), false);
});

test('annual is due when never billed', () => {
  assert.strictEqual(expenseDueForBilling({ frequency: 'annual', last_billed_on: null, active: 1 }, asOf), true);
});

test('annual is due when 11+ months elapsed', () => {
  // last billed 2025-07 -> ~11 months before 2026-06 -> due
  assert.strictEqual(expenseDueForBilling({ frequency: 'annual', last_billed_on: '2025-07-01', active: 1 }, asOf), true);
  // a full year ago -> due
  assert.strictEqual(expenseDueForBilling({ frequency: 'annual', last_billed_on: '2025-06-01', active: 1 }, asOf), true);
});

test('annual is NOT due when < 11 months elapsed', () => {
  // last billed 2026-01 -> 5 months -> not due
  assert.strictEqual(expenseDueForBilling({ frequency: 'annual', last_billed_on: '2026-01-01', active: 1 }, asOf), false);
});

test('inactive template is never due', () => {
  assert.strictEqual(expenseDueForBilling({ frequency: 'monthly', last_billed_on: null, active: 0 }, asOf), false);
});

test('unknown frequency is not due', () => {
  assert.strictEqual(expenseDueForBilling({ frequency: 'weekly', last_billed_on: null, active: 1 }, asOf), false);
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
