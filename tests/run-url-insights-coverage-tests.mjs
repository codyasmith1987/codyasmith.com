// url-insights coverage-gating + per-metric NULL-awareness tests (Task 6).
//
// PROVES: the url-insights read layer consumes data_coverage instead of
// re-deriving measured-ness from NULLs, so missing data never reads as a
// measured "0 / all clear":
//   - a signal category with data_coverage.measured = 0 (free-SF blank export)
//     -> has_X_data = false and NO "0 violations / 0 errors" surfaced; the
//     category_coverage block carries measured=0, rows_total=N, rows_measured=0
//     so the client can render an explicit "not measured" state.
//   - a signal category with measured = 1 and a legitimate 0 in the data ->
//     has_X_data = true and the real "measured, 0 issues" path (total = 0).
//   - per-sub-metric NULL-awareness inside content_quality: a month measured
//     overall but with one blank sub-metric column reports that sub-metric as
//     { measured: false }, NOT a clean 0; sub-metrics with real values report
//     measured: true and counts over the non-NULL rows only.
//   - file-present categories (crawl/images/redirects/links) keep current
//     month-presence gating (no coverage row required).
//
// Oracle: hand-counted truth of the seeded rows + coverage rows, NOT old-code
// output. Exercised against an in-memory libsql db via the exported
// loadUrlInsights(db, clientId) seam (the GET handler calls it with turso).

import assert from 'node:assert';
import { createClient } from '@libsql/client';
import { loadUrlInsights } from '../src/pages/portal/api/dashboard/url-insights.ts';

let passed = 0, failed = 0;
async function test(n, f) {
  try { await f(); console.log(`[PASS] ${n}`); passed++; }
  catch (e) { console.error(`[FAIL] ${n}: ${e.message}`); failed++; }
}

let pk = 0;
function nextId() { return `row_${++pk}`; }

