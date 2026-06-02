// Backfill migration tests (Task 5).
//
// PROVES: the 057 backfill recomputes data_coverage for every existing
// (client_id, month, category) from the SAME coverage-signals matrix used at
// ingest, so historical uploads get an honest coverage record:
//   - free-SF accessibility (5 rows, all signal cols NULL) -> measured=0,
//     rows_total=5, rows_measured=0 (corrects F3's "0 violations" to "not measured").
//   - a measured accessibility month (some real signal values) -> measured=1,
//     rows_measured = count of rows with any real signal value.
//   - a file-present category with rows (crawl) -> measured=1.
//   - a file-present category provided as a 0-row upload (live csv_uploads row,
//     no data rows) still -> measured=1 (file provided = measured).
//   - idempotent: re-running the backfill produces no duplicate rows (upsert).
//
// Oracle: hand-counted truth of the seeded rows, NOT old-code output. The
// backfill is exercised against an in-memory libsql db via the exported
// backfillCoverage(db) seam (the migration's up() calls it with turso).

import assert from 'node:assert';
import { createClient } from '@libsql/client';
import { backfillCoverage } from '../src/lib/migrations/057-backfill-data-coverage.ts';

let passed = 0, failed = 0;
async function test(n, f) {
  try { await f(); console.log(`[PASS] ${n}`); passed++; }
  catch (e) { console.error(`[FAIL] ${n}: ${e.message}`); failed++; }
}

