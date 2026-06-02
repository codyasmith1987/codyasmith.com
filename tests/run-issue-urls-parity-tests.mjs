// Issue-URLs parser parity tests.
// Oracle: hand-built CSV strings whose expected values are known because
// we wrote the input — not derived from the old parser.
//
// Tests parseIssueUrlsWithDb against an in-memory libsql client, threading
// a db param through the parse path (same pattern as gsc.ts Task 3).
//
// Covers:
//   1. Known filename maps to correct issue_name and writes all rows.
//   2. URL column mapped correctly from Address field.
//   3. extras JSON captured for non-Address columns.
//   4. Unknown filename returns 0 (no DB write).
//   5. issue_name dedup: re-uploading same (client, month, issue) replaces rows.

import assert from 'node:assert';
import { createClient } from '@libsql/client';
import { parseIssueUrlsWithDb } from '../src/lib/csv/parsers/issue-urls.ts';

let passed = 0, failed = 0;
async function test(n, f) {
  try {
    await f();
    console.log(`[PASS] ${n}`);
    passed++;
  } catch (e) {
    console.error(`[FAIL] ${n}: ${e.message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// In-memory DB setup helper — creates site_issue_urls table each call.
// ---------------------------------------------------------------------------
async function makeDb() {
  const db = createClient({ url: 'file::memory:' });
  await db.execute(`
    CREATE TABLE IF NOT EXISTS site_issue_urls (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      csv_upload_id TEXT,
      month TEXT NOT NULL,
      issue_name TEXT NOT NULL,
      url TEXT NOT NULL,
      extras TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  return db;
}

// ---------------------------------------------------------------------------
// Hand-built h1_missing CSV — 3 data rows with extras columns.
// Header: Address, Occurrences, H1-1, H1-1 Length, Indexability, Indexability Status
// ---------------------------------------------------------------------------
const H1_MISSING_CSV = [
  'Address,Occurrences,H1-1,H1-1 Length,Indexability,Indexability Status',
  'https://example.com/page-a/,0,,0,Indexable,',
  'https://example.com/page-b/,0,,0,Indexable,',
  'https://example.com/page-c/,0,,0,Non-Indexable,Noindex',
].join('\n');

// ---------------------------------------------------------------------------
// Test 1: 3 rows written, issue_name = 'H1: Missing' (from h1_missing.csv map).
// ---------------------------------------------------------------------------
await test('parseIssueUrlsWithDb: writes 3 rows for h1_missing.csv', async () => {
  const db = await makeDb();
  const count = await parseIssueUrlsWithDb(H1_MISSING_CSV, 'cli1', '2024-05', 'upl1', 'h1_missing.csv', db);
  assert.strictEqual(count, 3, `Expected 3 rows inserted, got ${count}`);
  const out = await db.execute(`SELECT COUNT(*) AS n FROM site_issue_urls`);
  assert.strictEqual(Number(out.rows[0].n), 3, `DB row count: expected 3`);
});

// ---------------------------------------------------------------------------
// Test 2: issue_name resolves correctly and url column maps from Address.
// ---------------------------------------------------------------------------
await test('parseIssueUrlsWithDb: issue_name and url are correct', async () => {
  const db = await makeDb();
  await parseIssueUrlsWithDb(H1_MISSING_CSV, 'cli1', '2024-05', 'upl1', 'h1_missing.csv', db);
  const out = await db.execute(
    `SELECT issue_name, url FROM site_issue_urls WHERE url = 'https://example.com/page-a/'`
  );
  assert.strictEqual(out.rows.length, 1);
  assert.strictEqual(out.rows[0].issue_name, 'H1: Missing');
  assert.strictEqual(out.rows[0].url, 'https://example.com/page-a/');
});

// ---------------------------------------------------------------------------
// Test 3: extras JSON captures non-Address columns (Occurrences, Indexability).
// ---------------------------------------------------------------------------
await test('parseIssueUrlsWithDb: extras JSON captures non-Address columns', async () => {
  const db = await makeDb();
  await parseIssueUrlsWithDb(H1_MISSING_CSV, 'cli1', '2024-05', 'upl1', 'h1_missing.csv', db);
  const out = await db.execute(
    `SELECT extras FROM site_issue_urls WHERE url = 'https://example.com/page-c/'`
  );
  assert.strictEqual(out.rows.length, 1);
  const extras = JSON.parse(out.rows[0].extras);
  assert.strictEqual(extras['Indexability Status'], 'Noindex');
});

// ---------------------------------------------------------------------------
// Test 4: unknown filename returns 0 and writes nothing.
// ---------------------------------------------------------------------------
await test('parseIssueUrlsWithDb: unknown filename returns 0 and writes no rows', async () => {
  const db = await makeDb();
  const count = await parseIssueUrlsWithDb(H1_MISSING_CSV, 'cli1', '2024-05', 'upl1', 'unknown_file.csv', db);
  assert.strictEqual(count, 0, `Expected 0 for unknown filename, got ${count}`);
  const out = await db.execute(`SELECT COUNT(*) AS n FROM site_issue_urls`);
  assert.strictEqual(Number(out.rows[0].n), 0, `DB should be empty for unknown filename`);
});

// ---------------------------------------------------------------------------
// Test 5: issue_name dedup — re-upload same (client, month, issue) replaces rows.
// First upload: 3 rows for h1_missing.
// Second upload: 1 row for h1_missing.
// Expected: 1 row total.
// ---------------------------------------------------------------------------
await test('parseIssueUrlsWithDb: re-upload same issue replaces prior rows', async () => {
  const db = await makeDb();
  await parseIssueUrlsWithDb(H1_MISSING_CSV, 'cli1', '2024-05', 'upl1', 'h1_missing.csv', db);
  const after1 = await db.execute(`SELECT COUNT(*) AS n FROM site_issue_urls`);
  assert.strictEqual(Number(after1.rows[0].n), 3, `First upload: expected 3`);

  const H1_MISSING_SECOND = [
    'Address,Occurrences,H1-1,H1-1 Length,Indexability,Indexability Status',
    'https://example.com/replaced-page/,0,,0,Indexable,',
  ].join('\n');
  await parseIssueUrlsWithDb(H1_MISSING_SECOND, 'cli1', '2024-05', 'upl2', 'h1_missing.csv', db);
  const after2 = await db.execute(`SELECT COUNT(*) AS n FROM site_issue_urls`);
  assert.strictEqual(Number(after2.rows[0].n), 1, `After re-upload: expected 1 (old rows replaced)`);
  const row = await db.execute(`SELECT url FROM site_issue_urls`);
  assert.strictEqual(row.rows[0].url, 'https://example.com/replaced-page/');
});

// ---------------------------------------------------------------------------
// Test 6: different issue files coexist (no cross-issue dedup).
// Upload h1_missing (3 rows) then page_titles_missing (2 rows).
// Expected: 5 rows total.
// ---------------------------------------------------------------------------
await test('parseIssueUrlsWithDb: different issues coexist without cross-dedup', async () => {
  const db = await makeDb();
  await parseIssueUrlsWithDb(H1_MISSING_CSV, 'cli1', '2024-05', 'upl1', 'h1_missing.csv', db);
  const TITLES_CSV = [
    'Address,Occurrences',
    'https://example.com/title-a/,0',
    'https://example.com/title-b/,0',
  ].join('\n');
  await parseIssueUrlsWithDb(TITLES_CSV, 'cli1', '2024-05', 'upl2', 'page_titles_missing.csv', db);
  const out = await db.execute(`SELECT COUNT(*) AS n FROM site_issue_urls`);
  assert.strictEqual(Number(out.rows[0].n), 5, `Expected 5 (3 h1_missing + 2 page_titles_missing)`);
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
