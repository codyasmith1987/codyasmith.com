// Parity test for buildSecurityUrlsStatements.
//
// Oracle: security_all.csv from src/data/raised-bar-f3-csvs/.
// Row count (94) and spot-check values are derived by reading the
// fixture file directly — not by running old code.
//
// Fixture facts (verified by independent Python read of the CSV):
//   - 94 data rows, all with valid Address, 0 duplicates
//   - Expected inserts: 94
//   - Row 0: url=https://www.f3properties.com/ http_version=1.1 status_code=200
//   - All https URLs: is_https=1
//   - No DELETE in this parser (Class-A; clear is in ingestCSV/clearPreviousData)

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createClient } from '@libsql/client';
import { buildSecurityUrlsStatements } from '../src/lib/csv/parsers/security-urls.ts';

let passed = 0, failed = 0;
async function test(n, f) {
  try { await f(); console.log(`[PASS] ${n}`); passed++; }
  catch (e) { console.error(`[FAIL] ${n}: ${e.message}`); failed++; }
}

const FIXTURE = new URL('../src/data/raised-bar-f3-csvs/security_all.csv', import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, '$1');
const raw = readFileSync(FIXTURE, 'utf-8');
const CLIENT_ID = 'test-client';
const MONTH = '2026-05';
const UPLOAD_ID = 'test-upload-security';

const CREATE_TABLE = `
  CREATE TABLE security_urls (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    csv_upload_id TEXT,
    month TEXT NOT NULL,
    url TEXT NOT NULL,
    hostname TEXT NOT NULL,
    status_code INTEGER,
    http_version TEXT,
    content_type TEXT,
    indexability TEXT,
    is_https INTEGER,
    has_hsts INTEGER,
    has_csp INTEGER,
    has_x_content_type_options INTEGER,
    has_x_frame_options INTEGER,
    has_referrer_policy INTEGER,
    meta_robots TEXT,
    x_robots_tag TEXT,
    canonical_link TEXT,
    raw_json TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`;

await test('buildSecurityUrlsStatements returns 94 statements for security_all.csv', async () => {
  const stmts = buildSecurityUrlsStatements(raw, CLIENT_ID, MONTH, UPLOAD_ID);
  assert.strictEqual(stmts.length, 94, `Expected 94 statements, got ${stmts.length}`);
});

await test('each statement has 20 args (matching the 20 INSERT column positions)', async () => {
  const stmts = buildSecurityUrlsStatements(raw, CLIENT_ID, MONTH, UPLOAD_ID);
  for (const s of stmts) {
    assert.strictEqual(s.args.length, 20, `Expected 20 args, got ${s.args.length} for url ${s.args[4]}`);
  }
});

await test('db.batch produces 94 rows in security_urls', async () => {
  const db = createClient({ url: ':memory:' });
  await db.execute(CREATE_TABLE);
  const stmts = buildSecurityUrlsStatements(raw, CLIENT_ID, MONTH, UPLOAD_ID);
  for (let i = 0; i < stmts.length; i += 100) {
    await db.batch(stmts.slice(i, i + 100), 'write');
  }
  const count = await db.execute(`SELECT COUNT(*) AS n FROM security_urls`);
  assert.strictEqual(Number(count.rows[0].n), 94, `Expected 94 rows, got ${count.rows[0].n}`);
});

await test('homepage row has status_code=200 and http_version=1.1', async () => {
  const db = createClient({ url: ':memory:' });
  await db.execute(CREATE_TABLE);
  const stmts = buildSecurityUrlsStatements(raw, CLIENT_ID, MONTH, UPLOAD_ID);
  for (let i = 0; i < stmts.length; i += 100) {
    await db.batch(stmts.slice(i, i + 100), 'write');
  }
  const row = await db.execute(`SELECT status_code, http_version, is_https FROM security_urls WHERE url = 'https://www.f3properties.com/'`);
  assert.ok(row.rows.length > 0, 'Homepage row not found');
  assert.strictEqual(Number(row.rows[0].status_code), 200, `Expected status_code=200, got ${row.rows[0].status_code}`);
  assert.strictEqual(String(row.rows[0].http_version), '1.1', `Expected http_version=1.1, got ${row.rows[0].http_version}`);
  assert.strictEqual(Number(row.rows[0].is_https), 1, `Expected is_https=1 for https URL, got ${row.rows[0].is_https}`);
});

await test('all rows have is_https=1 (all f3 URLs are https)', async () => {
  const db = createClient({ url: ':memory:' });
  await db.execute(CREATE_TABLE);
  const stmts = buildSecurityUrlsStatements(raw, CLIENT_ID, MONTH, UPLOAD_ID);
  for (let i = 0; i < stmts.length; i += 100) {
    await db.batch(stmts.slice(i, i + 100), 'write');
  }
  const nonHttps = await db.execute(`SELECT COUNT(*) AS n FROM security_urls WHERE is_https != 1`);
  assert.strictEqual(Number(nonHttps.rows[0].n), 0, `Expected 0 non-https rows, got ${nonHttps.rows[0].n}`);
});

await test('client_id, upload_id, and month are threaded correctly', async () => {
  const stmts = buildSecurityUrlsStatements(raw, CLIENT_ID, MONTH, UPLOAD_ID);
  for (const s of stmts) {
    assert.strictEqual(s.args[1], CLIENT_ID);
    assert.strictEqual(s.args[2], UPLOAD_ID);
    assert.strictEqual(s.args[3], MONTH);
  }
});

await test('empty CSV returns 0 statements without throwing', () => {
  const stmts = buildSecurityUrlsStatements('', CLIENT_ID, MONTH, UPLOAD_ID);
  assert.strictEqual(stmts.length, 0);
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
