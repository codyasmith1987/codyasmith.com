// Parity test for buildPageWeightUrlsStatements.
//
// Oracle: an inline CSV built from the REAL validation_all.csv header
// captured in docs/superpowers/plans/2026-06-02-unique-data-parsers.md.
// All expected values are hand-reasoned from the fixture, never from
// old-code output.
//
// Real header:
//   Address, Content Type, Status Code, Status, Indexability,
//   Indexability Status, Size (Bytes), Transferred (Bytes),
//   Total Transferred (Bytes), CO2 (mg), Carbon Rating
//
// Fixture rows (hand-reasoned truth):
//   1. https://zipkithomes.com/       status=200 size=123,456 co2=0.42  carbon='A+'
//      (Size has a thousands comma -> safeInt strips it -> 123456)
//   2. https://zipkithomes.com/blog   status=200 size=BLANK (-> null)  co2=BLANK (-> null)
//   3. HTTPS://ZIPKITHOMES.COM/  (dup of row 1 -> skipped)
//   4. (blank Address -> skipped)
// Expected inserts: 2 unique urls (rows 1,2).

import assert from 'node:assert';
import { createClient } from '@libsql/client';
import { buildPageWeightUrlsStatements } from '../src/lib/csv/parsers/page-weight-urls.ts';

let passed = 0, failed = 0;
async function test(n, f) {
  try { await f(); console.log(`[PASS] ${n}`); passed++; }
  catch (e) { console.error(`[FAIL] ${n}: ${e.message}`); failed++; }
}

const CLIENT_ID = 'test-client';
const MONTH = '2026-06';
const UPLOAD_ID = 'test-upload-page-weight';

const RAW =
  'Address,Content Type,Status Code,Status,Indexability,Indexability Status,Size (Bytes),Transferred (Bytes),Total Transferred (Bytes),CO2 (mg),Carbon Rating\n' +
  'https://zipkithomes.com/,text/html,200,OK,Indexable,,"123,456",98765,150000,0.42,A+\n' +
  'https://zipkithomes.com/blog,text/html,200,OK,Indexable,,,,,,\n' +
  'HTTPS://ZIPKITHOMES.COM/,text/html,200,OK,Indexable,,999,999,999,9.99,F\n' +
  ',text/html,0,,Non-Indexable,No URL,,,,,\n';

const CREATE_TABLE = `
  CREATE TABLE page_weight_urls (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    csv_upload_id TEXT,
    month TEXT NOT NULL,
    url TEXT NOT NULL,
    hostname TEXT NOT NULL,
    content_type TEXT,
    status_code INTEGER,
    indexability TEXT,
    size_bytes INTEGER,
    transferred_bytes INTEGER,
    total_transferred_bytes INTEGER,
    co2_mg REAL,
    carbon_rating TEXT,
    raw_json TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`;

await test('returns 2 statements (4 rows: 1 blank-address dropped, 1 dup dropped)', async () => {
  const stmts = buildPageWeightUrlsStatements(RAW, CLIENT_ID, MONTH, UPLOAD_ID);
  assert.strictEqual(stmts.length, 2, `Expected 2 statements, got ${stmts.length}`);
});

await test('each statement has 15 args (matching the 15 INSERT column positions)', async () => {
  const stmts = buildPageWeightUrlsStatements(RAW, CLIENT_ID, MONTH, UPLOAD_ID);
  for (const s of stmts) {
    assert.strictEqual(s.args.length, 15, `Expected 15 args, got ${s.args.length} for url ${s.args[4]}`);
  }
});

await test('db.batch produces 2 rows in page_weight_urls', async () => {
  const db = createClient({ url: ':memory:' });
  await db.execute(CREATE_TABLE);
  await db.batch(buildPageWeightUrlsStatements(RAW, CLIENT_ID, MONTH, UPLOAD_ID), 'write');
  const count = await db.execute(`SELECT COUNT(*) AS n FROM page_weight_urls`);
  assert.strictEqual(Number(count.rows[0].n), 2, `Expected 2 rows, got ${count.rows[0].n}`);
});

