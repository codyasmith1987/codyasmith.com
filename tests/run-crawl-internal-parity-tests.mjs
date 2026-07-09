// Parity test for buildCrawlInternalStatements.
//
// Oracle: internal_all.csv from src/data/raised-bar-f3-csvs/.
// Row count (94) and spot-check values are derived by reading the
// fixture file directly — not by running old code.
//
// Fixture facts (verified by independent Python read of the CSV):
//   - 94 data rows, all with valid Address, 0 duplicates
//   - Expected inserts: 94
//   - Row 0: url=https://www.f3properties.com/ status_code=200
//            content_type contains 'html' indexability=Indexable
//   - JS asset: url contains 'style.min.js' content_type=application/javascript
//   - No DELETE in this parser (Class-A; clear is in ingestCSV/clearPreviousData)

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createClient } from '@libsql/client';
import { buildCrawlInternalStatements } from '../src/lib/csv/parsers/crawl-internal.ts';

let passed = 0, failed = 0;
async function test(n, f) {
  try { await f(); console.log(`[PASS] ${n}`); passed++; }
  catch (e) { console.error(`[FAIL] ${n}: ${e.message}`); failed++; }
}

const FIXTURE = new URL('../src/data/raised-bar-f3-csvs/internal_all.csv', import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, '$1'); // strip leading / on Windows paths
const raw = readFileSync(FIXTURE, 'utf-8');
const CLIENT_ID = 'test-client';
const MONTH = '2026-05';
const UPLOAD_ID = 'test-upload-1';

await test('buildCrawlInternalStatements returns 94 statements for internal_all.csv', async () => {
  const stmts = buildCrawlInternalStatements(raw, CLIENT_ID, MONTH, UPLOAD_ID);
  assert.strictEqual(stmts.length, 94, `Expected 94 statements, got ${stmts.length}`);
});

await test('all statements have the same sql string', async () => {
  const stmts = buildCrawlInternalStatements(raw, CLIENT_ID, MONTH, UPLOAD_ID);
  const firstSql = stmts[0].sql;
  for (const s of stmts) {
    assert.strictEqual(s.sql, firstSql);
  }
});

await test('each statement has 25 args (matching the 25 INSERT column positions)', async () => {
  const stmts = buildCrawlInternalStatements(raw, CLIENT_ID, MONTH, UPLOAD_ID);
  for (const s of stmts) {
    assert.strictEqual(s.args.length, 25, `Expected 25 args, got ${s.args.length} for url ${s.args[4]}`);
  }
});