// Fresh in-memory db with data_coverage + the per-URL tables the read layer
// touches. Columns mirror the real DDL for the slice the reader uses.
async function freshDb() {
  const db = createClient({ url: 'file::memory:' });
  await db.execute('PRAGMA foreign_keys=ON');
  await db.execute(`CREATE TABLE data_coverage (
    id            TEXT PRIMARY KEY,
    client_id     TEXT NOT NULL,
    month         TEXT NOT NULL,
    category      TEXT NOT NULL,
    measured      INTEGER NOT NULL,
    rows_total    INTEGER,
    rows_measured INTEGER,
    source        TEXT,
    csv_upload_id TEXT,
    detected_at   TEXT DEFAULT (datetime('now')),
    UNIQUE(client_id, month, category)
  )`);
  await db.execute(`CREATE TABLE crawl_urls (
    id TEXT PRIMARY KEY, client_id TEXT, month TEXT, url TEXT,
    title TEXT, title_length INTEGER, content_type TEXT, indexability TEXT,
    indexability_status TEXT, status_code INTEGER, word_count INTEGER,
    response_time_ms INTEGER, inlinks_count INTEGER, crawl_depth INTEGER
  )`);
  await db.execute(`CREATE TABLE image_urls (
    id TEXT PRIMARY KEY, client_id TEXT, month TEXT, url TEXT,
    size_bytes INTEGER, dimensions TEXT, inlinks_count INTEGER
  )`);
  await db.execute(`CREATE TABLE redirect_chains (
    id TEXT PRIMARY KEY, client_id TEXT, month TEXT,
    source_url TEXT, final_url TEXT, hop_count INTEGER, is_loop INTEGER,
    final_status_code INTEGER
  )`);
  await db.execute(`CREATE TABLE link_graph (
    id TEXT PRIMARY KEY, client_id TEXT, month TEXT,
    source_url TEXT, destination_url TEXT, status_code INTEGER
  )`);
  await db.execute(`CREATE TABLE accessibility_urls (
    id TEXT PRIMARY KEY, client_id TEXT, month TEXT, url TEXT,
    all_violations INTEGER, best_practice_violations INTEGER, status_code INTEGER,
    wcag_20a_violations INTEGER, wcag_20aa_violations INTEGER, wcag_20aaa_violations INTEGER,
    wcag_21a_violations INTEGER, wcag_21aa_violations INTEGER, wcag_22a_violations INTEGER,
    wcag_22aa_violations INTEGER
  )`);
  await db.execute(`CREATE TABLE structured_data_urls (
    id TEXT PRIMARY KEY, client_id TEXT, month TEXT, url TEXT,
    error_count INTEGER, warning_count INTEGER, total_types INTEGER, types_list TEXT
  )`);
  await db.execute(`CREATE TABLE content_urls (
    id TEXT PRIMARY KEY, client_id TEXT, month TEXT, url TEXT,
    flesch_reading_ease REAL, spelling_errors INTEGER, grammar_errors INTEGER,
    near_duplicate_count INTEGER, closest_near_duplicate_url TEXT
  )`);
  // url-insights reads MAX(month) from url_structure_urls unconditionally (for
  // the duplicate-content widget), so the fixture must create it or every test
  // errors with "no such table". Mirrors migration 061's columns.
  await db.execute(`CREATE TABLE url_structure_urls (
    id TEXT PRIMARY KEY, client_id TEXT, month TEXT, url TEXT, hostname TEXT,
    content_type TEXT, status_code INTEGER, status TEXT, indexability TEXT,
    indexability_status TEXT, content_hash TEXT, url_length INTEGER,
    canonical_link_element TEXT, url_encoded_address TEXT, raw_json TEXT
  )`);
  // url-insights also reads MAX(month) from javascript_urls and hreflang_urls
  // unconditionally. Same reason as above; mirrors migration 061's columns.
  await db.execute(`CREATE TABLE javascript_urls (
    id TEXT PRIMARY KEY, client_id TEXT, month TEXT, url TEXT, hostname TEXT,
    status_code INTEGER, html_word_count INTEGER, rendered_word_count INTEGER,
    word_count_change INTEGER, js_word_count_pct REAL, html_title TEXT,
    rendered_title TEXT, html_h1 TEXT, rendered_h1 TEXT, html_meta_description TEXT,
    rendered_meta_description TEXT, html_canonical TEXT, rendered_canonical TEXT,
    unique_inlinks INTEGER, unique_js_inlinks INTEGER, unique_outlinks INTEGER,
    unique_js_outlinks INTEGER, html_meta_robots TEXT, rendered_meta_robots TEXT, raw_json TEXT
  )`);
  await db.execute(`CREATE TABLE hreflang_urls (
    id TEXT PRIMARY KEY, client_id TEXT, month TEXT, url TEXT, hostname TEXT,
    title TEXT, occurrences INTEGER, indexability TEXT, indexability_status TEXT,
    hreflang_count INTEGER, html_hreflang_1 TEXT, html_hreflang_1_url TEXT,
    http_hreflang_1 TEXT, http_hreflang_1_url TEXT, sitemap_hreflang_1 TEXT,
    sitemap_hreflang_1_url TEXT, raw_json TEXT
  )`);
  return db;
}

async function seedCoverage(db, client, month, category, measured, rowsTotal, rowsMeasured) {
  await db.execute({
    sql: `INSERT INTO data_coverage (id, client_id, month, category, measured, rows_total, rows_measured, source)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'csv_upload')`,
    args: [nextId(), client, month, category, measured, rowsTotal, rowsMeasured],
  });
}

// rows: array of [all, status] -- minimal columns the reader's accessibility
// queries touch (all_violations + status_code; WCAG buckets default 0/NULL).
async function seedAccessibility(db, client, month, rows) {
  for (const r of rows) {
    await db.execute({
      sql: `INSERT INTO accessibility_urls (id, client_id, month, url, all_violations, status_code)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [nextId(), client, month, `https://x/${nextId()}`, r[0], r[1] ?? 200],
    });
  }
}

// rows: array of [flesch, spelling, grammar, nearDup] (null allowed per column).
async function seedContent(db, client, month, rows) {
  for (const r of rows) {
    await db.execute({
      sql: `INSERT INTO content_urls (id, client_id, month, url, flesch_reading_ease, spelling_errors, grammar_errors, near_duplicate_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [nextId(), client, month, `https://x/${nextId()}`, r[0], r[1], r[2], r[3]],
    });
  }
}

const C = 'c1';
const M = '2026-05';

