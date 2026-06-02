// Coverage aggregation tests (Fix B).
//
// PROVES the fix for the LAST-WRITER-WINS bug shipped in PR #256: coverage was
// written PER FILE via coverageCountsFromStatements(category, parserStatements).
// When MULTIPLE files feed one category in a month (content_quality is fed by
// content_all.csv — the file with real flesch/spelling/near-dup signal — AND by
// internal_css/internal_images/internal_javascript.csv resource lists with NO
// signal), the no-signal resource file ingesting AFTER content_all overwrote the
// coverage row to measured=0. ZKH content then showed "not measured" even though
// content_all's measured rows were sitting in content_urls.
//
// THE FIX: recomputeCategoryCoverage(db, clientId, month, category) computes
// coverage from the TABLE STATE (aggregate over ALL rows for that
// client/month/category), not from a single file's statements. So the order in
// which files arrive, and how many feed the category, no longer matter.
//
// Oracle: hand-counted truth of the seeded rows, NOT old-code output. We seed
// content_all-like rows WITH signal, then a resource file's rows with NO signal,
// then call recomputeCategoryCoverage('content_quality') and assert measured=1
// with rows_measured = the signal rows (NOT 0). We ALSO prove the inverse old
// per-file behavior (last file's coverageCountsFromStatements) would have given
// measured=0 — the exact bug.

import assert from 'node:assert';
import { createClient } from '@libsql/client';
import {
  recomputeCategoryCoverage,
  coverageCountsFromStatements,
} from '../src/lib/csv/coverage-signals.ts';

let passed = 0, failed = 0;
async function test(n, f) {
  try { await f(); console.log(`[PASS] ${n}`); passed++; }
  catch (e) { console.error(`[FAIL] ${n}: ${e.message}`); failed++; }
}

const C = 'c1';
const M = '2026-05';

// Fresh in-memory db with csv_uploads, data_coverage, and the data tables the
// recompute reads. content_urls carries the four signal columns the matrix
// names (flesch_reading_ease, spelling_errors, grammar_errors,
// near_duplicate_count) plus a csv_upload_id so we can simulate two files.
async function freshDb() {
  const db = createClient({ url: 'file::memory:' });
  await db.execute('PRAGMA foreign_keys=ON');
  await db.execute(`CREATE TABLE csv_uploads (
    id TEXT PRIMARY KEY, client_id TEXT, original_name TEXT,
    detected_format TEXT, month TEXT, error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  await db.execute(`CREATE TABLE data_coverage (
    id            TEXT PRIMARY KEY,
    client_id     TEXT NOT NULL,
    month         TEXT NOT NULL,
    category      TEXT NOT NULL,
    measured      INTEGER NOT NULL,
    rows_total    INTEGER,
    rows_measured INTEGER,
    source        TEXT,
    csv_upload_id TEXT REFERENCES csv_uploads(id),
    detected_at   TEXT DEFAULT (datetime('now')),
    UNIQUE(client_id, month, category)
  )`);
  await db.execute(`CREATE TABLE content_urls (
    id TEXT PRIMARY KEY, client_id TEXT, csv_upload_id TEXT, month TEXT, url TEXT,
    flesch_reading_ease REAL, spelling_errors INTEGER,
    grammar_errors INTEGER, near_duplicate_count INTEGER
  )`);
  await db.execute(`CREATE TABLE crawl_urls (
    id TEXT PRIMARY KEY, client_id TEXT, month TEXT, url TEXT
  )`);
  await db.execute(`CREATE TABLE keyword_rankings (
    id TEXT PRIMARY KEY, client_id TEXT, month TEXT
  )`);
  return db;
}

let pk = 0;
function nextId() { return `row_${++pk}`; }

// Seed a live csv_uploads row so the data_coverage.csv_upload_id FK is
// satisfied (in the real ingest path the upload row always exists — we just
// inserted it before calling recompute).
async function seedUpload(db, uploadId, format, original) {
  await db.execute({
    sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month, error) VALUES (?, ?, ?, ?, ?, NULL)`,
    args: [uploadId, C, original, format, M],
  });
}

// Insert one content_urls row. signal = { flesch, spelling, grammar, nearDup }
// — null means "not measured" for that column.
async function insertContent(db, uploadId, signal) {
  const s = signal || {};
  await db.execute({
    sql: `INSERT INTO content_urls
      (id, client_id, csv_upload_id, month, url, flesch_reading_ease, spelling_errors, grammar_errors, near_duplicate_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      nextId(), C, uploadId, M, `https://x/${nextId()}`,
      s.flesch ?? null, s.spelling ?? null, s.grammar ?? null, s.nearDup ?? null,
    ],
  });
}

async function getCov(db, category) {
  const r = await db.execute({
    sql: `SELECT measured, rows_total, rows_measured, source, csv_upload_id FROM data_coverage WHERE client_id = ? AND month = ? AND category = ?`,
    args: [C, M, category],
  });
  return r.rows;
}