await test('db.batch produces 94 rows in crawl_urls with correct spot-check values', async () => {
  const db = createClient({ url: ':memory:' });
  await db.execute(`
    CREATE TABLE crawl_urls (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      csv_upload_id TEXT,
      month TEXT NOT NULL,
      url TEXT NOT NULL,
      hostname TEXT NOT NULL,
      status_code INTEGER,
      content_type TEXT,
      indexability TEXT,
      indexability_status TEXT,
      title TEXT,
      title_length INTEGER,
      meta_description TEXT,
      meta_description_length INTEGER,
      h1 TEXT,
      h2 TEXT,
      word_count INTEGER,
      crawl_depth INTEGER,
      inlinks_count INTEGER,
      outlinks_count INTEGER,
      canonical_url TEXT,
      response_time_ms INTEGER,
      size_bytes INTEGER,
      last_modified TEXT,
      raw_json TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  const stmts = buildCrawlInternalStatements(raw, CLIENT_ID, MONTH, UPLOAD_ID);
  for (let i = 0; i < stmts.length; i += 100) {
    await db.batch(stmts.slice(i, i + 100), 'write');
  }
  const count = await db.execute(`SELECT COUNT(*) AS n FROM crawl_urls`);
  assert.strictEqual(Number(count.rows[0].n), 94, `Expected 94 rows in crawl_urls, got ${count.rows[0].n}`);
});

await test('homepage row has status_code=200 and html content_type', async () => {
  const db = createClient({ url: ':memory:' });
  await db.execute(`
    CREATE TABLE crawl_urls (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, csv_upload_id TEXT,
      month TEXT NOT NULL, url TEXT NOT NULL, hostname TEXT NOT NULL,
      status_code INTEGER, content_type TEXT, indexability TEXT,
      indexability_status TEXT, title TEXT, title_length INTEGER,
      meta_description TEXT, meta_description_length INTEGER,
      h1 TEXT, h2 TEXT, word_count INTEGER, crawl_depth INTEGER,
      inlinks_count INTEGER, outlinks_count INTEGER, canonical_url TEXT,
      response_time_ms INTEGER, size_bytes INTEGER, last_modified TEXT,
      raw_json TEXT, created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  const stmts = buildCrawlInternalStatements(raw, CLIENT_ID, MONTH, UPLOAD_ID);
  for (let i = 0; i < stmts.length; i += 100) {
    await db.batch(stmts.slice(i, i + 100), 'write');
  }
  const row = await db.execute(`SELECT status_code, content_type, indexability FROM crawl_urls WHERE url = 'https://www.f3properties.com/'`);
  assert.ok(row.rows.length > 0, 'Homepage row not found');
  assert.strictEqual(Number(row.rows[0].status_code), 200, `Expected status_code=200, got ${row.rows[0].status_code}`);
  assert.ok(String(row.rows[0].content_type).includes('html'), `Expected html in content_type, got ${row.rows[0].content_type}`);
  assert.strictEqual(String(row.rows[0].indexability), 'Indexable', `Expected indexability=Indexable, got ${row.rows[0].indexability}`);
});

await test('JS asset row has content_type=application/javascript', async () => {
  const db = createClient({ url: ':memory:' });
  await db.execute(`
    CREATE TABLE crawl_urls (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, csv_upload_id TEXT,
      month TEXT NOT NULL, url TEXT NOT NULL, hostname TEXT NOT NULL,
      status_code INTEGER, content_type TEXT, indexability TEXT,
      indexability_status TEXT, title TEXT, title_length INTEGER,
      meta_description TEXT, meta_description_length INTEGER,
      h1 TEXT, h2 TEXT, word_count INTEGER, crawl_depth INTEGER,
      inlinks_count INTEGER, outlinks_count INTEGER, canonical_url TEXT,
      response_time_ms INTEGER, size_bytes INTEGER, last_modified TEXT,
      raw_json TEXT, created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  const stmts = buildCrawlInternalStatements(raw, CLIENT_ID, MONTH, UPLOAD_ID);
  for (let i = 0; i < stmts.length; i += 100) {
    await db.batch(stmts.slice(i, i + 100), 'write');
  }
  const jsUrl = 'https://www.f3properties.com/wp-content/themes/astra/assets/js/minified/style.min.js?ver=4.13.1';
  const row = await db.execute(`SELECT content_type FROM crawl_urls WHERE url = '${jsUrl}'`);
  assert.ok(row.rows.length > 0, `JS asset row not found for url: ${jsUrl}`);
  assert.strictEqual(String(row.rows[0].content_type), 'application/javascript', `Expected application/javascript, got ${row.rows[0].content_type}`);
});

await test('client_id, upload_id, and month are threaded correctly', async () => {
  const stmts = buildCrawlInternalStatements(raw, CLIENT_ID, MONTH, UPLOAD_ID);
  // args: [id, clientId, uploadId, month, url, ...]
  for (const s of stmts) {
    assert.strictEqual(s.args[1], CLIENT_ID);
    assert.strictEqual(s.args[2], UPLOAD_ID);
    assert.strictEqual(s.args[3], MONTH);
  }
});

await test('empty CSV returns 0 statements without throwing', () => {
  const stmts = buildCrawlInternalStatements('', CLIENT_ID, MONTH, UPLOAD_ID);
  assert.strictEqual(stmts.length, 0);
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
