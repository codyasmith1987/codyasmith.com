import assert from 'node:assert';
import { isOverdueNoticeDue, isAutoOverdueEmailEligible, isStalePaymentPending, OVERDUE_MARK_WHERE } from '../src/lib/billing.ts';

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

// --- Auto-email eligibility (Cody 2026-06-04: partials are marked overdue but NOT auto-dunned) ---

test('fully-unpaid overdue invoice IS auto-emailable', () => {
  assert.strictEqual(isAutoOverdueEmailEligible({ status: 'overdue', amount_paid: 0, total: 500 }), true);
});

test('partially-paid overdue invoice is NOT auto-emailed (marked only)', () => {
  assert.strictEqual(isAutoOverdueEmailEligible({ status: 'overdue', amount_paid: 100, total: 500 }), false);
});

test('non-overdue status is not auto-emailable', () => {
  assert.strictEqual(isAutoOverdueEmailEligible({ status: 'sent', amount_paid: 0, total: 500 }), false);
  assert.strictEqual(isAutoOverdueEmailEligible({ status: 'partial', amount_paid: 100, total: 500 }), false);
});

test('payment_pending is NEVER auto-dunned (the check is in the mail; triple audit 2026-06-09)', () => {
  assert.strictEqual(isAutoOverdueEmailEligible({ status: 'payment_pending', amount_paid: 0, total: 500 }), false);
});

// --- Stale payment_pending (admin-only aging alert; chat-wide audit 2026-06-11:
// a never-arriving "check in the mail" must not sit silent forever) ---

test('payment_pending 14+ days past due IS stale', () => {
  const now = new Date('2026-06-25T12:00:00Z');
  assert.strictEqual(isStalePaymentPending({ status: 'payment_pending', amount_paid: 0, total: 1360, due_date: '2026-06-09' }, now), true);
});

test('payment_pending under 14 days past due is NOT stale', () => {
  const now = new Date('2026-06-15T12:00:00Z');
  assert.strictEqual(isStalePaymentPending({ status: 'payment_pending', amount_paid: 0, total: 1360, due_date: '2026-06-09' }, now), false);
});

test('other statuses never flag as stale-pending', () => {
  const now = new Date('2026-07-25T12:00:00Z');
  for (const s of ['sent', 'overdue', 'partial', 'paid', 'carried_forward']) {
    assert.strictEqual(isStalePaymentPending({ status: s, amount_paid: 0, total: 1360, due_date: '2026-06-09' }, now), false, s);
  }
});

test('a settled payment_pending invoice is not stale (paid >= total)', () => {
  const now = new Date('2026-07-25T12:00:00Z');
  assert.strictEqual(isStalePaymentPending({ status: 'payment_pending', amount_paid: 1360, total: 1360, due_date: '2026-06-09' }, now), false);
});

test('no due date -> never stale (no clock to measure against)', () => {
  const now = new Date('2026-07-25T12:00:00Z');
  assert.strictEqual(isStalePaymentPending({ status: 'payment_pending', amount_paid: 0, total: 1360, due_date: null }, now), false);
});

test('OVERDUE_MARK_WHERE never flips payment_pending or terminal statuses to overdue', () => {
  // The cron's mark-overdue predicate whitelists sent/partial only; the whole
  // safety of payment_pending ("counts as open, never overdue, never dunned")
  // rests on it staying OUT of this list and the dunning queries.
  assert.ok(OVERDUE_MARK_WHERE.includes("status IN ('sent', 'partial')"));
  assert.ok(!OVERDUE_MARK_WHERE.includes('payment_pending'));
});

test('reminders-paused overdue invoice is not auto-emailed', () => {
  assert.strictEqual(isAutoOverdueEmailEligible({ status: 'overdue', amount_paid: 0, total: 500, reminders_paused: 1 }), false);
});

test('fully-paid (guard) is not auto-emailed', () => {
  assert.strictEqual(isAutoOverdueEmailEligible({ status: 'overdue', amount_paid: 500, total: 500 }), false);
});

test('null amount_paid is treated as zero (auto-emailable)', () => {
  assert.strictEqual(isAutoOverdueEmailEligible({ status: 'overdue', amount_paid: null, total: 500 }), true);
});

// --- The shared mark-overdue predicate (single source for cron + dry-run) ---

test('OVERDUE_MARK_WHERE marks partials too (Cody 2026-06-04)', () => {
  assert.ok(OVERDUE_MARK_WHERE.includes("'partial'"), 'mark predicate must include partial');
  assert.ok(OVERDUE_MARK_WHERE.includes("'sent'"), 'mark predicate must include sent');
  assert.ok(OVERDUE_MARK_WHERE.includes('amount_paid < total'), 'mark predicate must exclude fully-paid');
  assert.ok(OVERDUE_MARK_WHERE.includes('reminders_paused'), 'mark predicate must honor pause');
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
