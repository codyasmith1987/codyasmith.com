// Parity test for buildCanonicalUrlsStatements.
//
// Oracle: an inline CSV built from the REAL canonicals_all.csv header
// captured in docs/superpowers/plans/2026-06-02-unique-data-parsers.md.
// All expected values are hand-reasoned from the fixture below, never
// from old-code output.
//
// Real header (Papa unquotes `rel=""next"" 1` -> `rel="next" 1`):
//   Address, Occurrences, Indexability, Indexability Status,
//   Canonical Link Element 1, HTTP Canonical, Meta Robots 1,
//   X-Robots-Tag 1, rel="next" 1, rel="prev" 1, HTTP rel="next" 1,
//   HTTP rel="prev" 1
//
// Fixture rows (hand-reasoned truth):
//   1. https://zipkithomes.com/        occurrences=1   canonical=self  rel_next=blank
//   2. https://zipkithomes.com/about   occurrences=3   meta_robots set
//   3. https://zipkithomes.com/blog    occurrences=BLANK (-> null, not 0)
//   4. HTTPS://ZIPKITHOMES.COM/  (dup of row 1 by lowercased url -> skipped)
//   5. (blank Address -> skipped)
// Expected inserts: 4 (rows 1,2,3 + one survivor; row 4 dup + row 5 blank dropped)
// => actually 3 unique urls survive (1,2,3); row 4 is a dup of row 1.

import assert from 'node:assert';
import { createClient } from '@libsql/client';
import { buildCanonicalUrlsStatements } from '../src/lib/csv/parsers/canonical-urls.ts';

let passed = 0, failed = 0;
async function test(n, f) {
  try { await f(); console.log(`[PASS] ${n}`); passed++; }
  catch (e) { console.error(`[FAIL] ${n}: ${e.message}`); failed++; }
}

const CLIENT_ID = 'test-client';
const MONTH = '2026-06';
const UPLOAD_ID = 'test-upload-canonical';

const RAW =
  'Address,Occurrences,Indexability,Indexability Status,Canonical Link Element 1,HTTP Canonical,Meta Robots 1,X-Robots-Tag 1,"rel=""next"" 1","rel=""prev"" 1","HTTP rel=""next"" 1","HTTP rel=""prev"" 1"\n' +
  'https://zipkithomes.com/,1,Indexable,,https://zipkithomes.com/,,,,,,,\n' +
  'https://zipkithomes.com/about,3,Indexable,,https://zipkithomes.com/about,,"index, follow",,,,,\n' +
  'https://zipkithomes.com/blog,,Indexable,,https://zipkithomes.com/blog,,,,,,,\n' +
  'HTTPS://ZIPKITHOMES.COM/,9,Indexable,,https://zipkithomes.com/,,,,,,,\n' +
  ',5,Non-Indexable,No URL,,,,,,,,\n';

const CREATE_TABLE = `
  CREATE TABLE canonical_urls (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    csv_upload_id TEXT,
    month TEXT NOT NULL,
    url TEXT NOT NULL,
    hostname TEXT NOT NULL,
    occurrences INTEGER,
    indexability TEXT,
    indexability_status TEXT,
    canonical_link_element TEXT,
    http_canonical TEXT,
    meta_robots TEXT,
    x_robots_tag TEXT,
    rel_next TEXT,
    rel_prev TEXT,
    http_rel_next TEXT,
    http_rel_prev TEXT,
    raw_json TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`;

await test('returns 3 statements (5 rows: 1 blank-address dropped, 1 dup dropped)', async () => {
  const stmts = buildCanonicalUrlsStatements(RAW, CLIENT_ID, MONTH, UPLOAD_ID);
  assert.strictEqual(stmts.length, 3, `Expected 3 statements, got ${stmts.length}`);
});