// ── (1) THE BUG: content_all (signal) + resource file (no signal) ──
// content_all.csv ingests 3 rows WITH real flesch/spelling signal.
// internal_css.csv (a resource list routed to content_urls) ingests 4 rows
// with NO signal columns. recomputeCategoryCoverage must aggregate the whole
// table: rows_total=7, rows_measured=3, measured=1 — regardless of which file
// ingested last.
await test('(1) AGGREGATE: content_all signal rows + resource-file no-signal rows -> measured=1, rows_total=7, rows_measured=3 (not last-writer-wins 0)', async () => {
  const db = await freshDb();
  await seedUpload(db, 'up_content_all', 'content_urls', 'content_all.csv');
  await seedUpload(db, 'up_internal_css', 'content_urls', 'internal_css.csv');
  // content_all.csv: 3 rows WITH signal (one literal-0 spelling counts as real).
  await insertContent(db, 'up_content_all', { flesch: 62.5, spelling: 2, grammar: 1, nearDup: 0 });
  await insertContent(db, 'up_content_all', { flesch: 71.0, spelling: 0, grammar: 0, nearDup: 0 });
  await insertContent(db, 'up_content_all', { flesch: 45.2, spelling: 5, grammar: 3, nearDup: 1 });
  // internal_css.csv: 4 rows, NO signal (resource list, all signal cols NULL) —
  // this is the file that, ingesting LAST, used to overwrite coverage to 0.
  await insertContent(db, 'up_internal_css', {});
  await insertContent(db, 'up_internal_css', {});
  await insertContent(db, 'up_internal_css', {});
  await insertContent(db, 'up_internal_css', {});

  await recomputeCategoryCoverage(db, C, M, 'content_quality', 'csv_upload', 'up_internal_css');

  const rows = await getCov(db, 'content_quality');
  assert.strictEqual(rows.length, 1, 'exactly one content_quality coverage row');
  assert.strictEqual(Number(rows[0].measured), 1, 'real signal present in the table -> measured = 1');
  assert.strictEqual(Number(rows[0].rows_total), 7, 'rows_total = full table (3 + 4)');
  assert.strictEqual(Number(rows[0].rows_measured), 3, 'rows_measured = the 3 content_all rows with signal');
  assert.strictEqual(rows[0].source, 'csv_upload', "source param threads through as 'csv_upload'");
  assert.strictEqual(rows[0].csv_upload_id, 'up_internal_css', 'csv_upload_id param threads through');
});

// ── (2) PROVE THE INVERSE OLD BEHAVIOR: the last file's per-file count was 0 ──
// The OLD code called coverageCountsFromStatements('content_quality', <the
// resource file's statements>) and upserted last-writer-wins. With the resource
// file's 4 no-signal statements, that produced measured=0 — which is exactly
// the "not measured" bug ZKH saw. We reconstruct that per-file count here and
// assert it WOULD have been 0, then assert the new aggregate is the opposite.
await test('(2) INVERSE: old per-file count of the LAST (resource) file = measured 0; new aggregate = measured 1', async () => {
  const db = await freshDb();
  await seedUpload(db, 'up_content_all', 'content_urls', 'content_all.csv');
  await seedUpload(db, 'up_internal_css', 'content_urls', 'internal_css.csv');
  await insertContent(db, 'up_content_all', { flesch: 62.5, spelling: 2, grammar: 1, nearDup: 0 });
  await insertContent(db, 'up_internal_css', {});
  await insertContent(db, 'up_internal_css', {});

  // Reconstruct the OLD per-file statements the resource file's builder would
  // have produced: 2 content_urls inserts, all signal positions (9,16,17,12 in
  // the real 20-col layout) NULL. coverageCountsFromStatements -> measured 0.
  function noSignalContentStmt() {
    const args = new Array(20).fill(null);
    args[0] = nextId(); args[1] = C; args[2] = 'up_internal_css'; args[3] = M;
    args[4] = `https://x/${nextId()}`; args[5] = 'x';
    // signal positions 9 (flesch), 12 (near_dup), 16 (spelling), 17 (grammar) stay null
    return { sql: 'INSERT INTO content_urls ...', args };
  }
  const oldPerFile = coverageCountsFromStatements('content_quality', [noSignalContentStmt(), noSignalContentStmt()]);
  assert.strictEqual(oldPerFile.measured, 0, 'OLD per-file count of the resource file = measured 0 (the bug)');
  assert.strictEqual(oldPerFile.rowsMeasured, 0, 'OLD per-file rows_measured = 0');

  // NEW aggregate reads the whole table and recovers the truth.
  await recomputeCategoryCoverage(db, C, M, 'content_quality', 'csv_upload', 'up_internal_css');
  const rows = await getCov(db, 'content_quality');
  assert.strictEqual(Number(rows[0].measured), 1, 'NEW aggregate -> measured = 1 (content_all signal recovered)');
  assert.strictEqual(Number(rows[0].rows_measured), 1, 'NEW rows_measured = 1 (the single content_all signal row)');
  assert.strictEqual(Number(rows[0].rows_total), 3, 'NEW rows_total = 3 (1 + 2)');
});

