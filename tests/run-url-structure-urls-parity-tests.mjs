// Parity test for buildUrlStructureUrlsStatements.
// Oracle: inline CSV from the REAL url_all.csv header.
import assert from 'node:assert';
import { createClient } from '@libsql/client';
import { buildUrlStructureUrlsStatements } from '../src/lib/csv/parsers/url-structure-urls.ts';

let passed = 0, failed = 0;
async function test(n, f) {
  try { await f(); console.log(`[PASS] ${n}`); passed++; }
  catch (e) { console.error(`[FAIL] ${n}: ${e.message}`); failed++; }
}
const C = 'test-client', M = '2026-06', U = 'up-url';

const RAW =
  'Address,Content Type,Status Code,Status,Indexability,Indexability Status,Hash,Length,Canonical Link Element 1,URL Encoded Address\n' +
  'https://zipkithomes.com/,text/html,200,OK,Indexable,,abc123,28,https://zipkithomes.com/,https%3A%2F%2Fzipkithomes.com%2F\n' +
  'https://zipkithomes.com/b,text/html,200,OK,Indexable,,,,,\n' +
  'HTTPS://ZIPKITHOMES.COM/,text/html,200,OK,Indexable,,dup,99,,\n' +
  ',text/html,200,OK,Indexable,,x,1,,\n';

const CREATE = `CREATE TABLE url_structure_urls (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, csv_upload_id TEXT, month TEXT NOT NULL,
  url TEXT NOT NULL, hostname TEXT NOT NULL, content_type TEXT, status_code INTEGER, status TEXT,
  indexability TEXT, indexability_status TEXT, content_hash TEXT, url_length INTEGER,
  canonical_link_element TEXT, url_encoded_address TEXT, raw_json TEXT, created_at TEXT DEFAULT (datetime('now')))`;

await test('returns 2 statements (4 rows: 1 dup + 1 blank-address dropped)', async () => {
  assert.strictEqual(buildUrlStructureUrlsStatements(RAW, C, M, U).length, 2);
});
await test('each statement has 16 args', async () => {
  for (const s of buildUrlStructureUrlsStatements(RAW, C, M, U)) assert.strictEqual(s.args.length, 16, `got ${s.args.length}`);
});
await test('db.batch: content_hash + url_length(INT) typed', async () => {
  const db = createClient({ url: ':memory:' }); await db.execute(CREATE);
  await db.batch(buildUrlStructureUrlsStatements(RAW, C, M, U), 'write');
  assert.strictEqual(Number((await db.execute('SELECT COUNT(*) AS n FROM url_structure_urls')).rows[0].n), 2);
  const r = (await db.execute(`SELECT content_hash, url_length FROM url_structure_urls WHERE url='https://zipkithomes.com/'`)).rows[0];
  assert.strictEqual(String(r.content_hash), 'abc123');
  assert.strictEqual(Number(r.url_length), 28);
});
await test('blank Hash/Length become null', async () => {
  const db = createClient({ url: ':memory:' }); await db.execute(CREATE);
  await db.batch(buildUrlStructureUrlsStatements(RAW, C, M, U), 'write');
  const r = (await db.execute(`SELECT content_hash, url_length FROM url_structure_urls WHERE url='https://zipkithomes.com/b'`)).rows[0];
  assert.strictEqual(r.content_hash, null);
  assert.strictEqual(r.url_length, null);
});
await test('dedup by lowercased url keeps the first', async () => {
  const db = createClient({ url: ':memory:' }); await db.execute(CREATE);
  await db.batch(buildUrlStructureUrlsStatements(RAW, C, M, U), 'write');
  const r = await db.execute(`SELECT content_hash FROM url_structure_urls WHERE lower(url)='https://zipkithomes.com/'`);
  assert.strictEqual(r.rows.length, 1);
  assert.strictEqual(String(r.rows[0].content_hash), 'abc123');
});
await test('empty CSV -> 0 statements', () => assert.strictEqual(buildUrlStructureUrlsStatements('', C, M, U).length, 0));

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
