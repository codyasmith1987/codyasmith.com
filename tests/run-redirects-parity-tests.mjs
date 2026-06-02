// Parity test for buildRedirectsStatements.
//
// The redirects.csv fixture in raised-bar-f3-csvs/ has the correct
// header row but 0 data rows (F3 has no redirects — a clean site).
// That is correct behavior: an SF export with header only and no
// data rows should produce 0 statements.
//
// For positive-path testing we use a hand-written CSV with the exact
// column names from the real SF redirects export, verified against
// the fixture header. The hand-written fixture has 2 rows to exercise:
//   - The hop1_url / hop1_status column mapping
//   - The safeBool conversion for Loop and Temp Redirect in Chain
//   - The source_hostname extraction
//
// Fixture hand-built facts:
//   - 2 data rows, both with valid Source
//   - Expected inserts: 2
//   - Row 0: source=https://www.f3properties.com/old-page/ hop_count=1 is_loop=0
//   - Row 1: source=https://www.f3properties.com/loop-page/ is_loop=1
//
// No DELETE in this parser (Class-A; clear is in ingestCSV/clearPreviousData).

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createClient } from '@libsql/client';
import { buildRedirectsStatements } from '../src/lib/csv/parsers/redirects.ts';

let passed = 0, failed = 0;
async function test(n, f) {
  try { await f(); console.log(`[PASS] ${n}`); passed++; }
  catch (e) { console.error(`[FAIL] ${n}: ${e.message}`); failed++; }
}

// The real fixture header (from redirects.csv), plus hand-written data rows.
// Column order matches actual SF redirect export header observed in the fixture.
const HAND_BUILT_CSV = `"Chain Type","Number of Redirects","Loop","Source","Temp Redirect in Chain","Address","Final Address","Final Indexability","Final Indexability Status","Final Content","Final Status Code","Final Status","Alt Text","Anchor Text","Link Path","Link Position","Content 1","Status Code 1","Status 1","Redirect Type 1","Redirect URL 1","Content 2","Status Code 2","Status 2","Redirect Type 2","Redirect URL 2","Content 3","Status Code 3","Status 3","Redirect Type 3","Redirect URL 3","Content 4","Status Code 4","Status 4","Redirect Type 4","Redirect URL 4","Content 5","Status Code 5","Status 5","Redirect Type 5","Redirect URL 5"
"Internal","1","False","https://www.f3properties.com/old-page/","False","https://www.f3properties.com/old-page/","https://www.f3properties.com/new-page/","Indexable","","text/html","200","OK","","homepage link","","BODY_A","text/html","301","Moved Permanently","301","https://www.f3properties.com/new-page/","","","","",""," ","","","","","","","","","","","","","",""
"Internal","2","True","https://www.f3properties.com/loop-page/","False","https://www.f3properties.com/loop-page/","https://www.f3properties.com/loop-page/","Non-Indexable","","text/html","301","Moved Permanently","","","","BODY_A","text/html","301","Moved Permanently","301","https://www.f3properties.com/other/","text/html","301","Moved Permanently","301","https://www.f3properties.com/loop-page/","","","","","","","","","","","","","","",""
`;

const CLIENT_ID = 'test-client';
const MONTH = '2026-05';
const UPLOAD_ID = 'test-upload-redirects';

// The real fixture (0 data rows — F3 has no redirects):
const FIXTURE_PATH = new URL('../src/data/raised-bar-f3-csvs/redirects.csv', import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, '$1');
const fixtureRaw = readFileSync(FIXTURE_PATH, 'utf-8');

const CREATE_TABLE = `
  CREATE TABLE redirect_chains (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    csv_upload_id TEXT,
    month TEXT NOT NULL,
    chain_type TEXT,
    source_url TEXT NOT NULL,
    source_hostname TEXT NOT NULL,
    final_url TEXT,
    final_status_code INTEGER,
    final_indexability TEXT,
    hop_count INTEGER NOT NULL DEFAULT 0,
    is_loop INTEGER NOT NULL DEFAULT 0,
    temp_redirect_in_chain INTEGER NOT NULL DEFAULT 0,
    anchor_text TEXT,
    link_path TEXT,
    hop1_url TEXT, hop1_status INTEGER,
    hop2_url TEXT, hop2_status INTEGER,
    hop3_url TEXT, hop3_status INTEGER,
    hop4_url TEXT, hop4_status INTEGER,
    hop5_url TEXT, hop5_status INTEGER,
    raw_json TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`;

