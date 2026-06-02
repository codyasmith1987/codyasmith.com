// health.astro not-measured rendering tests (Task 7).
//
// PROVES: the health page consumes category_coverage (from url-insights) to
// pick one of three honest states per signal category, so a provided-but-
// blank category (free Screaming Frog accessibility export) renders a neutral
// muted "not measured" line instead of the green "no issues flagged" all-clear,
// while a measured-clean category still reads as checked-and-clean:
//   - measured = 1                       -> 'measured' (render the widget; a real 0 reads clean)
//   - measured = 0 AND rows_total > 0     -> 'not_measured' (file provided, columns blank)
//   - measured = 0 AND rows_total === 0   -> 'omit' (never provided; render nothing)
//
// The decision logic lives in src/lib/portal/coverage-display.ts as the single
// source of truth. health.astro's inline (browser-side) script mirrors it
// verbatim — the final guard test reads health.astro and asserts the inline
// copy is byte-identical to the helper body, so the two can never drift.
//
// Oracle: hand-reasoned truth of each coverage shape, NOT old-code output.

import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  coverageDisplayState,
  notMeasuredCopy,
  contentStatLines,
  contentAllClear,
} from '../src/lib/portal/coverage-display.ts';

let passed = 0, failed = 0;
async function test(n, f) {
  try { await f(); console.log(`[PASS] ${n}`); passed++; }
  catch (e) { console.error(`[FAIL] ${n}: ${e.message}`); failed++; }
}

// ── state selection ──
await test('(1) measured=1 -> "measured" (render the widget; a real 0 reads clean)', () => {
  assert.strictEqual(coverageDisplayState({ measured: 1, rows_total: 5, rows_measured: 5 }), 'measured');
  assert.strictEqual(coverageDisplayState({ measured: 1, rows_total: 3, rows_measured: 3 }), 'measured');
});

await test('(2) measured=0 with rows_total>0 -> "not_measured" (provided but blank)', () => {
  assert.strictEqual(coverageDisplayState({ measured: 0, rows_total: 5, rows_measured: 0 }), 'not_measured');
  assert.strictEqual(coverageDisplayState({ measured: 0, rows_total: 2, rows_measured: 0 }), 'not_measured');
});

await test('(3) measured=0 with rows_total=0 -> "omit" (never provided)', () => {
  assert.strictEqual(coverageDisplayState({ measured: 0, rows_total: 0, rows_measured: 0 }), 'omit');
});

await test('(4) missing/undefined coverage block -> "omit" (defensive; absence == never provided)', () => {
  assert.strictEqual(coverageDisplayState(undefined), 'omit');
  assert.strictEqual(coverageDisplayState(null), 'omit');
  assert.strictEqual(coverageDisplayState({}), 'omit');
});

// ── client-facing copy: no jargon, no tool names, no green all-clear ──
await test('(5) not-measured copy is neutral, client-facing, no developer/tool jargon', () => {
  for (const cat of ['accessibility', 'structured_data', 'content_quality']) {
    const copy = notMeasuredCopy(cat);
    assert.ok(typeof copy === 'string' && copy.length > 0, `copy exists for ${cat}`);
    const lc = copy.toLowerCase();
    // Must NOT imply a clean/measured result.
    assert.ok(!/no .*(issues|errors|problems).*(flagged|found)/.test(lc),
      `${cat} copy must not read as a clean all-clear: "${copy}"`);
    assert.ok(!/all clear|looks good|no issues/.test(lc),
      `${cat} copy must not read as all-clear: "${copy}"`);
    // No internal tool names / filenames / dev jargon (client-facing rule).
    for (const banned of ['screaming frog', '.csv', 'axe', 'data_coverage', 'measured = 0', 'ingest', 'parser', 'null', 'column']) {
      assert.ok(!lc.includes(banned), `${cat} copy leaks "${banned}": "${copy}"`);
    }
    // Frames it as not part of this crawl / not included, the neutral state.
    assert.ok(/not (included|part of|covered)|wasn't (included|part of)|isn't (included|part of)/.test(lc),
      `${cat} copy should frame as not-included-in-this-crawl: "${copy}"`);
  }
});

await test('(6) unknown category -> generic neutral not-measured copy (no throw)', () => {
  const copy = notMeasuredCopy('something_else');
  assert.ok(typeof copy === 'string' && copy.length > 0);
});

