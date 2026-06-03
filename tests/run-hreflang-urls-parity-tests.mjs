// Parity test for buildHreflangUrlsStatements.
// Oracle: inline CSV from the REAL hreflang_all.csv header, extended with a
// second annotation group to exercise hreflang_count and the raw_json catch-all.
import assert from 'node:assert';
import { createClient } from '@libsql/client';
import { buildHreflangUrlsStatements } from '../src/lib/csv/parsers/hreflang-urls.ts';

let passed = 0, failed = 0;
async function test(n, f) {
  try { await f(); console.log(`[PASS] ${n}`); passed++; }
  catch (e) { console.error(`[FAIL] ${n}: ${e.message}`); failed++; }
}
const C = 'test-client', M = '2026-06', U = 'up-hl';

// Row 1: two annotation groups (en, es) -> hreflang_count=2.
// Row 2: no hreflang values -> hreflang_count=0.
// Row 3: dup of row 1 by lowercased url -> skipped.
const RAW =
  'Address,Title 1,Occurrences,HTML hreflang 1,HTML hreflang 1 URL,HTML hreflang 2,HTML hreflang 2 URL,HTTP hreflang 1,HTTP hreflang 1 URL,Sitemap hreflang 1,Sitemap hreflang 1 URL,Indexability,Indexability Status\n' +
  'https://zipkithomes.com/,Home,1,en,https://zipkithomes.com/,es,https://zipkithomes.com/es/,,,,,Indexable,\n' +
  'https://zipkithomes.com/b,B,1,,,,,,,,,Indexable,\n' +
  'HTTPS://ZIPKITHOMES.COM/,dup,9,fr,https://x/fr,,,,,,,Indexable,\n';

const CREATE = `CREATE TABLE hreflang_urls (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, csv_upload_id TEXT, month TEXT NOT NULL,
  url TEXT NOT NULL, hostname TEXT NOT NULL, title TEXT, occurrences INTEGER, indexability TEXT,
  indexability_status TEXT, hreflang_count INTEGER, html_hreflang_1 TEXT, html_hreflang_1_url TEXT,
  http_hreflang_1 TEXT, http_hreflang_1_url TEXT, sitemap_hreflang_1 TEXT, sitemap_hreflang_1_url TEXT,
  raw_json TEXT, created_at TEXT DEFAULT (datetime('now')))`;

await test('returns 2 statements (3 rows: 1 dup dropped)', async () => {
  assert.strictEqual(buildHreflangUrlsStatements(RAW, C, M, U).length, 2);
});
await test('each statement has 18 args', async () => {
  for (const s of buildHreflangUrlsStatements(RAW, C, M, U)) assert.strictEqual(s.args.length, 18, `got ${s.args.length}`);
});
await test('hreflang_count counts non-empty groups; group 1 typed; group 2 in raw_json', async () => {
  const db = createClient({ url: ':memory:' }); await db.execute(CREATE);
  await db.batch(buildHreflangUrlsStatements(RAW, C, M, U), 'write');
  const r = (await db.execute(`SELECT hreflang_count, html_hreflang_1, html_hreflang_1_url, raw_json FROM hreflang_urls WHERE url='https://zipkithomes.com/'`)).rows[0];
  assert.strictEqual(Number(r.hreflang_count), 2, `expected 2 groups, got ${r.hreflang_count}`);
  assert.strictEqual(String(r.html_hreflang_1), 'en');
  assert.strictEqual(String(r.html_hreflang_1_url), 'https://zipkithomes.com/');
  assert.ok(JSON.parse(String(r.raw_json))['HTML hreflang 2'] === 'es', 'group 2 preserved in raw_json');
});
await test('row with no hreflang values -> hreflang_count 0', async () => {
  const db = createClient({ url: ':memory:' }); await db.execute(CREATE);
  await db.batch(buildHreflangUrlsStatements(RAW, C, M, U), 'write');
  const r = (await db.execute(`SELECT hreflang_count, html_hreflang_1 FROM hreflang_urls WHERE url='https://zipkithomes.com/b'`)).rows[0];
  assert.strictEqual(Number(r.hreflang_count), 0);
  assert.strictEqual(r.html_hreflang_1, null);
});
await test('dedup by lowercased url keeps the first', async () => {
  const db = createClient({ url: ':memory:' }); await db.execute(CREATE);
  await db.batch(buildHreflangUrlsStatements(RAW, C, M, U), 'write');
  const r = await db.execute(`SELECT title FROM hreflang_urls WHERE lower(url)='https://zipkithomes.com/'`);
  assert.strictEqual(r.rows.length, 1);
  assert.strictEqual(String(r.rows[0].title), 'Home');
});
await test('empty CSV -> 0 statements', () => assert.strictEqual(buildHreflangUrlsStatements('', C, M, U).length, 0));

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
