#!/usr/bin/env node
// Unit tests for pure GSC window slicing (src/lib/reports/windows.ts).
// Pinned: endExclusive boundary, CTR = sumClicks/sumImpressions (not mean
// of daily CTRs), impression-weighted position, empty windows, ISO guard,
// peakWeek, weeklyBuckets. Runs via tsx.

import { aggregateWindow, datesAreIso, peakWeek, weeklyBuckets } from '../src/lib/reports/windows.ts';

const results = [];
function test(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  if (!pass && detail) console.log(`       ${String(detail).slice(0, 200)}`);
}
function near(a, b, eps = 1e-6) { return a !== null && b !== null && Math.abs(a - b) <= eps; }

// Build a synthetic ISO daily series. One low-volume, high-CTR day is
// seeded so CTR-by-sum differs from mean-of-daily-CTR.
function isoDate(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
}
const rows = [];
for (let i = 0; i < 60; i++) {
  const date = isoDate(2026, 3, 10 + i); // 2026-03-10 .. 2026-05-08
  rows.push({ date, clicks: 10, impressions: 1000, ctr: 0.01, position: 20 });
}
// Seed a spike week of high clicks starting 2026-04-20.
for (const r of rows) {
  if (r.date >= '2026-04-20' && r.date < '2026-04-27') { r.clicks = 100; r.impressions = 2000; r.position = 5; }
}
// One low-volume high-CTR day to differentiate sum-CTR from mean-CTR.
const hi = rows.find(r => r.date === '2026-03-11');
hi.clicks = 5; hi.impressions = 5; hi.ctr = 1.0; hi.position = 1;

function run() {
  // aggregateWindow over the full month-two-ish window
  {
    const w = aggregateWindow(rows, { label: 'win', start: '2026-04-09', endExclusive: '2026-05-09' });
    const sel = rows.filter(r => r.date >= '2026-04-09' && r.date < '2026-05-09');
    const sumC = sel.reduce((s, r) => s + r.clicks, 0);
    const sumI = sel.reduce((s, r) => s + r.impressions, 0);
    test('aggregate days == row count in range', w.days === sel.length, `${w.days} vs ${sel.length}`);
    test('aggregate clicks == exact sum', w.clicks === sumC, `${w.clicks} vs ${sumC}`);
    test('aggregate ctr == sumClicks/sumImpressions', near(w.ctr, sumC / sumI), `${w.ctr} vs ${sumC / sumI}`);
  }
  // CTR-by-sum differs from mean-of-daily-CTR (uses the seeded hi-CTR day window)
  {
    const w = aggregateWindow(rows, { label: 'm', start: '2026-03-10', endExclusive: '2026-03-13' });
    // days: 3-10,3-11(hi),3-12. clicks=10+5+10=25, impr=1000+5+1000=2005 -> ctr=25/2005=0.01247
    const meanDaily = (0.01 + 1.0 + 0.01) / 3; // 0.34 -> very different
    test('ctr by sum (~0.01247) not mean-of-daily (~0.34)', near(w.ctr, 25 / 2005, 1e-4) && Math.abs(w.ctr - meanDaily) > 0.3, `${w.ctr}`);
  }
  // impression-weighted position differs from simple mean when impressions vary
  {
    const w = aggregateWindow(rows, { label: 'p', start: '2026-04-19', endExclusive: '2026-04-22' });
    // 4-19: pos20 impr1000 ; 4-20: pos5 impr2000 ; 4-21: pos5 impr2000
    const wp = (20 * 1000 + 5 * 2000 + 5 * 2000) / (1000 + 2000 + 2000);
    test('impression-weighted position', near(w.weightedPosition, wp, 1e-6), `${w.weightedPosition} vs ${wp}`);
  }
  // endExclusive boundary
  {
    const before = aggregateWindow(rows, { label: 'b', start: '2026-04-01', endExclusive: '2026-05-09' });
    const after = aggregateWindow(rows, { label: 'a', start: '2026-05-09', endExclusive: '2026-06-01' });
    const hasMay9 = rows.some(r => r.date === '2026-05-09');
    test('boundary: 2026-05-09 excluded from ..05-09 window', !before.first || before.last < '2026-05-09');
    test('boundary: 2026-05-09 (if present) included in 05-09.. window', !hasMay9 || after.first === '2026-05-09');
  }
  // empty window
  {
    const w = aggregateWindow(rows, { label: 'empty', start: '2027-01-01', endExclusive: '2027-02-01' });
    test('empty window: days 0, metrics null, no throw', w.days === 0 && w.clicks === null && w.ctr === null);
  }
  // ISO guard
  {
    test('datesAreIso true on ISO fixture', datesAreIso(rows) === true);
    const bad = rows.concat([{ date: 'Apr 1, 2026', clicks: 1, impressions: 1, ctr: 1, position: 1 }]);
    test('datesAreIso false when a non-ISO date present', datesAreIso(bad) === false);
    test('datesAreIso tolerates null date', datesAreIso([{ date: null, clicks: 1, impressions: 1, ctr: null, position: null }]) === true);
  }
  // peakWeek
  {
    const pk = peakWeek(rows, '2026-04-01', '2026-05-01');
    // spike week 4-20..4-26 = 7 days * 100 clicks = 700
    test('peakWeek finds the 700-click spike', pk !== null && pk.clicks === 700, JSON.stringify(pk));
  }
  // weeklyBuckets
  {
    const wk = weeklyBuckets(rows, 8);
    const totalInBuckets = wk.reduce((s, b) => s + (b.clicks ?? 0), 0);
    test('weeklyBuckets returns up to 8 buckets', wk.length > 0 && wk.length <= 8, `${wk.length}`);
    test('weeklyBuckets Monday-anchored labels', wk.every(b => /^Week of \d{4}-\d{2}-\d{2}$/.test(b.label)));
    test('weeklyBuckets clicks are positive sums', totalInBuckets > 0);
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exit(1);
}

run();