// Fresh in-memory db with csv_uploads, data_coverage, and the data tables the
// backfill reads. Columns mirror the real DDL for the slice the backfill uses
// (client_id, month, and the signal columns for signal categories).
async function freshDb() {
  const db = createClient({ url: 'file::memory:' });
  await db.execute('PRAGMA foreign_keys=ON');
  await db.execute(`CREATE TABLE csv_uploads (
    id TEXT PRIMARY KEY,
    client_id TEXT,
    original_name TEXT,
    detected_format TEXT,
    month TEXT,
    error TEXT,
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
  await db.execute(`CREATE TABLE accessibility_urls (
    id TEXT PRIMARY KEY, client_id TEXT, month TEXT, url TEXT,
    all_violations INTEGER, best_practice_violations INTEGER,
    wcag_20a_violations INTEGER, wcag_20aa_violations INTEGER, wcag_21aa_violations INTEGER
  )`);
  await db.execute(`CREATE TABLE structured_data_urls (
    id TEXT PRIMARY KEY, client_id TEXT, month TEXT, url TEXT,
    error_count INTEGER, warning_count INTEGER, total_types INTEGER
  )`);
  await db.execute(`CREATE TABLE content_urls (
    id TEXT PRIMARY KEY, client_id TEXT, month TEXT, url TEXT,
    flesch_reading_ease REAL, spelling_errors INTEGER,
    grammar_errors INTEGER, near_duplicate_count INTEGER
  )`);
  await db.execute(`CREATE TABLE crawl_urls (
    id TEXT PRIMARY KEY, client_id TEXT, month TEXT, url TEXT
  )`);
  await db.execute(`CREATE TABLE link_graph (
    id TEXT PRIMARY KEY, client_id TEXT, month TEXT
  )`);
  await db.execute(`CREATE TABLE image_urls (
    id TEXT PRIMARY KEY, client_id TEXT, month TEXT
  )`);
  await db.execute(`CREATE TABLE redirect_chains (
    id TEXT PRIMARY KEY, client_id TEXT, month TEXT
  )`);
  await db.execute(`CREATE TABLE security_urls (
    id TEXT PRIMARY KEY, client_id TEXT, month TEXT
  )`);
  await db.execute(`CREATE TABLE keyword_rankings (
    id TEXT PRIMARY KEY, client_id TEXT, month TEXT
  )`);
  await db.execute(`CREATE TABLE ga4_channels (
    id TEXT PRIMARY KEY, client_id TEXT, month TEXT
  )`);
  await db.execute(`CREATE TABLE gsc_dimensions (
    id TEXT PRIMARY KEY, client_id TEXT, month TEXT
  )`);
  await db.execute(`CREATE TABLE site_issues (
    id TEXT PRIMARY KEY, client_id TEXT, month TEXT
  )`);
  return db;
}

let pk = 0;
function nextId() { return `row_${++pk}`; }

async function seedAccessibility(db, client, month, rows) {
  // rows: array of [all, bestPractice, wcag20a, wcag20aa, wcag21aa] (null allowed)
  for (const r of rows) {
    await db.execute({
      sql: `INSERT INTO accessibility_urls (id, client_id, month, url, all_violations, best_practice_violations, wcag_20a_violations, wcag_20aa_violations, wcag_21aa_violations)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [nextId(), client, month, `https://x/${nextId()}`, r[0], r[1], r[2], r[3], r[4]],
    });
  }
}
async function seedCrawl(db, client, month, count) {
  for (let i = 0; i < count; i++) {
    await db.execute({
      sql: `INSERT INTO crawl_urls (id, client_id, month, url) VALUES (?, ?, ?, ?)`,
      args: [nextId(), client, month, `https://x/c${i}`],
    });
  }
}
async function seedUpload(db, client, month, format, original) {
  await db.execute({
    sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month, error) VALUES (?, ?, ?, ?, ?, NULL)`,
    args: [nextId(), client, original, format, month],
  });
}

async function getCov(db, client, month, category) {
  const r = await db.execute({
    sql: `SELECT measured, rows_total, rows_measured, source, csv_upload_id FROM data_coverage WHERE client_id = ? AND month = ? AND category = ?`,
    args: [client, month, category],
  });
  return r.rows;
}

const C = 'c1';
const M = '2026-05';

// ── (1) free-SF accessibility (5 rows, all signal cols NULL) -> not measured ──
await test('(1) accessibility 5 rows all signal NULL -> measured=0, rows_total=5, rows_measured=0 (F3 corrected to "not measured")', async () => {
  const db = await freshDb();
  await seedAccessibility(db, C, M, [
    [null, null, null, null, null],
    [null, null, null, null, null],
    [null, null, null, null, null],
    [null, null, null, null, null],
    [null, null, null, null, null],
  ]);
  await backfillCoverage(db);
  const rows = await getCov(db, C, M, 'accessibility');
  assert.strictEqual(rows.length, 1, 'one accessibility coverage row');
  assert.strictEqual(Number(rows[0].measured), 0, 'all blank -> measured = 0');
  assert.strictEqual(Number(rows[0].rows_total), 5, 'rows_total = 5');
  assert.strictEqual(Number(rows[0].rows_measured), 0, 'rows_measured = 0');
  assert.strictEqual(rows[0].source, 'backfill', "source = 'backfill'");
  assert.strictEqual(rows[0].csv_upload_id, null, 'csv_upload_id NULL on backfill');
});

// ── (2) accessibility with real signals -> measured=1, rows_measured counts real-valued rows ──
await test('(2) accessibility mixed (real 3, literal 0, blank) -> measured=1, rows_total=3, rows_measured=2', async () => {
  const db = await freshDb();
  await seedAccessibility(db, C, M, [
    [3, 1, 2, 0, 0],            // real -> measured row
    [0, 0, 0, 0, 0],            // literal 0 -> real value, measured row
    [null, null, null, null, null], // blank -> not measured
  ]);
  await backfillCoverage(db);
  const rows = await getCov(db, C, M, 'accessibility');
  assert.strictEqual(rows.length, 1, 'one accessibility coverage row');
  assert.strictEqual(Number(rows[0].measured), 1, 'real values -> measured = 1');
  assert.strictEqual(Number(rows[0].rows_total), 3, 'rows_total = 3');
  assert.strictEqual(Number(rows[0].rows_measured), 2, 'rows_measured = 2 (the "3" row and the literal-0 row)');
});

// ── (3) file-present category with rows (crawl) -> measured=1 ──
await test('(3) crawl_urls rows present -> crawl measured=1, rows_total == rows_measured == COUNT(*)', async () => {
  const db = await freshDb();
  await seedCrawl(db, C, M, 7);
  await backfillCoverage(db);
  const rows = await getCov(db, C, M, 'crawl');
  assert.strictEqual(rows.length, 1, 'one crawl coverage row');
  assert.strictEqual(Number(rows[0].measured), 1, 'crawl rows present -> measured = 1');
  assert.strictEqual(Number(rows[0].rows_total), 7, 'rows_total = 7');
  assert.strictEqual(Number(rows[0].rows_measured), 7, 'rows_measured = 7 (file-present)');
  assert.strictEqual(rows[0].source, 'backfill', "source = 'backfill'");
});

// ── (4) file-present provided as a 0-row upload (live csv_uploads, no data rows) -> measured=1 ──
await test('(4) live csv_uploads redirects row with NO redirect_chains rows -> redirects measured=1, rows_total=0', async () => {
  const db = await freshDb();
  await seedUpload(db, C, M, 'redirects', 'redirect_chains.csv');
  await backfillCoverage(db);
  const rows = await getCov(db, C, M, 'redirects');
  assert.strictEqual(rows.length, 1, 'one redirects coverage row from the upload UNION');
  assert.strictEqual(Number(rows[0].measured), 1, 'file provided -> measured = 1 even with 0 data rows');
  assert.strictEqual(Number(rows[0].rows_total), 0, 'rows_total = 0 (no data rows)');
  assert.strictEqual(Number(rows[0].rows_measured), 0, 'rows_measured = 0');
});

// ── (5) keywords mapped from a standalone detected_format (position_tracking) ──
await test('(5) live csv_uploads position_tracking row maps to keywords category, measured=1', async () => {
  const db = await freshDb();
  await seedUpload(db, C, M, 'position_tracking', 'keywords.csv');
  await backfillCoverage(db);
  const rows = await getCov(db, C, M, 'keywords');
  assert.strictEqual(rows.length, 1, 'one keywords coverage row');
  assert.strictEqual(Number(rows[0].measured), 1, 'keywords file provided -> measured = 1');
});

// ── (6) signal category with NO rows produces NO coverage row (absence == not provided) ──
await test('(6) structured_data with no rows and no upload -> NO coverage row written', async () => {
  const db = await freshDb();
  await seedCrawl(db, C, M, 1); // unrelated data so the db is not empty
  await backfillCoverage(db);
  const rows = await getCov(db, C, M, 'structured_data');
  assert.strictEqual(rows.length, 0, 'no structured_data rows -> no coverage row');
});

// ── (7) idempotent: re-running the backfill produces no duplicate rows ──
await test('(7) idempotent: running backfillCoverage twice yields exactly one row per (client, month, category)', async () => {
  const db = await freshDb();
  await seedAccessibility(db, C, M, [
    [null, null, null, null, null],
    [3, 0, 0, 0, 0],
  ]);
  await seedCrawl(db, C, M, 4);
  await backfillCoverage(db);
  await backfillCoverage(db); // second pass
  const acc = await getCov(db, C, M, 'accessibility');
  const crawl = await getCov(db, C, M, 'crawl');
  assert.strictEqual(acc.length, 1, 'still exactly one accessibility row after re-run');
  assert.strictEqual(crawl.length, 1, 'still exactly one crawl row after re-run');
  // Values recomputed identically.
  assert.strictEqual(Number(acc[0].measured), 1, 'accessibility measured stays 1');
  assert.strictEqual(Number(acc[0].rows_total), 2, 'accessibility rows_total = 2');
  assert.strictEqual(Number(acc[0].rows_measured), 1, 'accessibility rows_measured = 1 (only the "3" row)');
  assert.strictEqual(Number(crawl[0].rows_total), 4, 'crawl rows_total = 4');
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