// ── (1) accessibility present-but-blank (coverage measured=0) -> not measured ──
await test('(1) accessibility 5 blank rows + coverage measured=0 -> has_accessibility_data=false, NO "0 violations" surfaced, category_coverage.accessibility.measured=0', async () => {
  const db = await freshDb();
  // Free-SF shape: 5 page rows, all violation columns NULL.
  await seedAccessibility(db, C, M, [
    [null, 200], [null, 200], [null, 200], [null, 200], [null, 200],
  ]);
  await seedCoverage(db, C, M, 'accessibility', 0, 5, 0);

  const r = await loadUrlInsights(db, C);
  assert.strictEqual(r.has_accessibility_data, false, 'unmeasured category -> has_accessibility_data = false');
  // The widget must NOT surface a clean measured 0; totals stay at the empty default.
  assert.strictEqual(r.accessibility.total_violations, 0, 'empty default, not a measured 0');
  assert.strictEqual(r.accessibility.pages_with_violations, 0, 'no measured pages-with count');
  assert.deepStrictEqual(r.accessibility.samples, [], 'no samples for an unmeasured category');
  // Explicit coverage block lets the client render "not measured" distinct from "0 issues".
  assert.deepStrictEqual(r.category_coverage.accessibility, { measured: 0, rows_total: 5, rows_measured: 0 });
});

// ── (2) accessibility measured (coverage measured=1) with a legit 0 -> "measured, 0 issues" ──
await test('(2) accessibility measured=1 with a real 0 -> has_accessibility_data=true, total_violations=0 (measured-clean)', async () => {
  const db = await freshDb();
  // All pages measured clean: literal 0 violations.
  await seedAccessibility(db, C, M, [[0, 200], [0, 200], [0, 200]]);
  await seedCoverage(db, C, M, 'accessibility', 1, 3, 3);

  const r = await loadUrlInsights(db, C);
  assert.strictEqual(r.has_accessibility_data, true, 'measured category -> has_accessibility_data = true');
  assert.strictEqual(r.accessibility.total_violations, 0, 'a measured clean 0 reads as 0');
  assert.strictEqual(r.accessibility.pages_with_violations, 0, '0 pages with violations (all clean)');
  assert.deepStrictEqual(r.category_coverage.accessibility, { measured: 1, rows_total: 3, rows_measured: 3 });
});

// ── (3) accessibility measured (coverage measured=1) with real positives -> counts flow ──
await test('(3) accessibility measured=1 with positives -> real counts flow', async () => {
  const db = await freshDb();
  await seedAccessibility(db, C, M, [[3, 200], [0, 200], [5, 200]]);
  await seedCoverage(db, C, M, 'accessibility', 1, 3, 3);

  const r = await loadUrlInsights(db, C);
  assert.strictEqual(r.has_accessibility_data, true);
  assert.strictEqual(r.accessibility.total_violations, 8, '3 + 0 + 5 = 8');
  assert.strictEqual(r.accessibility.pages_with_violations, 2, 'two pages have >0 violations');
});

// ── (4) structured_data present-but-blank (measured=0) -> not measured, no "0 errors" ──
await test('(4) structured_data coverage measured=0 -> has_structured_data=false, no measured 0 errors, category_coverage carries the counts', async () => {
  const db = await freshDb();
  await db.execute({
    sql: `INSERT INTO structured_data_urls (id, client_id, month, url, error_count, warning_count, total_types, types_list)
          VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
    args: [nextId(), C, M, 'https://x/sd1'],
  });
  await db.execute({
    sql: `INSERT INTO structured_data_urls (id, client_id, month, url, error_count, warning_count, total_types, types_list)
          VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
    args: [nextId(), C, M, 'https://x/sd2'],
  });
  await seedCoverage(db, C, M, 'structured_data', 0, 2, 0);

  const r = await loadUrlInsights(db, C);
  assert.strictEqual(r.has_structured_data, false, 'unmeasured -> has_structured_data = false');
  assert.strictEqual(r.structured_data.total_errors, 0, 'empty default, not a measured 0');
  assert.deepStrictEqual(r.structured_data.samples, [], 'no samples');
  assert.deepStrictEqual(r.category_coverage.structured_data, { measured: 0, rows_total: 2, rows_measured: 0 });
});

