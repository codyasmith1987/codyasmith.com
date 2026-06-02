// Coverage-at-ingest tests (Task 3).
//
// PROVES: ingestCSV writes a data_coverage row in the SAME atomic transaction
// as the data it describes (Class-A), and on the standalone write path
// (Class-B). Coverage can never disagree with the data: a forced parser
// failure rolls back BOTH the per-URL data AND the coverage row.
//
// Oracle: hand-counted truth of the raw-CSV fixtures, NOT the output of old
// code. The fixtures are built here so the expected rows_total / rows_measured
// / measured are known by hand.
//
// We exercise runAtomicIngest directly (the exported seam ingestCSV uses for
// the atomic statement array) against an in-memory libsql db, building the
// coverage statement from the REAL coverage-signals helpers fed the REAL
// accessibility builder's output — so the arg-index wiring is exercised
// end-to-end, not mocked. For the Class-B path we exercise the same
// coverageCountsFilePresent + buildCoverageUpsert helpers + a direct execute,
// mirroring how ingestCSV's Class-B branch writes coverage.

import assert from 'node:assert';
import { createClient } from '@libsql/client';
import { runAtomicIngest } from '../src/lib/csv/index.ts';
import { buildAccessibilityUrlsStatements } from '../src/lib/csv/parsers/accessibility-urls.ts';
import {
  FORMAT_TO_CATEGORY,
  coverageCountsFromStatements,
  coverageCountsFilePresent,
  buildCoverageUpsert,
} from '../src/lib/csv/coverage-signals.ts';

let passed = 0, failed = 0;
async function test(n, f) {
  try { await f(); console.log(`[PASS] ${n}`); passed++; }
  catch (e) { console.error(`[FAIL] ${n}: ${e.message}`); failed++; }
}

const CLIENT = 'c1';
const MONTH = '2026-05';
const ACC_FILENAME = 'accessibility_all.csv';

