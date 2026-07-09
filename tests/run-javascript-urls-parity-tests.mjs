// Parity test for buildJavascriptUrlsStatements.
// Oracle: inline CSV from the REAL javascript_all.csv header. All expected
// values hand-reasoned from the fixture, never from old-code output.
import assert from 'node:assert';
import { createClient } from '@libsql/client';
import { buildJavascriptUrlsStatements } from '../src/lib/csv/parsers/javascript-urls.ts';

let passed = 0, failed = 0;
async function test(n, f) {
  try { await f(); console.log(`[PASS] ${n}`); passed++; }
  catch (e) { console.error(`[FAIL] ${n}: ${e.message}`); failed++; }
}
const C = 'test-client', M = '2026-06', U = 'up-js';

// Real columns (subset sufficient to exercise typed extraction; absent columns
// coerce to null and the arg count stays fixed at 26).
const RAW =
  'Address,Status Code,HTML Word Count,Rendered HTML Word Count,Word Count Change,JS Word Count %,HTML Title,Rendered HTML Title,Unique Inlinks\n' +
  'https://zipkithomes.com/,200,100,350,250,71.4,A,A rendered,5\n' +
  'https://zipkithomes.com/b,200,,,,,B,,\n' +
  'HTTPS://ZIPKITHOMES.COM/,200,999,999,0,0,dup,dup,9\n' +
  ',200,1,1,0,0,,,\n';

const CREATE = `CREATE TABLE javascript_urls (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, csv_upload_id TEXT, month TEXT NOT NULL,
  url TEXT NOT NULL, hostname TEXT NOT NULL, status_code INTEGER, html_word_count INTEGER,
  rendered_word_count INTEGER, word_count_change INTEGER, js_word_count_pct REAL,
  html_title TEXT, rendered_title TEXT, html_h1 TEXT, rendered_h1 TEXT, html_meta_description TEXT,
  rendered_meta_description TEXT, html_canonical TEXT, rendered_canonical TEXT, unique_inlinks INTEGER,
  unique_js_inlinks INTEGER, unique_outlinks INTEGER, unique_js_outlinks INTEGER,
  html_meta_robots TEXT, rendered_meta_robots TEXT, raw_json TEXT, created_at TEXT DEFAULT (datetime('now')))`;

await test('returns 2 statements (4 rows: 1 dup + 1 blank-address dropped)', async () => {
  assert.strictEqual(buildJavascriptUrlsStatements(RAW, C, M, U).length, 2);
});
await test('each statement has 26 args', async () => {
  for (const s of buildJavascriptUrlsStatements(RAW, C, M, U)) assert.strictEqual(s.args.length, 26, `got ${s.args.length}`);
});
await test('db.batch produces 2 rows; rendered/delta typed; pct is REAL', async () => {
  const db = createClient({ url: ':memory:' }); await db.execute(CREATE);
  await db.batch(buildJavascriptUrlsStatements(RAW, C, M, U), 'write');
  assert.strictEqual(Number((await db.execute('SELECT COUNT(*) AS n FROM javascript_urls')).rows[0].n), 2);
  const r = (await db.execute(`SELECT rendered_word_count, word_count_change, js_word_count_pct, hostname FROM javascript_urls WHERE url='https://zipkithomes.com/'`)).rows[0];
  assert.strictEqual(Number(r.rendered_word_count), 350);
  assert.strictEqual(Number(r.word_count_change), 250);
  assert.strictEqual(Number(r.js_word_count_pct), 71.4);
  assert.strictEqual(String(r.hostname), 'zipkithomes.com');
});
await test('blank numeric columns become null (not 0)', async () => {
  const db = createClient({ url: ':memory:' }); await db.execute(CREATE);
  await db.batch(buildJavascriptUrlsStatements(RAW, C, M, U), 'write');
  const r = (await db.execute(`SELECT html_word_count, rendered_word_count FROM javascript_urls WHERE url='https://zipkithomes.com/b'`)).rows[0];
  assert.strictEqual(r.html_word_count, null);
  assert.strictEqual(r.rendered_word_count, null);
});
await test('dedup by lowercased url keeps the first', async () => {
  const db = createClient({ url: ':memory:' }); await db.execute(CREATE);
  await db.batch(buildJavascriptUrlsStatements(RAW, C, M, U), 'write');
  const r = await db.execute(`SELECT html_word_count FROM javascript_urls WHERE lower(url)='https://zipkithomes.com/'`);
  assert.strictEqual(r.rows.length, 1);
  assert.strictEqual(Number(r.rows[0].html_word_count), 100);
});
await test('empty CSV -> 0 statements', () => assert.strictEqual(buildJavascriptUrlsStatements('', C, M, U).length, 0));

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
