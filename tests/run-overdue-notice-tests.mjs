import assert from 'node:assert';
import { isOverdueNoticeDue } from '../src/lib/billing.ts';

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); console.log(`[PASS] ${name}`); passed++; } catch (e) { console.error(`[FAIL] ${name}: ${e.message}`); failed++; } }

const at = (s) => new Date(s);

test('no due date -> never notice', () => {
  assert.strictEqual(isOverdueNoticeDue({ due_date: null, last_reminder_sent: null }, at('2026-06-30T00:00:00Z')), false);
});

test('before due+7 -> no notice', () => {
  // due 2026-06-01, now 2026-06-05 (due+4)
  assert.strictEqual(isOverdueNoticeDue({ due_date: '2026-06-01', last_reminder_sent: null }, at('2026-06-05T12:00:00Z')), false);
});

test('exactly due+7, never reminded -> first notice fires', () => {
  assert.strictEqual(isOverdueNoticeDue({ due_date: '2026-06-01', last_reminder_sent: null }, at('2026-06-08T00:00:00Z')), true);
});

test('past due+7, never reminded -> notice fires', () => {
  assert.strictEqual(isOverdueNoticeDue({ due_date: '2026-06-01', last_reminder_sent: null }, at('2026-06-20T00:00:00Z')), true);
});

test('reminded 1 day ago -> weekly not elapsed, no notice', () => {
  assert.strictEqual(isOverdueNoticeDue({ due_date: '2026-06-01', last_reminder_sent: '2026-06-08T10:00:00Z' }, at('2026-06-09T10:00:00Z')), false);
});

test('reminded exactly 7 days ago -> weekly notice fires', () => {
  assert.strictEqual(isOverdueNoticeDue({ due_date: '2026-06-01', last_reminder_sent: '2026-06-08T10:00:00Z' }, at('2026-06-15T10:00:00Z')), true);
});

test('reminded 6 days ago -> no notice yet', () => {
  assert.strictEqual(isOverdueNoticeDue({ due_date: '2026-06-01', last_reminder_sent: '2026-06-08T10:00:00Z' }, at('2026-06-14T09:00:00Z')), false);
});

test('a pre-due reminder (before due+7) does not block the first overdue notice', () => {
  // pre-due reminder stamped 2026-05-30 (2 days before due 2026-06-01).
  // At due+7 (2026-06-08), that stamp is 9 days old, so the first overdue
  // notice still fires.
  assert.strictEqual(isOverdueNoticeDue({ due_date: '2026-06-01', last_reminder_sent: '2026-05-30T10:00:00Z' }, at('2026-06-08T00:00:00Z')), true);
});

test('invalid last_reminder_sent past due+7 -> treated as needing a notice', () => {
  assert.strictEqual(isOverdueNoticeDue({ due_date: '2026-06-01', last_reminder_sent: 'not-a-date' }, at('2026-06-20T00:00:00Z')), true);
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