// Fresh in-memory db with csv_uploads + accessibility_urls + data_coverage and
// the partial unique index. FK ON so the coverage row's csv_upload_id FK to
// csv_uploads(id) is enforced — proving the coverage row commits in the same tx
// after the parent upload row exists.
async function freshDb() {
  const db = createClient({ url: 'file::memory:' });
  await db.execute('PRAGMA foreign_keys=ON');
  await db.execute(`CREATE TABLE csv_uploads (
    id TEXT PRIMARY KEY,
    client_id TEXT,
    original_name TEXT,
    detected_format TEXT,
    month TEXT,
    uploaded_by TEXT,
    row_count INTEGER,
    processed_at TEXT,
    error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  await db.execute(`CREATE TABLE accessibility_urls (
    id TEXT PRIMARY KEY,
    client_id TEXT,
    csv_upload_id TEXT,
    month TEXT,
    url TEXT,
    hostname TEXT,
    status_code INTEGER,
    content_type TEXT,
    indexability TEXT,
    all_violations INTEGER,
    best_practice_violations INTEGER,
    wcag_20a_violations INTEGER,
    wcag_20aa_violations INTEGER,
    wcag_20aaa_violations INTEGER,
    wcag_21a_violations INTEGER,
    wcag_21aa_violations INTEGER,
    wcag_22a_violations INTEGER,
    wcag_22aa_violations INTEGER,
    raw_json TEXT
  )`);
  await db.execute(`CREATE TABLE keyword_rankings (
    id TEXT PRIMARY KEY,
    client_id TEXT,
    month TEXT,
    keyword TEXT,
    position INTEGER,
    search_volume INTEGER,
    url TEXT,
    change_val INTEGER,
    seo_difficulty INTEGER,
    source TEXT,
    csv_upload_id TEXT
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
  await db.execute(`CREATE UNIQUE INDEX ux_csv_uploads_live
    ON csv_uploads (client_id, month, detected_format, original_name)
    WHERE error IS NULL`);
  return db;
}

function uploadInsertFor(uploadId) {
  return {
    sql: 'INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)',
    args: [uploadId, CLIENT, ACC_FILENAME, 'accessibility', MONTH, 'tester'],
  };
}
function rowCountUpdateFor(uploadId, count) {
  return {
    sql: 'UPDATE csv_uploads SET row_count = ?, processed_at = datetime(\'now\') WHERE id = ?',
    args: [count, uploadId],
  };
}

// Build a coverage statement the way ingestCSV's Class-A branch does: from the
// real coverage-signals helpers fed the real builder's statements.
function coverageStmtFor(uploadId, parserStatements) {
  const category = FORMAT_TO_CATEGORY['accessibility'];
  const { rowsTotal, rowsMeasured, measured } = coverageCountsFromStatements(category, parserStatements);
  return buildCoverageUpsert({ clientId: CLIENT, month: MONTH, category, uploadId, rowsTotal, rowsMeasured, measured });
}

// ── Fixtures (raw CSV). Header carries the columns the builder reads; the
// detector signature (Address + WCAG 2.0 A Violations) is present. ──
const ACC_HEADER = 'Address,Content Type,Status Code,Indexability,All Violations,Best Practice Violations,WCAG 2.0 A Violations,WCAG 2.0 AA Violations,WCAG 2.0 AAA Violations,WCAG 2.1 A Violations,WCAG 2.1 AA Violations,WCAG 2.2 A Violations,WCAG 2.2 AA Violations';

// 5 page rows, every violation column BLANK (the free-SF export shape). Builder
// stores them all NULL -> coverage rows_measured=0, measured=0. Hand count: 5.
const ACC_BLANK = [
  ACC_HEADER,
  'https://f3.example/page1,text/html,200,Indexable,,,,,,,,,',
  'https://f3.example/page2,text/html,200,Indexable,,,,,,,,,',
  'https://f3.example/page3,text/html,200,Indexable,,,,,,,,,',
  'https://f3.example/page4,text/html,200,Indexable,,,,,,,,,',
  'https://f3.example/page5,text/html,200,Indexable,,,,,,,,,',
].join('\n');

// 3 page rows: one with All Violations=3 (measured), one with literal 0
// (measured — 0 is a real value), one fully BLANK (NOT measured). Hand count:
// rows_total=3, rows_measured=2, measured=1.
const ACC_REAL = [
  ACC_HEADER,
  'https://f3.example/p1,text/html,200,Indexable,3,1,2,0,0,0,0,0,0',
  'https://f3.example/p2,text/html,200,Indexable,0,0,0,0,0,0,0,0,0',
  'https://f3.example/p3,text/html,200,Indexable,,,,,,,,,',
].join('\n');

// ── (A1) Class-A accessibility blank fixture: coverage measured=0, committed with the data ──
await test('(A1) Class-A accessibility blank fixture: data_coverage row measured=0, rows_total=5, rows_measured=0, committed atomically with accessibility_urls', async () => {
  const db = await freshDb();
  const uploadId = 'up_acc_blank';
  const parserStatements = buildAccessibilityUrlsStatements(ACC_BLANK, CLIENT, MONTH, uploadId);
  assert.strictEqual(parserStatements.length, 5, 'fixture must produce 5 per-URL rows');

  await runAtomicIngest(db, {
    clearStatements: [],
    uploadInsert: uploadInsertFor(uploadId),
    parserStatements,
    coverageStatement: coverageStmtFor(uploadId, parserStatements),
    rowCountUpdate: rowCountUpdateFor(uploadId, parserStatements.length),
  });

  // Coverage row written with the hand-counted values.
  const cov = await db.execute({
    sql: `SELECT measured, rows_total, rows_measured, source, csv_upload_id FROM data_coverage WHERE client_id = ? AND month = ? AND category = 'accessibility'`,
    args: [CLIENT, MONTH],
  });
  assert.strictEqual(cov.rows.length, 1, 'exactly one accessibility coverage row');
  assert.strictEqual(Number(cov.rows[0].measured), 0, 'blank export -> measured = 0');
  assert.strictEqual(Number(cov.rows[0].rows_total), 5, 'rows_total = 5 (pages seen)');
  assert.strictEqual(Number(cov.rows[0].rows_measured), 0, 'rows_measured = 0 (all blank)');
  assert.strictEqual(cov.rows[0].source, 'csv_upload', 'source literal csv_upload');
  assert.strictEqual(cov.rows[0].csv_upload_id, uploadId, 'coverage FK to the new upload');

  // Data committed in the same tx: 5 accessibility_urls rows for this upload.
  const urls = await db.execute({ sql: `SELECT COUNT(*) AS n FROM accessibility_urls WHERE csv_upload_id = ?`, args: [uploadId] });
  assert.strictEqual(Number(urls.rows[0].n), 5, 'all 5 per-URL rows committed alongside coverage');

  // row_count is parserStatements.length (coverage is not a parser row).
  const up = await db.execute({ sql: `SELECT row_count FROM csv_uploads WHERE id = ?`, args: [uploadId] });
  assert.strictEqual(Number(up.rows[0].row_count), 5, 'row_count = parser row count, coverage not counted');
});

// ── (A2) Class-A accessibility real-values fixture: measured=1, counts real-valued pages ──
await test('(A2) Class-A accessibility real-values fixture (3, 0, blank): measured=1, rows_total=3, rows_measured=2 (literal 0 is measured, blank is not)', async () => {
  const db = await freshDb();
  const uploadId = 'up_acc_real';
  const parserStatements = buildAccessibilityUrlsStatements(ACC_REAL, CLIENT, MONTH, uploadId);
  assert.strictEqual(parserStatements.length, 3, 'fixture must produce 3 per-URL rows');

  await runAtomicIngest(db, {
    clearStatements: [],
    uploadInsert: uploadInsertFor(uploadId),
    parserStatements,
    coverageStatement: coverageStmtFor(uploadId, parserStatements),
    rowCountUpdate: rowCountUpdateFor(uploadId, parserStatements.length),
  });

  const cov = await db.execute({
    sql: `SELECT measured, rows_total, rows_measured FROM data_coverage WHERE client_id = ? AND month = ? AND category = 'accessibility'`,
    args: [CLIENT, MONTH],
  });
  assert.strictEqual(cov.rows.length, 1, 'exactly one accessibility coverage row');
  assert.strictEqual(Number(cov.rows[0].measured), 1, 'real values present -> measured = 1');
  assert.strictEqual(Number(cov.rows[0].rows_total), 3, 'rows_total = 3');
  assert.strictEqual(Number(cov.rows[0].rows_measured), 2, 'rows_measured = 2 (the "3" page and the literal "0" page; blank page excluded)');
});

// ── (A3) Forced parser failure rolls back BOTH data and coverage ──
await test('(A3) FAILURE ROLLBACK: a poisoned parser statement makes the batch throw; NO accessibility_urls rows AND NO coverage row (atomic — never coverage without data)', async () => {
  const db = await freshDb();
  const uploadId = 'up_acc_fail';
  const good = buildAccessibilityUrlsStatements(ACC_BLANK, CLIENT, MONTH, uploadId);
  const coverageStatement = coverageStmtFor(uploadId, good);

  // Poison: duplicate the first per-URL statement's id so the batch hits a
  // UNIQUE(PK) violation AFTER uploadInsert + earlier inserts have executed
  // in-batch — the worst case for atomicity.
  const poisoned = [...good];
  poisoned.push({ sql: good[0].sql, args: [...good[0].args] }); // duplicate PK (args[0] is the id)

  let threw = false;
  try {
    await runAtomicIngest(db, {
      clearStatements: [],
      uploadInsert: uploadInsertFor(uploadId),
      parserStatements: poisoned,
      coverageStatement,
      rowCountUpdate: rowCountUpdateFor(uploadId, poisoned.length),
    });
  } catch {
    threw = true;
  }
  assert.ok(threw, 'the batch MUST throw on the duplicate-PK statement');

  // No upload row, no per-URL rows, no coverage row — full rollback.
  const up = await db.execute({ sql: `SELECT COUNT(*) AS n FROM csv_uploads WHERE id = ?`, args: [uploadId] });
  assert.strictEqual(Number(up.rows[0].n), 0, 'no upload row after rollback');
  const urls = await db.execute({ sql: `SELECT COUNT(*) AS n FROM accessibility_urls WHERE csv_upload_id = ?`, args: [uploadId] });
  assert.strictEqual(Number(urls.rows[0].n), 0, 'no per-URL rows after rollback');
  const cov = await db.execute({ sql: `SELECT COUNT(*) AS n FROM data_coverage WHERE csv_upload_id = ?`, args: [uploadId] });
  assert.strictEqual(Number(cov.rows[0].n), 0, 'no coverage row after rollback (never coverage without data)');
});

// ── (B1) Class-B keywords: file-present, measured=1, counts == inserted rows ──
await test('(B1) Class-B keywords: file-present coverage measured=1, rows_total == rows_measured == inserted count', async () => {
  const db = await freshDb();
  const uploadId = 'up_kw';
  const insertedRows = 12; // hand-chosen: simulate 12 keyword rows inserted by the parser

  // The Class-B branch writes coverage via coverageCountsFilePresent(rowCount)
  // + buildCoverageUpsert + turso.execute, after the upload row exists.
  await db.execute(uploadInsertFor(uploadId)); // FK parent
  const category = FORMAT_TO_CATEGORY['keyword_research'];
  assert.strictEqual(category, 'keywords', 'keyword_research maps to keywords category');
  const { rowsTotal, rowsMeasured, measured } = coverageCountsFilePresent(insertedRows);
  await db.execute(buildCoverageUpsert({ clientId: CLIENT, month: MONTH, category, uploadId, rowsTotal, rowsMeasured, measured }));

  const cov = await db.execute({
    sql: `SELECT measured, rows_total, rows_measured FROM data_coverage WHERE client_id = ? AND month = ? AND category = 'keywords'`,
    args: [CLIENT, MONTH],
  });
  assert.strictEqual(cov.rows.length, 1, 'exactly one keywords coverage row');
  assert.strictEqual(Number(cov.rows[0].measured), 1, 'file provided -> measured = 1');
  assert.strictEqual(Number(cov.rows[0].rows_total), 12, 'rows_total == inserted count');
  assert.strictEqual(Number(cov.rows[0].rows_measured), 12, 'rows_measured == inserted count (file-present)');
});

// ── (B2) Class-B keywords with ZERO data rows still records measured=1 ──
await test('(B2) Class-B keywords with 0 inserted rows still records measured=1 (file provided = measured)', async () => {
  const db = await freshDb();
  const uploadId = 'up_kw_empty';
  await db.execute(uploadInsertFor(uploadId));
  const category = FORMAT_TO_CATEGORY['position_tracking'];
  assert.strictEqual(category, 'keywords', 'position_tracking maps to keywords category');
  const { rowsTotal, rowsMeasured, measured } = coverageCountsFilePresent(0);
  await db.execute(buildCoverageUpsert({ clientId: CLIENT, month: MONTH, category, uploadId, rowsTotal, rowsMeasured, measured }));

  const cov = await db.execute({
    sql: `SELECT measured, rows_total, rows_measured FROM data_coverage WHERE client_id = ? AND month = ? AND category = 'keywords'`,
    args: [CLIENT, MONTH],
  });
  assert.strictEqual(Number(cov.rows[0].measured), 1, '0-row standalone upload still measured = 1');
  assert.strictEqual(Number(cov.rows[0].rows_total), 0, 'rows_total = 0');
  assert.strictEqual(Number(cov.rows[0].rows_measured), 0, 'rows_measured = 0');
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
