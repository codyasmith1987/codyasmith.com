// Parity test for buildStructuredDataUrlsStatements.
//
// Oracle: structured_data_all.csv from src/data/raised-bar-f3-csvs/.
// Row count (5) and spot-check values are derived by reading the
// fixture file directly — not by running old code.
//
// Fixture facts (verified by independent Python read of the CSV):
//   - 5 data rows, all with valid Address, 0 duplicates
//   - Expected inserts: 5
//   - Row 0: url=https://www.f3properties.com/ errors=0 warnings=0
//   - No DELETE in this parser (Class-A; clear is in ingestCSV/clearPreviousData)

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createClient } from '@libsql/client';
import { buildStructuredDataUrlsStatements } from '../src/lib/csv/parsers/structured-data-urls.ts';

let passed = 0, failed = 0;
async function test(n, f) {
  try { await f(); console.log(`[PASS] ${n}`); passed++; }
  catch (e) { console.error(`[FAIL] ${n}: ${e.message}`); failed++; }
}

const FIXTURE = new URL('../src/data/raised-bar-f3-csvs/structured_data_all.csv', import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, '$1');
const raw = readFileSync(FIXTURE, 'utf-8');
const CLIENT_ID = 'test-client';
const MONTH = '2026-05';
const UPLOAD_ID = 'test-upload-structured-data';

const CREATE_TABLE = `
  CREATE TABLE structured_data_urls (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    csv_upload_id TEXT,
    month TEXT NOT NULL,
    url TEXT NOT NULL,
    hostname TEXT NOT NULL,
    error_count INTEGER,
    warning_count INTEGER,
    rich_result_errors INTEGER,
    rich_result_warnings INTEGER,
    total_types INTEGER,
    unique_types INTEGER,
    types_list TEXT,
    rich_result_features TEXT,
    indexability TEXT,
    raw_json TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`;

await test('buildStructuredDataUrlsStatements returns 5 statements for structured_data_all.csv', async () => {
  const stmts = buildStructuredDataUrlsStatements(raw, CLIENT_ID, MONTH, UPLOAD_ID);
  assert.strictEqual(stmts.length, 5, `Expected 5 statements, got ${stmts.length}`);
});

await test('each statement has 16 args (matching the 16 INSERT column positions)', async () => {
  const stmts = buildStructuredDataUrlsStatements(raw, CLIENT_ID, MONTH, UPLOAD_ID);
  for (const s of stmts) {
    assert.strictEqual(s.args.length, 16, `Expected 16 args, got ${s.args.length} for url ${s.args[4]}`);
  }
});

await test('db.batch produces 5 rows in structured_data_urls', async () => {
  const db = createClient({ url: ':memory:' });
  await db.execute(CREATE_TABLE);
  const stmts = buildStructuredDataUrlsStatements(raw, CLIENT_ID, MONTH, UPLOAD_ID);
  for (let i = 0; i < stmts.length; i += 100) {
    await db.batch(stmts.slice(i, i + 100), 'write');
  }
  const count = await db.execute(`SELECT COUNT(*) AS n FROM structured_data_urls`);
  assert.strictEqual(Number(count.rows[0].n), 5, `Expected 5 rows, got ${count.rows[0].n}`);
});

await test('homepage row has error_count=0 and warning_count=0', async () => {
  const db = createClient({ url: ':memory:' });
  await db.execute(CREATE_TABLE);
  const stmts = buildStructuredDataUrlsStatements(raw, CLIENT_ID, MONTH, UPLOAD_ID);
  for (let i = 0; i < stmts.length; i += 100) {
    await db.batch(stmts.slice(i, i + 100), 'write');
  }
  const row = await db.execute(`SELECT error_count, warning_count FROM structured_data_urls WHERE url = 'https://www.f3properties.com/'`);
  assert.ok(row.rows.length > 0, 'Homepage row not found');
  assert.strictEqual(Number(row.rows[0].error_count), 0, `Expected error_count=0, got ${row.rows[0].error_count}`);
  assert.strictEqual(Number(row.rows[0].warning_count), 0, `Expected warning_count=0, got ${row.rows[0].warning_count}`);
});

await test('client_id, upload_id, and month are threaded correctly', async () => {
  const stmts = buildStructuredDataUrlsStatements(raw, CLIENT_ID, MONTH, UPLOAD_ID);
  for (const s of stmts) {
    assert.strictEqual(s.args[1], CLIENT_ID);
    assert.strictEqual(s.args[2], UPLOAD_ID);
    assert.strictEqual(s.args[3], MONTH);
  }
});

await test('empty CSV returns 0 statements without throwing', () => {
  const stmts = buildStructuredDataUrlsStatements('', CLIENT_ID, MONTH, UPLOAD_ID);
  assert.strictEqual(stmts.length, 0);
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