await test('real redirects.csv fixture (0 data rows) returns 0 statements', async () => {
  const stmts = buildRedirectsStatements(fixtureRaw, CLIENT_ID, MONTH, UPLOAD_ID);
  assert.strictEqual(stmts.length, 0, `Expected 0 statements from header-only fixture, got ${stmts.length}`);
});

await test('hand-built CSV returns 2 statements', async () => {
  const stmts = buildRedirectsStatements(HAND_BUILT_CSV, CLIENT_ID, MONTH, UPLOAD_ID);
  assert.strictEqual(stmts.length, 2, `Expected 2 statements, got ${stmts.length}`);
});

await test('each statement has 26 args (matching the 26 INSERT column positions)', async () => {
  const stmts = buildRedirectsStatements(HAND_BUILT_CSV, CLIENT_ID, MONTH, UPLOAD_ID);
  for (const s of stmts) {
    assert.strictEqual(s.args.length, 26, `Expected 26 args, got ${s.args.length} for source ${s.args[5]}`);
  }
});

await test('db.batch produces 2 rows with correct hop_count, is_loop, source_hostname', async () => {
  const db = createClient({ url: ':memory:' });
  await db.execute(CREATE_TABLE);
  const stmts = buildRedirectsStatements(HAND_BUILT_CSV, CLIENT_ID, MONTH, UPLOAD_ID);
  for (let i = 0; i < stmts.length; i += 100) {
    await db.batch(stmts.slice(i, i + 100), 'write');
  }
  const count = await db.execute(`SELECT COUNT(*) AS n FROM redirect_chains`);
  assert.strictEqual(Number(count.rows[0].n), 2, `Expected 2 rows, got ${count.rows[0].n}`);

  const row0 = await db.execute(`SELECT hop_count, is_loop, source_hostname FROM redirect_chains WHERE source_url = 'https://www.f3properties.com/old-page/'`);
  assert.ok(row0.rows.length > 0, 'Row for /old-page/ not found');
  assert.strictEqual(Number(row0.rows[0].hop_count), 1, `Expected hop_count=1, got ${row0.rows[0].hop_count}`);
  assert.strictEqual(Number(row0.rows[0].is_loop), 0, `Expected is_loop=0, got ${row0.rows[0].is_loop}`);
  assert.strictEqual(String(row0.rows[0].source_hostname), 'f3properties.com', `Expected source_hostname=f3properties.com, got ${row0.rows[0].source_hostname}`);

  const row1 = await db.execute(`SELECT is_loop FROM redirect_chains WHERE source_url = 'https://www.f3properties.com/loop-page/'`);
  assert.ok(row1.rows.length > 0, 'Row for /loop-page/ not found');
  assert.strictEqual(Number(row1.rows[0].is_loop), 1, `Expected is_loop=1 for loop row, got ${row1.rows[0].is_loop}`);
});

await test('hop1_url and hop1_status are mapped correctly', async () => {
  const db = createClient({ url: ':memory:' });
  await db.execute(CREATE_TABLE);
  const stmts = buildRedirectsStatements(HAND_BUILT_CSV, CLIENT_ID, MONTH, UPLOAD_ID);
  for (let i = 0; i < stmts.length; i += 100) {
    await db.batch(stmts.slice(i, i + 100), 'write');
  }
  const row = await db.execute(`SELECT hop1_url, hop1_status FROM redirect_chains WHERE source_url = 'https://www.f3properties.com/old-page/'`);
  assert.ok(row.rows.length > 0, 'Row not found');
  assert.strictEqual(String(row.rows[0].hop1_url), 'https://www.f3properties.com/new-page/', `Expected hop1_url to be new-page, got ${row.rows[0].hop1_url}`);
  assert.strictEqual(Number(row.rows[0].hop1_status), 301, `Expected hop1_status=301, got ${row.rows[0].hop1_status}`);
});

await test('client_id, upload_id, and month are threaded correctly', async () => {
  const stmts = buildRedirectsStatements(HAND_BUILT_CSV, CLIENT_ID, MONTH, UPLOAD_ID);
  for (const s of stmts) {
    assert.strictEqual(s.args[1], CLIENT_ID);
    assert.strictEqual(s.args[2], UPLOAD_ID);
    assert.strictEqual(s.args[3], MONTH);
  }
});

await test('empty CSV returns 0 statements without throwing', () => {
  const stmts = buildRedirectsStatements('', CLIENT_ID, MONTH, UPLOAD_ID);
  assert.strictEqual(stmts.length, 0);
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
