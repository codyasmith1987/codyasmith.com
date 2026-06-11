#!/usr/bin/env node
// Unit tests for the pure month-over-month trend delta logic
// (src/lib/trends.ts attachTrendDeltas). Sparse-month handling is the point:
// a month a source skipped must not fabricate a zero, and lower-is-better
// metrics (position, issues, broken) must report direction correctly.

import assert from 'node:assert';
import { attachTrendDeltas } from '../src/lib/trends.ts';

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); console.log(`[PASS] ${name}`); passed++; } catch (e) { console.error(`[FAIL] ${name}: ${e.message}`); failed++; } }

const m = (month, over = {}) => ({ month, gsc: null, ga4: null, health: null, crawl: null, keywords: null, ...over });

test('first month gets no deltas (nothing prior)', () => {
  const out = attachTrendDeltas([m('2026-04', { gsc: { clicks: 100, impressions: 1000, avg_position: 12 } })]);
  assert.deepStrictEqual(out[0].deltas, {});
});

test('count metric up = improved (clicks 100 -> 150)', () => {
  const out = attachTrendDeltas([
    m('2026-04', { gsc: { clicks: 100, impressions: 1000, avg_position: 12 } }),
    m('2026-05', { gsc: { clicks: 150, impressions: 900, avg_position: 12 } }),
  ]);
  assert.strictEqual(out[1].deltas['gsc.clicks'].direction, 'improved');
  assert.strictEqual(out[1].deltas['gsc.clicks'].absoluteChange, 50);
  assert.strictEqual(out[1].deltas['gsc.impressions'].direction, 'worsened');
});

test('position metric down = improved (avg position 12 -> 8)', () => {
  const out = attachTrendDeltas([
    m('2026-04', { gsc: { clicks: 1, impressions: 1, avg_position: 12 } }),
    m('2026-05', { gsc: { clicks: 1, impressions: 1, avg_position: 8 } }),
  ]);
  assert.strictEqual(out[1].deltas['gsc.avg_position'].direction, 'improved');
});

test('fewer scored issues = improved; more broken links = worsened', () => {
  const out = attachTrendDeltas([
    m('2026-04', { health: { scored_issues: 8, high: 2, medium: 3, low: 3 }, crawl: { pages: 60, broken: 2 } }),
    m('2026-05', { health: { scored_issues: 5, high: 1, medium: 2, low: 2 }, crawl: { pages: 60, broken: 4 } }),
  ]);
  assert.strictEqual(out[1].deltas['health.scored_issues'].direction, 'improved');
  assert.strictEqual(out[1].deltas['crawl.broken'].direction, 'worsened');
  assert.strictEqual(out[1].deltas['crawl.pages'].direction, 'flat');
});

test('a skipped month does not fabricate a zero: delta skips to the nearest prior month WITH data', () => {
  const out = attachTrendDeltas([
    m('2026-03', { ga4: { sessions: 200, active_users: 150 } }),
    m('2026-04', { gsc: { clicks: 10, impressions: 100, avg_position: 9 } }), // no GA4 upload this month
    m('2026-05', { ga4: { sessions: 260, active_users: 180 } }),
  ]);
  assert.strictEqual(out[1].deltas['ga4.sessions'], undefined); // no GA4 in 04 -> no delta key at all
  assert.strictEqual(out[2].deltas['ga4.sessions'].prior, 200); // 05 compares to 03, not a fabricated 0
  assert.strictEqual(out[2].deltas['ga4.sessions'].direction, 'improved');
});

test('a metric absent in ALL prior months gets no delta (it is new)', () => {
  const out = attachTrendDeltas([
    m('2026-04', { gsc: { clicks: 10, impressions: 100, avg_position: 9 } }),
    m('2026-05', { gsc: { clicks: 12, impressions: 100, avg_position: 9 }, keywords: { tracked: 30, avg_position: 14, top10: 6 } }),
  ]);
  assert.strictEqual(out[1].deltas['keywords.top10'], undefined);
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