await test('size_bytes/status_code coerce to INT (comma stripped); co2_mg coerces to FLOAT', async () => {
  const db = createClient({ url: ':memory:' });
  await db.execute(CREATE_TABLE);
  await db.batch(buildPageWeightUrlsStatements(RAW, CLIENT_ID, MONTH, UPLOAD_ID), 'write');
  const row = await db.execute(`SELECT status_code, size_bytes, total_transferred_bytes, co2_mg, carbon_rating, hostname FROM page_weight_urls WHERE url = 'https://zipkithomes.com/'`);
  assert.ok(row.rows.length > 0, 'home row not found');
  assert.strictEqual(Number(row.rows[0].status_code), 200, `Expected status_code=200, got ${row.rows[0].status_code}`);
  assert.strictEqual(Number(row.rows[0].size_bytes), 123456, `Expected size_bytes=123456 (comma stripped), got ${row.rows[0].size_bytes}`);
  assert.strictEqual(Number(row.rows[0].total_transferred_bytes), 150000, `Expected total_transferred_bytes=150000, got ${row.rows[0].total_transferred_bytes}`);
  assert.strictEqual(Number(row.rows[0].co2_mg), 0.42, `Expected co2_mg=0.42, got ${row.rows[0].co2_mg}`);
  assert.strictEqual(String(row.rows[0].carbon_rating), 'A+', `Expected carbon_rating=A+, got ${row.rows[0].carbon_rating}`);
  assert.strictEqual(String(row.rows[0].hostname), 'zipkithomes.com', `Expected hostname=zipkithomes.com, got ${row.rows[0].hostname}`);
});

await test('blank Size (Bytes) and blank CO2 (mg) become null (not 0)', async () => {
  const db = createClient({ url: ':memory:' });
  await db.execute(CREATE_TABLE);
  await db.batch(buildPageWeightUrlsStatements(RAW, CLIENT_ID, MONTH, UPLOAD_ID), 'write');
  const row = await db.execute(`SELECT size_bytes, co2_mg FROM page_weight_urls WHERE url = 'https://zipkithomes.com/blog'`);
  assert.strictEqual(row.rows[0].size_bytes, null, `Expected size_bytes=null, got ${row.rows[0].size_bytes}`);
  assert.strictEqual(row.rows[0].co2_mg, null, `Expected co2_mg=null, got ${row.rows[0].co2_mg}`);
});

await test('dedup by lowercased url keeps the first occurrence', async () => {
  const db = createClient({ url: ':memory:' });
  await db.execute(CREATE_TABLE);
  await db.batch(buildPageWeightUrlsStatements(RAW, CLIENT_ID, MONTH, UPLOAD_ID), 'write');
  const row = await db.execute(`SELECT co2_mg FROM page_weight_urls WHERE lower(url) = 'https://zipkithomes.com/'`);
  assert.strictEqual(row.rows.length, 1, `Expected 1 homepage row, got ${row.rows.length}`);
  assert.strictEqual(Number(row.rows[0].co2_mg), 0.42, `Expected first row (co2=0.42) to win, got ${row.rows[0].co2_mg}`);
});

await test('client_id, upload_id, and month are threaded correctly', async () => {
  const stmts = buildPageWeightUrlsStatements(RAW, CLIENT_ID, MONTH, UPLOAD_ID);
  for (const s of stmts) {
    assert.strictEqual(s.args[1], CLIENT_ID);
    assert.strictEqual(s.args[2], UPLOAD_ID);
    assert.strictEqual(s.args[3], MONTH);
  }
});

await test('empty CSV returns 0 statements without throwing', () => {
  const stmts = buildPageWeightUrlsStatements('', CLIENT_ID, MONTH, UPLOAD_ID);
  assert.strictEqual(stmts.length, 0);
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
