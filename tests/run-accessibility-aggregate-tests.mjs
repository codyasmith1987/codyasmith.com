// Aggregate accessibility parser — blank-vs-measured discipline.
//
// PROVES the fix for the score-inflation bug: the free Screaming Frog
// accessibility_all.csv export lists the page rows but leaves every
// violation column blank. The old parser did `total += (row['All Violations'] || 0)`,
// coercing blank -> 0, and always wrote `accessibility_pages_audited = rowCount`.
// Result: "audited N pages, 0 violations" for a file that was never measured.
//
// The corrected parser:
//   - ignores blank/undefined violation cells (does NOT coerce to 0),
//   - tracks whether ANY real numeric value was seen across the violation cols,
//   - writes NO metrics rows when nothing real was measured (free-SF blank export),
//   - writes the sums (a genuine 0 stays 0) when at least one real value was seen.
//
// Assertions are against a HAND-COUNT of each fixture, never old-code output.
// We test the pure metrics builder (buildAccessibilityMetrics) so no DB is needed.

import assert from 'node:assert';
import { buildAccessibilityMetrics } from '../src/lib/csv/parsers/accessibility.ts';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`[PASS] ${name}`); passed++; }
  catch (e) { console.error(`[FAIL] ${name}: ${e.message}`); failed++; }
}

const HEADER = 'Address,All Violations,WCAG 2.0 A Violations,WCAG 2.0 AA Violations,WCAG 2.1 AA Violations';

// ─── Fixture 1: free-SF blank export — 5 page rows, all violation cells blank ──
const BLANK = [
  HEADER,
  'https://f3.com/,,,,',
  'https://f3.com/about,,,,',
  'https://f3.com/services,,,,',
  'https://f3.com/contact,,,,',
  'https://f3.com/blog,,,,',
].join('\n');

test('blank export (5 rows, all violation cells blank) -> NO metrics rows written', () => {
  const metrics = buildAccessibilityMetrics(BLANK);
  // Hand count: nothing was measured. Must write zero metrics rows, NOT 5 zeros.
  assert.strictEqual(metrics.length, 0, `expected 0 metrics rows for an unmeasured file, got ${metrics.length}: ${JSON.stringify(metrics)}`);
});

// ─── Fixture 2: real values — one page with 3 violations, the rest measured-0 ──
const REAL = [
  HEADER,
  'https://f3.com/,3,1,2,0',
  'https://f3.com/about,0,0,0,0',
  'https://f3.com/services,0,0,0,0',
  'https://f3.com/contact,0,0,0,0',
  'https://f3.com/blog,0,0,0,0',
].join('\n');

test('real-values export -> 5 metrics rows with correct hand-counted sums', () => {
  const metrics = buildAccessibilityMetrics(REAL);
  assert.strictEqual(metrics.length, 5, `expected 5 metrics rows, got ${metrics.length}`);
  const byKey = Object.fromEntries(metrics.map(m => [m.key, m.value]));
  // Hand count across the 5 rows.
  assert.strictEqual(byKey.accessibility_total_violations, 3, 'total violations sum');
  assert.strictEqual(byKey.accessibility_wcag20a, 1, 'wcag20a sum');
  assert.strictEqual(byKey.accessibility_wcag20aa, 2, 'wcag20aa sum');
  assert.strictEqual(byKey.accessibility_wcag21aa, 0, 'wcag21aa sum');
  assert.strictEqual(byKey.accessibility_pages_audited, 5, 'pages audited');
});

// ─── Fixture 3: genuine all-zero-but-MEASURED — every cell literally "0" ───────
const ALL_ZERO = [
  HEADER,
  'https://f3.com/,0,0,0,0',
  'https://f3.com/about,0,0,0,0',
  'https://f3.com/services,0,0,0,0',
].join('\n');

test('measured-clean export (cells literally "0") -> rows written with value 0', () => {
  const metrics = buildAccessibilityMetrics(ALL_ZERO);
  // A genuine measured-clean result is real data: write the rows, all zero.
  assert.strictEqual(metrics.length, 5, `expected 5 metrics rows for a measured-clean file, got ${metrics.length}`);
  const byKey = Object.fromEntries(metrics.map(m => [m.key, m.value]));
  assert.strictEqual(byKey.accessibility_total_violations, 0, 'total violations 0 (measured clean)');
  assert.strictEqual(byKey.accessibility_pages_audited, 3, 'pages audited');
});

// ─── Fixture 4: partial — only some cells blank, at least one real value ───────
const PARTIAL = [
  HEADER,
  'https://f3.com/,5,,,',     // only All Violations measured here
  'https://f3.com/about,,,,', // fully blank row
].join('\n');

test('partial export (one real value, rest blank) -> measured: rows written, blanks ignored', () => {
  const metrics = buildAccessibilityMetrics(PARTIAL);
  assert.strictEqual(metrics.length, 5, `expected 5 metrics rows once any real value seen, got ${metrics.length}`);
  const byKey = Object.fromEntries(metrics.map(m => [m.key, m.value]));
  // Blank cells must be ignored (not coerced to 0 and not skipped as a row).
  assert.strictEqual(byKey.accessibility_total_violations, 5, 'sum ignores blanks, counts the real 5');
  assert.strictEqual(byKey.accessibility_wcag20a, 0, 'no real wcag20a values -> sum 0');
  assert.strictEqual(byKey.accessibility_pages_audited, 2, 'pages audited counts all page rows');
});

// ─── Fixture 5: empty file -> no rows ──────────────────────────────────────────
test('empty file -> 0 metrics rows', () => {
  const metrics = buildAccessibilityMetrics(HEADER + '\n');
  assert.strictEqual(metrics.length, 0, 'no data rows -> no metrics');
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