// ── (3) Order independence: ingesting content_all LAST yields the same row ──
await test('(3) ORDER-INDEPENDENT: recompute after the resource file then after content_all both give measured=1', async () => {
  const db = await freshDb();
  await seedUpload(db, 'up_content_all', 'content_urls', 'content_all.csv');
  await seedUpload(db, 'up_internal_css', 'content_urls', 'internal_css.csv');
  // Resource file lands first this time.
  await insertContent(db, 'up_internal_css', {});
  await insertContent(db, 'up_internal_css', {});
  await recomputeCategoryCoverage(db, C, M, 'content_quality', 'csv_upload', 'up_internal_css');
  let rows = await getCov(db, 'content_quality');
  assert.strictEqual(Number(rows[0].measured), 0, 'only resource rows so far -> measured 0 (honest: nothing measured yet)');

  // content_all lands second; recompute must flip the SAME row to measured 1.
  await insertContent(db, 'up_content_all', { flesch: 62.5, spelling: 2 });
  await recomputeCategoryCoverage(db, C, M, 'content_quality', 'csv_upload', 'up_content_all');
  rows = await getCov(db, 'content_quality');
  assert.strictEqual(rows.length, 1, 'still exactly one row (upsert, not duplicate)');
  assert.strictEqual(Number(rows[0].measured), 1, 'after content_all -> measured 1');
  assert.strictEqual(Number(rows[0].rows_total), 3, 'rows_total = 3 (2 resource + 1 content_all)');
  assert.strictEqual(Number(rows[0].rows_measured), 1, 'rows_measured = 1 (the content_all row)');
});

// ── (4) File-present category: measured=1, rows_total = COUNT(*) in the table ──
await test('(4) FILE-PRESENT: crawl recompute -> measured=1, rows_total = rows_measured = COUNT(*) in crawl_urls', async () => {
  const db = await freshDb();
  await seedUpload(db, 'up_crawl', 'crawl_internal', 'internal_all.csv');
  for (let i = 0; i < 5; i++) {
    await db.execute({ sql: `INSERT INTO crawl_urls (id, client_id, month, url) VALUES (?, ?, ?, ?)`, args: [nextId(), C, M, `https://x/c${i}`] });
  }
  await recomputeCategoryCoverage(db, C, M, 'crawl', 'csv_upload', 'up_crawl');
  const rows = await getCov(db, 'crawl');
  assert.strictEqual(rows.length, 1, 'one crawl coverage row');
  assert.strictEqual(Number(rows[0].measured), 1, 'file present -> measured 1');
  assert.strictEqual(Number(rows[0].rows_total), 5, 'rows_total = COUNT(*) = 5');
  assert.strictEqual(Number(rows[0].rows_measured), 5, 'rows_measured = COUNT(*) = 5 (file-present)');
  assert.strictEqual(rows[0].csv_upload_id, 'up_crawl', 'csv_upload_id threads through');
});

// ── (5) File-present with ZERO data rows in the table still measured=1 ──
// A live upload exists (we just ingested one) but the file had no data rows; the
// recompute must still record measured=1 ("we looked, nothing there").
await test('(5) FILE-PRESENT zero-row: a just-ingested keywords upload with 0 table rows -> measured=1, rows_total=0', async () => {
  const db = await freshDb();
  await seedUpload(db, 'up_kw_empty', 'position_tracking', 'keywords.csv');
  await recomputeCategoryCoverage(db, C, M, 'keywords', 'csv_upload', 'up_kw_empty');
  const rows = await getCov(db, 'keywords');
  assert.strictEqual(rows.length, 1, 'one keywords coverage row even with 0 table rows');
  assert.strictEqual(Number(rows[0].measured), 1, 'file provided -> measured 1');
  assert.strictEqual(Number(rows[0].rows_total), 0, 'rows_total = 0');
  assert.strictEqual(Number(rows[0].rows_measured), 0, 'rows_measured = 0');
});

// ── (6) source/uploadId parameterization: backfill mode writes source=backfill, csv_upload_id NULL ──
await test('(6) PARAM: source=backfill, uploadId=null -> coverage row source backfill with NULL csv_upload_id', async () => {
  const db = await freshDb();
  await seedUpload(db, 'up_content_all', 'content_urls', 'content_all.csv');
  await insertContent(db, 'up_content_all', { flesch: 62.5 });
  await recomputeCategoryCoverage(db, C, M, 'content_quality', 'backfill', null);
  const rows = await getCov(db, 'content_quality');
  assert.strictEqual(rows[0].source, 'backfill', "source = 'backfill'");
  assert.strictEqual(rows[0].csv_upload_id, null, 'csv_upload_id NULL on backfill');
  assert.strictEqual(Number(rows[0].measured), 1, 'measured 1');
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
