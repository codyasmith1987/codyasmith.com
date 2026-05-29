#!/usr/bin/env node
// Contract PDF generation smoke tests. There was previously no coverage of
// generateContractPdf, which is why a field-name bug (reading annual_cost on a
// pass-through item whose field is monthly_cost) shipped: it threw a TypeError
// only at PDF render time, the throw was swallowed in the sign endpoint, and
// every executed contract with a pass-through item ($15/site, i.e. every WM
// engagement) finalized with no stored PDF. These tests drive the real PDF path
// with a Schedule A that has pass-through items and assert a non-empty Buffer.
// Runs via tsx because the modules are TypeScript.

import { generateContractPdf } from '../src/lib/contract-pdf.ts';
import { buildScheduleA } from '../src/lib/contract-schedule.ts';
import { computePricing } from '../src/lib/proposal-pricing.ts';
import { PRACTICE } from '../src/lib/contract-render.ts';

const results = [];
function test(name, pass, detail = '') {
  results.push({ name, pass, detail: String(detail).slice(0, 300) });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  if (!pass && detail) console.log(`       ${String(detail).slice(0, 300)}`);
}

function scheduleAWithPassThroughs() {
  // raised_bar_v1, split setup (o2) -> 3 managed sites -> $15/site pass-throughs.
  const selections = { mgmt_tier: 'better', site_setup: 'o2', consulting: 'yes', consulting_tier: 'better' };
  const pricing = computePricing('raised_bar_v1', selections);
  return buildScheduleA({
    proposalConfig: { pricing_formula: 'raised_bar_v1' },
    draftSelections: selections,
    pricing,
    clientMetadata: { legal_entity_name: 'Raised Bar Group LLC', primary_contact_name: 'Jason Roth' },
    effectiveDate: '2026-06-01',
  });
}

function pdfInput(scheduleA) {
  return {
    template: { title: 'Standard Client Services Agreement' },
    context: { client: { legal_entity_name: 'Raised Bar Group LLC' }, today: '2026-06-01' },
    resolvedBodyMarkdown: '# Standard Client Services Agreement\n\nThis is the agreed body text.\n\n**Bold run** and *italic run* for the markdown renderer.',
    scheduleA,
    signers: [{ name: 'Jason Roth', role: 'Client', signature: 'Jason Roth', signed_at: '2026-06-01' }],
    practice: PRACTICE,
  };
}

async function run() {
  const scheduleA = scheduleAWithPassThroughs();

  // Guard the precondition: this Schedule A must actually carry pass-through items,
  // otherwise the test would pass without exercising the bug line.
  const items = scheduleA.pass_through_items || [];
  test('Schedule A carries at least one pass-through item', items.length > 0, `count=${items.length}`);
  test('pass-through items use monthly_cost (not annual_cost)',
    items.length > 0 && items.every(p => typeof p.monthly_cost === 'number' && p.annual_cost === undefined),
    JSON.stringify(items[0] || {}));

  // The actual regression guard: generating the PDF must not throw and must
  // return a non-empty Buffer. Before the fix, p.annual_cost.toLocaleString()
  // threw a TypeError here and the agreement finalized with no PDF.
  let buf = null;
  let threw = null;
  try {
    buf = await generateContractPdf(pdfInput(scheduleA));
  } catch (err) {
    threw = err;
  }
  test('generateContractPdf does not throw with pass-through items', threw === null, threw ? (threw.stack || String(threw)) : '');
  test('generateContractPdf returns a non-empty Buffer', !!buf && Buffer.isBuffer(buf) && buf.length > 0, buf ? `bytes=${buf.length}` : 'no buffer');
  test('PDF output begins with the %PDF magic header', !!buf && buf.slice(0, 4).toString('latin1') === '%PDF', buf ? buf.slice(0, 8).toString('latin1') : 'no buffer');

  // Also exercise the empty-pass-through branch ("None at signing.") to be safe.
  {
    const noPt = { ...scheduleA, pass_through_items: [] };
    let ok = true, e = null;
    try { const b = await generateContractPdf(pdfInput(noPt)); ok = !!b && b.length > 0; } catch (err) { ok = false; e = err; }
    test('generateContractPdf works with zero pass-through items', ok, e ? (e.stack || String(e)) : '');
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exit(1);
}

run().catch(err => {
  console.error('Test run threw:', err);
  process.exit(1);
});
