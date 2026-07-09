import assert from 'node:assert';
import { deriveRecurringLineItems } from '../src/lib/billing.ts';

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); console.log(`[PASS] ${name}`); passed++; } catch (e) { console.error(`[FAIL] ${name}: ${e.message}`); failed++; } }

const period = { start: '2026-06-09', end: '2026-07-08' };

test('ZipKit-shape Schedule A -> WM per-site + MC lines, primary first, reconciles to 1330', () => {
  const sa = {
    web_management: { sites: [
      { domain: 'mountainvalleyprefab.com', monthly_contribution: 330, is_primary: false },
      { domain: 'zipkithomes.com', monthly_contribution: 500, is_primary: true },
    ] },
    marketing_consulting: { monthly_retainer: 500 },
  };
  const lines = deriveRecurringLineItems(sa, period);
  assert.strictEqual(lines.length, 3);
  assert.strictEqual(lines[0].name, 'Web Management - zipkithomes.com'); // primary first
  assert.strictEqual(lines[0].unit_price, 500);
  assert.strictEqual(lines[1].name, 'Web Management - mountainvalleyprefab.com');
  assert.strictEqual(lines[1].unit_price, 330);
  assert.strictEqual(lines[2].name, 'Marketing Consulting');
  assert.strictEqual(lines[2].unit_price, 500);
  const sum = lines.reduce((s, l) => s + l.unit_price * l.quantity, 0);
  assert.strictEqual(sum, 1330);
  assert.ok(lines.every(l => l.category === 'services' && l.frequency === 'monthly' && l.sub_description === '2026-06-09 to 2026-07-08'));
});

test('no Schedule A -> null (single-line fallback)', () => {
  assert.strictEqual(deriveRecurringLineItems(null, period), null);
  assert.strictEqual(deriveRecurringLineItems(undefined, period), null);
  assert.strictEqual(deriveRecurringLineItems({}, period), null);
});

test('WM only -> WM lines, no MC line', () => {
  const lines = deriveRecurringLineItems({ web_management: { sites: [{ domain: 'a.com', monthly_contribution: 500, is_primary: true }] } }, period);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].name, 'Web Management - a.com');
});

test('MC only -> single MC line', () => {
  const lines = deriveRecurringLineItems({ marketing_consulting: { monthly_retainer: 500 } }, period);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].name, 'Marketing Consulting');
});

test('zero/missing-contribution sites are skipped', () => {
  const lines = deriveRecurringLineItems({ web_management: { sites: [
    { domain: 'a.com', monthly_contribution: 500, is_primary: true },
    { domain: 'b.com', monthly_contribution: 0, is_primary: false },
    { domain: 'c.com', is_primary: false },
  ] } }, period);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].name, 'Web Management - a.com');
});

test('breakdown with no positive lines -> null', () => {
  assert.strictEqual(deriveRecurringLineItems({ web_management: { sites: [{ domain: 'a.com', monthly_contribution: 0 }] }, marketing_consulting: { monthly_retainer: 0 } }, period), null);
});

test('priced site with NO domain -> synthesized label, still billed (reconcile-safe)', () => {
  // A site with a positive contribution but a missing domain must still produce
  // a line, or the lines would sum short of contract.recurring_amount and trip
  // the reconcile HALT (dual audit 2026-06-05). Synthesized label, real amount.
  const lines = deriveRecurringLineItems({ web_management: { sites: [
    { domain: 'zipkithomes.com', monthly_contribution: 500, is_primary: true },
    { monthly_contribution: 330, is_primary: false },
  ] } }, period);
  assert.strictEqual(lines.length, 2);
  const synth = lines.find(l => l.name === 'Web Management - additional site');
  assert.ok(synth, 'domainless priced site gets a synthesized-label line');
  assert.strictEqual(synth.unit_price, 330);
  // Sum preserved so reconcile vs recurring_amount (830) passes, not null/short.
  const sum = lines.reduce((s, l) => s + l.unit_price * l.quantity, 0);
  assert.strictEqual(sum, 830);
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
