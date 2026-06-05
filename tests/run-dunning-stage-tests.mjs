import assert from 'node:assert';
import { daysPastDue, overdueStage, resolveDunningStage, sharedExtraRecipient } from '../src/lib/billing.ts';

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); console.log(`[PASS] ${name}`); passed++; } catch (e) { console.error(`[FAIL] ${name}: ${e.message}`); failed++; } }

const at = (s) => new Date(s);

// --- daysPastDue ---

test('no due date -> 0', () => {
  assert.strictEqual(daysPastDue(null, at('2026-06-30T00:00:00Z')), 0);
});

test('unparseable due date -> 0', () => {
  assert.strictEqual(daysPastDue('not-a-date', at('2026-06-30T00:00:00Z')), 0);
});

test('not yet due -> 0', () => {
  assert.strictEqual(daysPastDue('2026-07-01', at('2026-06-20T12:00:00Z')), 0);
});

test('exactly on due date -> 0', () => {
  assert.strictEqual(daysPastDue('2026-06-20', at('2026-06-20T00:00:00Z')), 0);
});

test('one day past due -> 1', () => {
  assert.strictEqual(daysPastDue('2026-06-20', at('2026-06-21T00:00:00Z')), 1);
});

test('thirty days past due -> 30', () => {
  assert.strictEqual(daysPastDue('2026-06-01', at('2026-07-01T00:00:00Z')), 30);
});

test('partial day past due rounds down', () => {
  // 7 days and 12 hours past due -> 7 whole days
  assert.strictEqual(daysPastDue('2026-06-01', at('2026-06-08T12:00:00Z')), 7);
});

// --- overdueStage ---

test('under 30 days -> firm', () => {
  assert.strictEqual(overdueStage(0), 'firm');
  assert.strictEqual(overdueStage(7), 'firm');
  assert.strictEqual(overdueStage(29), 'firm');
});

test('exactly 30 days -> final', () => {
  assert.strictEqual(overdueStage(30), 'final');
});

test('past 30 days -> final', () => {
  assert.strictEqual(overdueStage(45), 'final');
});

// --- resolveDunningStage (the consolidated per-client section 5.8 gate) ---

test('no section-5.8 invoice -> firm even at 60 days', () => {
  const r = resolveDunningStage([{ daysPast: 60, section58Version: null }]);
  assert.strictEqual(r.stage, 'firm');
  assert.strictEqual(r.section58Version, 0);
});

test('pre-v6 agreement -> firm (never agreed to 5.8)', () => {
  const r = resolveDunningStage([{ daysPast: 90, section58Version: 5 }]);
  assert.strictEqual(r.stage, 'firm');
  assert.strictEqual(r.section58Version, 0);
});

test('v6 invoice at 30+ days -> final, version 6', () => {
  const r = resolveDunningStage([{ daysPast: 31, section58Version: 6 }]);
  assert.strictEqual(r.stage, 'final');
  assert.strictEqual(r.section58Version, 6);
});

test('v7 invoice at 30+ days -> final, version 7', () => {
  const r = resolveDunningStage([{ daysPast: 40, section58Version: 7 }]);
  assert.strictEqual(r.stage, 'final');
  assert.strictEqual(r.section58Version, 7);
});

test('v6+ invoice under 30 days -> firm', () => {
  const r = resolveDunningStage([{ daysPast: 10, section58Version: 7 }]);
  assert.strictEqual(r.stage, 'firm');
});

test('MIXED: recent v7 invoice + old legacy invoice -> firm (the cross-contract leak fix)', () => {
  // v7 invoice only 10 days past; a separate legacy invoice 40 days past must
  // NOT drive the client to a 5.8 final notice.
  const r = resolveDunningStage([
    { daysPast: 10, section58Version: 7 },
    { daysPast: 40, section58Version: null },
  ]);
  assert.strictEqual(r.stage, 'firm');
});

test('MIXED: old v7 invoice + recent legacy invoice -> final from the v7 one', () => {
  const r = resolveDunningStage([
    { daysPast: 35, section58Version: 7 },
    { daysPast: 2, section58Version: null },
  ]);
  assert.strictEqual(r.stage, 'final');
  assert.strictEqual(r.section58Version, 7);
});

test('MIXED versions: max section-5.8 version drives the offline wording', () => {
  const r = resolveDunningStage([
    { daysPast: 31, section58Version: 6 },
    { daysPast: 33, section58Version: 7 },
  ]);
  assert.strictEqual(r.stage, 'final');
  assert.strictEqual(r.section58Version, 7);
});

// --- sharedExtraRecipient (consolidated-notice extra-recipient leak fix) ---

test('single invoice with an extra -> honored', () => {
  assert.strictEqual(sharedExtraRecipient([{ extra_recipient_email: 'boss@x.com' }]), 'boss@x.com');
});

test('all invoices share the same extra -> honored', () => {
  assert.strictEqual(sharedExtraRecipient([
    { extra_recipient_email: 'boss@x.com' },
    { extra_recipient_email: 'boss@x.com' },
  ]), 'boss@x.com');
});

test('extra on one, none on another -> dropped (the leak fix)', () => {
  assert.strictEqual(sharedExtraRecipient([
    { extra_recipient_email: 'boss@x.com' },
    { extra_recipient_email: null },
  ]), undefined);
});

test('two different extras -> dropped', () => {
  assert.strictEqual(sharedExtraRecipient([
    { extra_recipient_email: 'a@x.com' },
    { extra_recipient_email: 'b@x.com' },
  ]), undefined);
});

test('no extras anywhere -> undefined', () => {
  assert.strictEqual(sharedExtraRecipient([
    { extra_recipient_email: null },
    { extra_recipient_email: '' },
  ]), undefined);
});

test('case/whitespace differences count as the same shared extra', () => {
  assert.strictEqual(sharedExtraRecipient([
    { extra_recipient_email: 'Boss@X.com' },
    { extra_recipient_email: ' boss@x.com ' },
  ]), 'Boss@X.com');
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