// ── drift guard: the inline copy in health.astro matches the helper source ──
await test('(7) health.astro inline coverageDisplayState matches the helper (no drift)', async () => {
  const helperPath = fileURLToPath(new URL('../src/lib/portal/coverage-display.ts', import.meta.url));
  const healthPath = fileURLToPath(new URL('../src/pages/portal/health.astro', import.meta.url));
  const helperSrc = await readFile(helperPath, 'utf8');
  const healthSrc = await readFile(healthPath, 'utf8');

  // Extract the canonical function body from the helper's marker block.
  const m = helperSrc.match(/\/\/ DRIFT-LOCK:START([\s\S]*?)\/\/ DRIFT-LOCK:END/);
  assert.ok(m, 'helper must contain a DRIFT-LOCK:START/END marker block');
  const canonical = m[1].replace(/\s+/g, ' ').trim();

  const m2 = healthSrc.match(/\/\/ DRIFT-LOCK:START([\s\S]*?)\/\/ DRIFT-LOCK:END/);
  assert.ok(m2, 'health.astro must contain a DRIFT-LOCK:START/END marker block mirroring the helper');
  const inline = m2[1].replace(/\s+/g, ' ').trim();

  assert.strictEqual(inline, canonical,
    'health.astro inline coverage-state logic must be byte-identical to the helper (drift detected)');
});

// ── content_quality per-sub-metric honesty (the false-clean blocker) ──
// A content category can be measured overall while one sub-metric column was
// never populated. The unmeasured sub-metric must render as a neutral "not
// checked" dash, NEVER a green 0, and the all-clear must not fire.
const GREEN_SEVERITIES = new Set(['ok']); // sev('ok') -> emerald (and the default)

await test('(8) measured sub-metric renders a real count + active/clean severity (never a dash)', () => {
  const cq = {
    near_duplicate_count: 2, spelling_grammar_count: 0, hard_to_read_count: 1,
    measured: { near_duplicate: true, spelling_grammar: true, readability: true },
  };
  const [nd, sg, rd] = contentStatLines(cq);
  assert.strictEqual(nd.count, 2); assert.strictEqual(nd.severity, 'medium');
  assert.ok(!/not checked/.test(nd.label), 'measured label has no "not checked"');
  // measured-clean spelling/grammar: a real 0 with the clean 'ok' severity is correct.
  assert.strictEqual(sg.count, 0); assert.strictEqual(sg.severity, 'ok');
  assert.strictEqual(rd.count, 1); assert.strictEqual(rd.severity, 'low');
});

await test('(9) UNMEASURED sub-metric renders a neutral "not checked" dash, NEVER a green 0', () => {
  const cq = {
    near_duplicate_count: 0, spelling_grammar_count: 0, hard_to_read_count: 0,
    // readability ran (clean), spelling/grammar + near-duplicate did NOT.
    measured: { near_duplicate: false, spelling_grammar: false, readability: true },
  };
  const [nd, sg, rd] = contentStatLines(cq);
  for (const line of [nd, sg]) {
    assert.strictEqual(line.count, 'n/a', 'unmeasured count is a neutral placeholder, not 0');
    assert.notStrictEqual(line.count, 0, 'unmeasured count must never render as 0');
    assert.strictEqual(line.severity, 'none', 'unmeasured severity is neutral "none"');
    assert.ok(!GREEN_SEVERITIES.has(line.severity), 'unmeasured sub-metric is NEVER the green clean color');
    assert.ok(/not checked/.test(line.label), 'unmeasured label says it was not checked');
  }
  // the one that DID run reads as a real measured-clean 0.
  assert.strictEqual(rd.count, 0); assert.strictEqual(rd.severity, 'low');
});

await test('(10) all-clear fires only when ALL three sub-metrics were measured AND clean', () => {
  // all measured + all zero -> clean
  assert.strictEqual(contentAllClear({
    near_duplicate_count: 0, spelling_grammar_count: 0, hard_to_read_count: 0,
    measured: { near_duplicate: true, spelling_grammar: true, readability: true },
  }), true);
  // one sub-metric unmeasured -> NOT clean (would falsely imply a pass)
  assert.strictEqual(contentAllClear({
    near_duplicate_count: 0, spelling_grammar_count: 0, hard_to_read_count: 0,
    measured: { near_duplicate: true, spelling_grammar: false, readability: true },
  }), false);
  // all measured but one has issues -> NOT clean
  assert.strictEqual(contentAllClear({
    near_duplicate_count: 3, spelling_grammar_count: 0, hard_to_read_count: 0,
    measured: { near_duplicate: true, spelling_grammar: true, readability: true },
  }), false);
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