await test('each statement has 18 args (matching the 18 INSERT column positions)', async () => {
  const stmts = buildCanonicalUrlsStatements(RAW, CLIENT_ID, MONTH, UPLOAD_ID);
  for (const s of stmts) {
    assert.strictEqual(s.args.length, 18, `Expected 18 args, got ${s.args.length} for url ${s.args[4]}`);
  }
});

await test('db.batch produces 3 rows in canonical_urls', async () => {
  const db = createClient({ url: ':memory:' });
  await db.execute(CREATE_TABLE);
  const stmts = buildCanonicalUrlsStatements(RAW, CLIENT_ID, MONTH, UPLOAD_ID);
  await db.batch(stmts, 'write');
  const count = await db.execute(`SELECT COUNT(*) AS n FROM canonical_urls`);
  assert.strictEqual(Number(count.rows[0].n), 3, `Expected 3 rows, got ${count.rows[0].n}`);
});

await test('occurrences coerces to INT; url + hostname extracted', async () => {
  const db = createClient({ url: ':memory:' });
  await db.execute(CREATE_TABLE);
  await db.batch(buildCanonicalUrlsStatements(RAW, CLIENT_ID, MONTH, UPLOAD_ID), 'write');
  const row = await db.execute(`SELECT occurrences, hostname, meta_robots FROM canonical_urls WHERE url = 'https://zipkithomes.com/about'`);
  assert.ok(row.rows.length > 0, 'about row not found');
  assert.strictEqual(Number(row.rows[0].occurrences), 3, `Expected occurrences=3, got ${row.rows[0].occurrences}`);
  assert.strictEqual(String(row.rows[0].hostname), 'zipkithomes.com', `Expected hostname=zipkithomes.com, got ${row.rows[0].hostname}`);
  assert.strictEqual(String(row.rows[0].meta_robots), 'index, follow', `Expected meta_robots='index, follow', got ${row.rows[0].meta_robots}`);
});

await test('blank Occurrences becomes null (not 0)', async () => {
  const db = createClient({ url: ':memory:' });
  await db.execute(CREATE_TABLE);
  await db.batch(buildCanonicalUrlsStatements(RAW, CLIENT_ID, MONTH, UPLOAD_ID), 'write');
  const row = await db.execute(`SELECT occurrences FROM canonical_urls WHERE url = 'https://zipkithomes.com/blog'`);
  assert.ok(row.rows.length > 0, 'blog row not found');
  assert.strictEqual(row.rows[0].occurrences, null, `Expected occurrences=null, got ${row.rows[0].occurrences}`);
});

await test('dedup by lowercased url keeps the first occurrence', async () => {
  const db = createClient({ url: ':memory:' });
  await db.execute(CREATE_TABLE);
  await db.batch(buildCanonicalUrlsStatements(RAW, CLIENT_ID, MONTH, UPLOAD_ID), 'write');
  // The dup (HTTPS://ZIPKITHOMES.COM/ occurrences=9) is dropped; the first (occurrences=1) survives.
  const row = await db.execute(`SELECT occurrences FROM canonical_urls WHERE lower(url) = 'https://zipkithomes.com/'`);
  assert.strictEqual(row.rows.length, 1, `Expected 1 row for the homepage, got ${row.rows.length}`);
  assert.strictEqual(Number(row.rows[0].occurrences), 1, `Expected the first row (occurrences=1) to win, got ${row.rows[0].occurrences}`);
});

await test('client_id, upload_id, and month are threaded correctly', async () => {
  const stmts = buildCanonicalUrlsStatements(RAW, CLIENT_ID, MONTH, UPLOAD_ID);
  for (const s of stmts) {
    assert.strictEqual(s.args[1], CLIENT_ID);
    assert.strictEqual(s.args[2], UPLOAD_ID);
    assert.strictEqual(s.args[3], MONTH);
  }
});

await test('empty CSV returns 0 statements without throwing', () => {
  const stmts = buildCanonicalUrlsStatements('', CLIENT_ID, MONTH, UPLOAD_ID);
  assert.strictEqual(stmts.length, 0);
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
