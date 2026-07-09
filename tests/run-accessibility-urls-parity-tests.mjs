// Parity test for buildAccessibilityUrlsStatements.
//
// Oracle: accessibility_all.csv from src/data/raised-bar-f3-csvs/.
// Row count (5) and spot-check values are derived by reading the
// fixture file directly — not by running old code.
//
// Fixture facts (verified by independent Python read of the CSV):
//   - 5 data rows: homepage + /projects/ + /contact/ + /history/ + /about/
//   - All 5 have valid Address, 0 duplicates
//   - Expected inserts: 5
//   - F3's accessibility_all has no WCAG 2.1 A column (only up to 2.2 AA)
//   - The fixture has All Violations column but the cells are empty strings
//     (SF emits empty when the PSI request status is missing / incomplete)
//     — the parser stores null for those, which is correct behavior
//   - No DELETE in this parser (Class-A; clear is in ingestCSV/clearPreviousData)

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createClient } from '@libsql/client';
import { buildAccessibilityUrlsStatements } from '../src/lib/csv/parsers/accessibility-urls.ts';

let passed = 0, failed = 0;
async function test(n, f) {
  try { await f(); console.log(`[PASS] ${n}`); passed++; }
  catch (e) { console.error(`[FAIL] ${n}: ${e.message}`); failed++; }
}

const FIXTURE = new URL('../src/data/raised-bar-f3-csvs/accessibility_all.csv', import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, '$1');
const raw = readFileSync(FIXTURE, 'utf-8');
const CLIENT_ID = 'test-client';
const MONTH = '2026-05';
const UPLOAD_ID = 'test-upload-accessibility';

const CREATE_TABLE = `
  CREATE TABLE accessibility_urls (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    csv_upload_id TEXT,
    month TEXT NOT NULL,
    url TEXT NOT NULL,
    hostname TEXT NOT NULL,
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
    raw_json TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`;

await test('buildAccessibilityUrlsStatements returns 5 statements for accessibility_all.csv', async () => {
  const stmts = buildAccessibilityUrlsStatements(raw, CLIENT_ID, MONTH, UPLOAD_ID);
  assert.strictEqual(stmts.length, 5, `Expected 5 statements, got ${stmts.length}`);
});

await test('each statement has 19 args (matching the 19 INSERT column positions)', async () => {
  const stmts = buildAccessibilityUrlsStatements(raw, CLIENT_ID, MONTH, UPLOAD_ID);
  for (const s of stmts) {
    assert.strictEqual(s.args.length, 19, `Expected 19 args, got ${s.args.length} for url ${s.args[4]}`);
  }
});

await test('db.batch produces 5 rows in accessibility_urls', async () => {
  const db = createClient({ url: ':memory:' });
  await db.execute(CREATE_TABLE);
  const stmts = buildAccessibilityUrlsStatements(raw, CLIENT_ID, MONTH, UPLOAD_ID);
  for (let i = 0; i < stmts.length; i += 100) {
    await db.batch(stmts.slice(i, i + 100), 'write');
  }
  const count = await db.execute(`SELECT COUNT(*) AS n FROM accessibility_urls`);
  assert.strictEqual(Number(count.rows[0].n), 5, `Expected 5 rows, got ${count.rows[0].n}`);
});

await test('all 5 known F3 URLs are present', async () => {
  const db = createClient({ url: ':memory:' });
  await db.execute(CREATE_TABLE);
  const stmts = buildAccessibilityUrlsStatements(raw, CLIENT_ID, MONTH, UPLOAD_ID);
  for (let i = 0; i < stmts.length; i += 100) {
    await db.batch(stmts.slice(i, i + 100), 'write');
  }
  const urls = [
    'https://www.f3properties.com/',
    'https://www.f3properties.com/projects/',
    'https://www.f3properties.com/contact/',
    'https://www.f3properties.com/history/',
    'https://www.f3properties.com/about/',
  ];
  for (const url of urls) {
    const row = await db.execute(`SELECT id FROM accessibility_urls WHERE url = '${url}'`);
    assert.ok(row.rows.length > 0, `Expected URL not found: ${url}`);
  }
});

await test('client_id, upload_id, and month are threaded correctly', async () => {
  const stmts = buildAccessibilityUrlsStatements(raw, CLIENT_ID, MONTH, UPLOAD_ID);
  for (const s of stmts) {
    assert.strictEqual(s.args[1], CLIENT_ID);
    assert.strictEqual(s.args[2], UPLOAD_ID);
    assert.strictEqual(s.args[3], MONTH);
  }
});

await test('empty CSV returns 0 statements without throwing', () => {
  const stmts = buildAccessibilityUrlsStatements('', CLIENT_ID, MONTH, UPLOAD_ID);
  assert.strictEqual(stmts.length, 0);
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