// ── (5) content_quality per-sub-metric NULL-awareness: readability present, spelling blank ──
await test('(5) content_quality measured=1, readability present but spelling/grammar+nearDup blank -> readability measured:true, spelling_grammar measured:false (not 0), near_duplicate measured:false', async () => {
  const db = await freshDb();
  // 3 rows: flesch present on all, spelling/grammar/nearDup entirely NULL.
  await seedContent(db, C, M, [
    [40, null, null, null],
    [35, null, null, null],
    [55, null, null, null],
  ]);
  await seedCoverage(db, C, M, 'content_quality', 1, 3, 3);

  const r = await loadUrlInsights(db, C);
  assert.strictEqual(r.has_content_quality, true, 'category measured overall');
  assert.strictEqual(r.content_quality.measured.readability, true, 'readability has real values -> measured');
  assert.strictEqual(r.content_quality.measured.spelling_grammar, false, 'all spelling/grammar NULL -> NOT measured (not a clean 0)');
  assert.strictEqual(r.content_quality.measured.near_duplicate, false, 'all near_duplicate_count NULL -> NOT measured');
  // The hard-to-read count is computed over the non-NULL flesch rows only.
  assert.strictEqual(r.content_quality.hard_to_read_count, 2, 'flesch 40 and 35 are < 50; 55 is not');
  // The unmeasured sub-metrics surface no misleading 0-derived count.
  assert.strictEqual(r.content_quality.spelling_grammar_count, 0, 'count is 0 but measured=false marks it not-measured');
  assert.strictEqual(r.content_quality.near_duplicate_count, 0, 'count is 0 but measured=false marks it not-measured');
});

// ── (6) content_quality: spelling present (incl. a real 0), readability blank ──
await test('(6) content_quality: spelling/grammar present with a real 0, readability blank -> spelling_grammar measured:true, readability measured:false', async () => {
  const db = await freshDb();
  await seedContent(db, C, M, [
    [null, 2, 1, 0],   // 3 combined errors, nearDup real 0
    [null, 0, 0, 0],   // measured-clean spelling/grammar, nearDup real 0
  ]);
  await seedCoverage(db, C, M, 'content_quality', 1, 2, 2);

  const r = await loadUrlInsights(db, C);
  assert.strictEqual(r.content_quality.measured.spelling_grammar, true, 'spelling/grammar has real values (incl. a 0) -> measured');
  assert.strictEqual(r.content_quality.measured.near_duplicate, true, 'near_duplicate_count has real 0 values -> measured');
  assert.strictEqual(r.content_quality.measured.readability, false, 'all flesch NULL -> readability NOT measured');
  assert.strictEqual(r.content_quality.spelling_grammar_count, 1, 'one page has >0 combined errors');
  assert.strictEqual(r.content_quality.near_duplicate_count, 0, 'no page has >0 near-duplicates (measured clean)');
  assert.strictEqual(r.content_quality.hard_to_read_count, 0, 'no flesch values -> no hard-to-read count');
});

// ── (7) file-present categories keep month-presence gating (no coverage row needed) ──
await test('(7) crawl/image/redirect/link presence still gates on table data; no data_coverage row required', async () => {
  const db = await freshDb();
  await db.execute({
    sql: `INSERT INTO crawl_urls (id, client_id, month, url, content_type, title, title_length)
          VALUES (?, ?, ?, ?, 'text/html', 'A title', 7)`,
    args: [nextId(), C, M, 'https://x/home'],
  });
  await db.execute({
    sql: `INSERT INTO image_urls (id, client_id, month, url, size_bytes) VALUES (?, ?, ?, ?, 200000)`,
    args: [nextId(), C, M, 'https://x/img.png'],
  });

  const r = await loadUrlInsights(db, C);
  assert.strictEqual(r.has_crawl_data, true, 'crawl gates on crawl_urls presence');
  assert.strictEqual(r.has_image_data, true, 'images gates on image_urls presence');
  assert.strictEqual(r.has_redirect_data, false, 'no redirect rows -> false');
  assert.strictEqual(r.has_link_data, false, 'no link rows -> false');
  // No accessibility data and no coverage row -> not measured, false.
  assert.strictEqual(r.has_accessibility_data, false);
  assert.strictEqual(r.category_coverage.accessibility.measured, 0, 'absent coverage reads as measured=0');
  assert.strictEqual(r.category_coverage.accessibility.rows_total, 0, 'absent coverage -> rows_total 0');
});

// ── (8) accessibility rows present but coverage row ABSENT -> treated as not measured ──
await test('(8) accessibility_urls rows present but NO data_coverage row -> has_accessibility_data=false (absence == not measured, never an inferred clean 0)', async () => {
  const db = await freshDb();
  await seedAccessibility(db, C, M, [[null, 200], [null, 200]]);
  // Intentionally NO coverage row.
  const r = await loadUrlInsights(db, C);
  assert.strictEqual(r.has_accessibility_data, false, 'no coverage row -> not measured');
  assert.strictEqual(r.accessibility.total_violations, 0, 'empty default, not a derived 0');
  assert.deepStrictEqual(r.category_coverage.accessibility, { measured: 0, rows_total: 0, rows_measured: 0 });
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
