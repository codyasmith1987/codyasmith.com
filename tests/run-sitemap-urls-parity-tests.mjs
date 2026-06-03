// Parity test for buildSitemapUrlsStatements.
//
// Oracle: an inline CSV built from the REAL sitemaps_all.csv header
// captured in docs/superpowers/plans/2026-06-02-unique-data-parsers.md.
// All expected values are hand-reasoned from the fixture, never from
// old-code output. (The header is generic; the file is detected by the
// sitemaps_all.csv filename rule, but the BUILDER itself only needs the
// header columns it reads.)
//
// Real header:
//   Address, Content Type, Status Code, Status, Indexability,
//   Indexability Status
//
// Fixture rows (hand-reasoned truth):
//   1. https://zipkithomes.com/        status_code=200 status='OK'
//   2. https://zipkithomes.com/blog    status_code=BLANK (-> null)
//   3. HTTPS://ZIPKITHOMES.COM/   (dup of row 1 -> skipped)
//   4. (blank Address -> skipped)
// Expected inserts: 2 unique urls (rows 1,2).
//
// Note: the parser reads the exact "Status" column (findIdx is an exact
// match), distinct from "Status Code" — the test asserts both land in
// the right columns.

import assert from 'node:assert';
import { createClient } from '@libsql/client';
import { buildSitemapUrlsStatements } from '../src/lib/csv/parsers/sitemap-urls.ts';

let passed = 0, failed = 0;
async function test(n, f) {
  try { await f(); console.log(`[PASS] ${n}`); passed++; }
  catch (e) { console.error(`[FAIL] ${n}: ${e.message}`); failed++; }
}

const CLIENT_ID = 'test-client';
const MONTH = '2026-06';
const UPLOAD_ID = 'test-upload-sitemap';

const RAW =
  'Address,Content Type,Status Code,Status,Indexability,Indexability Status\n' +
  'https://zipkithomes.com/,text/html,200,OK,Indexable,\n' +
  'https://zipkithomes.com/blog,text/html,,,Indexable,\n' +
  'HTTPS://ZIPKITHOMES.COM/,text/html,404,Not Found,Non-Indexable,Client Error\n' +
  ',text/html,200,OK,Non-Indexable,No URL\n';

const CREATE_TABLE = `
  CREATE TABLE sitemap_urls (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    csv_upload_id TEXT,
    month TEXT NOT NULL,
    url TEXT NOT NULL,
    hostname TEXT NOT NULL,
    content_type TEXT,
    status_code INTEGER,
    status TEXT,
    indexability TEXT,
    indexability_status TEXT,
    raw_json TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`;

await test('returns 2 statements (4 rows: 1 blank-address dropped, 1 dup dropped)', async () => {
  const stmts = buildSitemapUrlsStatements(RAW, CLIENT_ID, MONTH, UPLOAD_ID);
  assert.strictEqual(stmts.length, 2, `Expected 2 statements, got ${stmts.length}`);
});

await test('each statement has 12 args (matching the 12 INSERT column positions)', async () => {
  const stmts = buildSitemapUrlsStatements(RAW, CLIENT_ID, MONTH, UPLOAD_ID);
  for (const s of stmts) {
    assert.strictEqual(s.args.length, 12, `Expected 12 args, got ${s.args.length} for url ${s.args[4]}`);
  }
});

await test('db.batch produces 2 rows in sitemap_urls', async () => {
  const db = createClient({ url: ':memory:' });
  await db.execute(CREATE_TABLE);
  await db.batch(buildSitemapUrlsStatements(RAW, CLIENT_ID, MONTH, UPLOAD_ID), 'write');
  const count = await db.execute(`SELECT COUNT(*) AS n FROM sitemap_urls`);
  assert.strictEqual(Number(count.rows[0].n), 2, `Expected 2 rows, got ${count.rows[0].n}`);
});

await test('status_code coerces to INT; Status text + hostname in the right columns', async () => {
  const db = createClient({ url: ':memory:' });
  await db.execute(CREATE_TABLE);
  await db.batch(buildSitemapUrlsStatements(RAW, CLIENT_ID, MONTH, UPLOAD_ID), 'write');
  const row = await db.execute(`SELECT status_code, status, content_type, hostname FROM sitemap_urls WHERE url = 'https://zipkithomes.com/'`);
  assert.ok(row.rows.length > 0, 'home row not found');
  assert.strictEqual(Number(row.rows[0].status_code), 200, `Expected status_code=200, got ${row.rows[0].status_code}`);
  assert.strictEqual(String(row.rows[0].status), 'OK', `Expected status=OK, got ${row.rows[0].status}`);
  assert.strictEqual(String(row.rows[0].content_type), 'text/html', `Expected content_type=text/html, got ${row.rows[0].content_type}`);
  assert.strictEqual(String(row.rows[0].hostname), 'zipkithomes.com', `Expected hostname=zipkithomes.com, got ${row.rows[0].hostname}`);
});

await test('blank Status Code becomes null (not 0)', async () => {
  const db = createClient({ url: ':memory:' });
  await db.execute(CREATE_TABLE);
  await db.batch(buildSitemapUrlsStatements(RAW, CLIENT_ID, MONTH, UPLOAD_ID), 'write');
  const row = await db.execute(`SELECT status_code, status FROM sitemap_urls WHERE url = 'https://zipkithomes.com/blog'`);
  assert.strictEqual(row.rows[0].status_code, null, `Expected status_code=null, got ${row.rows[0].status_code}`);
  assert.strictEqual(row.rows[0].status, null, `Expected status=null, got ${row.rows[0].status}`);
});

await test('dedup by lowercased url keeps the first occurrence', async () => {
  const db = createClient({ url: ':memory:' });
  await db.execute(CREATE_TABLE);
  await db.batch(buildSitemapUrlsStatements(RAW, CLIENT_ID, MONTH, UPLOAD_ID), 'write');
  const row = await db.execute(`SELECT status_code FROM sitemap_urls WHERE lower(url) = 'https://zipkithomes.com/'`);
  assert.strictEqual(row.rows.length, 1, `Expected 1 homepage row, got ${row.rows.length}`);
  assert.strictEqual(Number(row.rows[0].status_code), 200, `Expected first row (status_code=200) to win, got ${row.rows[0].status_code}`);
});

await test('client_id, upload_id, and month are threaded correctly', async () => {
  const stmts = buildSitemapUrlsStatements(RAW, CLIENT_ID, MONTH, UPLOAD_ID);
  for (const s of stmts) {
    assert.strictEqual(s.args[1], CLIENT_ID);
    assert.strictEqual(s.args[2], UPLOAD_ID);
    assert.strictEqual(s.args[3], MONTH);
  }
});

await test('empty CSV returns 0 statements without throwing', () => {
  const stmts = buildSitemapUrlsStatements('', CLIENT_ID, MONTH, UPLOAD_ID);
  assert.strictEqual(stmts.length, 0);
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
