#!/usr/bin/env node
// Unit tests for the deterministic delta math (src/lib/reports/deltas.ts).
// Pure, no DB. This is the accuracy core that retires the manual
// validation pass, so the edge cases (null/zero prior, position
// inversion, CTR points-vs-relative) are pinned hard. Runs via tsx.

import { computeDelta, perDay, dualDelta, ctrDelta, positionDelta, shouldBold } from '../src/lib/reports/deltas.ts';

const results = [];
function test(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  if (!pass && detail) console.log(`       ${String(detail).slice(0, 200)}`);
}
function near(a, b, eps = 1e-3) { return a !== null && b !== null && Math.abs(a - b) <= eps; }

function run() {
  // computeDelta basics
  {
    const d = computeDelta(100, 150);
    test('count up: abs +50, pct +0.5, improved', d.absoluteChange === 50 && near(d.percentChange, 0.5) && d.direction === 'improved', JSON.stringify(d));
  }
  {
    const d = computeDelta(150, 100);
    test('count down: pct ~-0.333, worsened', near(d.percentChange, -1 / 3) && d.direction === 'worsened', JSON.stringify(d));
  }
  {
    const d = computeDelta(100, 100);
    test('count equal: flat', d.direction === 'flat' && d.absoluteChange === 0);
  }
  {
    const d = computeDelta(null, 90);
    test('null prior: isNew, direction new, pct null', d.isNew === true && d.direction === 'new' && d.percentChange === null, JSON.stringify(d));
  }
  {
    const d = computeDelta(0, 90);
    // Prior 0: percent is undefined (no divide-by-zero, never +Infinity),
    // but the absolute move is a real increase, so direction is improved.
    test('zero prior: no divide-by-zero, pct null, improved from abs', d.percentChange === null && d.absoluteChange === 90 && d.direction === 'improved', JSON.stringify(d));
  }
  {
    const d = computeDelta(90, null);
    test('null current: pct null, direction none', d.percentChange === null && d.direction === 'none' && d.current === null);
  }
  {
    const d = computeDelta(null, null);
    test('both null: none', d.direction === 'none' && d.absoluteChange === null);
  }
  {
    const d = computeDelta(null, 0);
    test('null prior, zero current: not new, direction none', d.isNew === false && d.direction === 'none', JSON.stringify(d));
  }

  // position semantics (lower is better)
  {
    const d = positionDelta(12.0, 14.76);
    test('position worsened (12 -> 14.76)', near(d.absoluteChange, 2.76) && d.direction === 'worsened', JSON.stringify(d));
  }
  {
    const d = positionDelta(14.0, 11.0);
    test('position improved (14 -> 11)', d.direction === 'improved' && near(d.absoluteChange, -3));
  }

  // per-day + dualDelta
  {
    const pd = perDay({ label: 'x', days: 31, clicks: 6913, impressions: null });
    test('perDay clicks 6913/31', near(pd.clicksPerDay, 223.0, 0.1) && pd.impressionsPerDay === null);
  }
  {
    const prior = { label: 'M1', days: 31, clicks: 6913, impressions: 100000 };
    const current = { label: 'M2', days: 30, clicks: 8500, impressions: 120000 };
    const dd = dualDelta(prior, current, 'clicks');
    // abs% = (8500-6913)/6913 = 0.2296 ; perDay% = (8500/30)/(6913/31) - 1
    const expPerDay = (8500 / 30) / (6913 / 31) - 1;
    test('dualDelta abs ~0.2296', near(dd.absolute.percentChange, 0.2296, 1e-3), JSON.stringify(dd.absolute));
    test('dualDelta perDay computed on normalized values', near(dd.perDay.percentChange, expPerDay, 1e-3), JSON.stringify(dd.perDay));
  }

  // ctrDelta: points vs relative, CTR stored 0..1
  {
    const c = ctrDelta(0.0532, 0.0704);
    test('ctr points ~+1.72', near(c.pointDelta, 1.72, 0.01), JSON.stringify(c));
    test('ctr relative ~+0.323', near(c.relativePercent, 0.3233, 1e-3), JSON.stringify(c));
    test('ctr pct conversions (5.32%, 7.04%)', near(c.priorPct, 5.32, 0.01) && near(c.currentPct, 7.04, 0.01));
  }
  {
    const c = ctrDelta(0.0533, 0.0532);
    test('ctr tiny move: point ~-0.01', near(c.pointDelta, -0.01, 0.005), JSON.stringify(c));
  }
  {
    const c = ctrDelta(null, 0.05);
    test('ctr null prior: points/relative null', c.pointDelta === null && c.relativePercent === null && near(c.currentPct, 5.0, 0.01));
  }

  // shouldBold threshold
  test('shouldBold 0.27 true', shouldBold(0.27) === true);
  test('shouldBold 0.10 false', shouldBold(0.10) === false);
  test('shouldBold null false', shouldBold(null) === false);
  test('shouldBold -0.30 true', shouldBold(-0.30) === true);

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exit(1);
}

run();
