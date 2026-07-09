// Parity test for buildDirectiveUrlsStatements.
//
// Oracle: an inline CSV built from the REAL directives_all.csv header
// captured in docs/superpowers/plans/2026-06-02-unique-data-parsers.md.
// All expected values are hand-reasoned from the fixture, never from
// old-code output.
//
// Real header:
//   Address, Occurrences, Meta Robots 1, X-Robots-Tag 1,
//   Meta Refresh 1, Canonical Link Element 1, HTTP Canonical,
//   Indexability, Indexability Status
//
// Fixture rows (hand-reasoned truth):
//   1. https://zipkithomes.com/        occurrences=2  meta_robots='noindex'  meta_refresh=blank
//   2. https://zipkithomes.com/cart    occurrences=BLANK (-> null)  meta_refresh='0; url=/home'
//   3. HTTPS://ZIPKITHOMES.COM/   (dup of row 1 by lowercased url -> skipped)
//   4. (blank Address -> skipped)
// Expected inserts: 2 unique urls (rows 1,2).

import assert from 'node:assert';
import { createClient } from '@libsql/client';
import { buildDirectiveUrlsStatements } from '../src/lib/csv/parsers/directive-urls.ts';

let passed = 0, failed = 0;
async function test(n, f) {
  try { await f(); console.log(`[PASS] ${n}`); passed++; }
  catch (e) { console.error(`[FAIL] ${n}: ${e.message}`); failed++; }
}

const CLIENT_ID = 'test-client';
const MONTH = '2026-06';
const UPLOAD_ID = 'test-upload-directive';

const RAW =
  'Address,Occurrences,Meta Robots 1,X-Robots-Tag 1,Meta Refresh 1,Canonical Link Element 1,HTTP Canonical,Indexability,Indexability Status\n' +
  'https://zipkithomes.com/,2,noindex,,,https://zipkithomes.com/,,Non-Indexable,noindex\n' +
  'https://zipkithomes.com/cart,,,,"0; url=/home",https://zipkithomes.com/cart,,Indexable,\n' +
  'HTTPS://ZIPKITHOMES.COM/,7,index,,,https://zipkithomes.com/,,Indexable,\n' +
  ',4,,,,,,Non-Indexable,No URL\n';

const CREATE_TABLE = `
  CREATE TABLE directive_urls (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    csv_upload_id TEXT,
    month TEXT NOT NULL,
    url TEXT NOT NULL,
    hostname TEXT NOT NULL,
    occurrences INTEGER,
    meta_robots TEXT,
    x_robots_tag TEXT,
    meta_refresh TEXT,
    canonical_link_element TEXT,
    http_canonical TEXT,
    indexability TEXT,
    indexability_status TEXT,
    raw_json TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`;

await test('returns 2 statements (4 rows: 1 blank-address dropped, 1 dup dropped)', async () => {
  const stmts = buildDirectiveUrlsStatements(RAW, CLIENT_ID, MONTH, UPLOAD_ID);
  assert.strictEqual(stmts.length, 2, `Expected 2 statements, got ${stmts.length}`);
});

await test('each statement has 15 args (matching the 15 INSERT column positions)', async () => {
  const stmts = buildDirectiveUrlsStatements(RAW, CLIENT_ID, MONTH, UPLOAD_ID);
  for (const s of stmts) {
    assert.strictEqual(s.args.length, 15, `Expected 15 args, got ${s.args.length} for url ${s.args[4]}`);
  }
});

await test('db.batch produces 2 rows in directive_urls', async () => {
  const db = createClient({ url: ':memory:' });
  await db.execute(CREATE_TABLE);
  await db.batch(buildDirectiveUrlsStatements(RAW, CLIENT_ID, MONTH, UPLOAD_ID), 'write');
  const count = await db.execute(`SELECT COUNT(*) AS n FROM directive_urls`);
  assert.strictEqual(Number(count.rows[0].n), 2, `Expected 2 rows, got ${count.rows[0].n}`);
});

await test('occurrences coerces to INT; meta_refresh + hostname captured', async () => {
  const db = createClient({ url: ':memory:' });
  await db.execute(CREATE_TABLE);
  await db.batch(buildDirectiveUrlsStatements(RAW, CLIENT_ID, MONTH, UPLOAD_ID), 'write');
  const home = await db.execute(`SELECT occurrences, meta_robots, hostname FROM directive_urls WHERE url = 'https://zipkithomes.com/'`);
  assert.ok(home.rows.length > 0, 'home row not found');
  assert.strictEqual(Number(home.rows[0].occurrences), 2, `Expected occurrences=2, got ${home.rows[0].occurrences}`);
  assert.strictEqual(String(home.rows[0].meta_robots), 'noindex', `Expected meta_robots=noindex, got ${home.rows[0].meta_robots}`);
  assert.strictEqual(String(home.rows[0].hostname), 'zipkithomes.com', `Expected hostname=zipkithomes.com, got ${home.rows[0].hostname}`);

  const cart = await db.execute(`SELECT meta_refresh FROM directive_urls WHERE url = 'https://zipkithomes.com/cart'`);
  assert.strictEqual(String(cart.rows[0].meta_refresh), '0; url=/home', `Expected meta_refresh='0; url=/home', got ${cart.rows[0].meta_refresh}`);
});

await test('blank Occurrences becomes null (not 0)', async () => {
  const db = createClient({ url: ':memory:' });
  await db.execute(CREATE_TABLE);
  await db.batch(buildDirectiveUrlsStatements(RAW, CLIENT_ID, MONTH, UPLOAD_ID), 'write');
  const row = await db.execute(`SELECT occurrences FROM directive_urls WHERE url = 'https://zipkithomes.com/cart'`);
  assert.strictEqual(row.rows[0].occurrences, null, `Expected occurrences=null, got ${row.rows[0].occurrences}`);
});

await test('dedup by lowercased url keeps the first occurrence', async () => {
  const db = createClient({ url: ':memory:' });
  await db.execute(CREATE_TABLE);
  await db.batch(buildDirectiveUrlsStatements(RAW, CLIENT_ID, MONTH, UPLOAD_ID), 'write');
  const row = await db.execute(`SELECT occurrences FROM directive_urls WHERE lower(url) = 'https://zipkithomes.com/'`);
  assert.strictEqual(row.rows.length, 1, `Expected 1 homepage row, got ${row.rows.length}`);
  assert.strictEqual(Number(row.rows[0].occurrences), 2, `Expected first row (occurrences=2) to win, got ${row.rows[0].occurrences}`);
});

await test('client_id, upload_id, and month are threaded correctly', async () => {
  const stmts = buildDirectiveUrlsStatements(RAW, CLIENT_ID, MONTH, UPLOAD_ID);
  for (const s of stmts) {
    assert.strictEqual(s.args[1], CLIENT_ID);
    assert.strictEqual(s.args[2], UPLOAD_ID);
    assert.strictEqual(s.args[3], MONTH);
  }
});

await test('empty CSV returns 0 statements without throwing', () => {
  const stmts = buildDirectiveUrlsStatements('', CLIENT_ID, MONTH, UPLOAD_ID);
  assert.strictEqual(stmts.length, 0);
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
