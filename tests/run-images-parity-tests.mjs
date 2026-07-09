// Parity test for buildImagesStatements.
//
// Oracle: images_all.csv from src/data/raised-bar-f3-csvs/.
// Row count (52) and spot-check values are derived by reading the
// fixture file directly — not by running old code.
//
// Fixture facts (verified by independent Python read of the CSV):
//   - 52 data rows, all with valid Address, 0 duplicates
//   - Expected inserts: 52
//   - Row 0: url ends with GoldenEagle-sold-landscape-51daea85331dfb78e2dc48606bdb83a6-60ae383c61960.jpg
//            content_type=image/jpeg size_bytes=333893
//   - No DELETE in this parser (Class-A; clear is in ingestCSV/clearPreviousData)

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createClient } from '@libsql/client';
import { buildImagesStatements } from '../src/lib/csv/parsers/images.ts';

let passed = 0, failed = 0;
async function test(n, f) {
  try { await f(); console.log(`[PASS] ${n}`); passed++; }
  catch (e) { console.error(`[FAIL] ${n}: ${e.message}`); failed++; }
}

const FIXTURE = new URL('../src/data/raised-bar-f3-csvs/images_all.csv', import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, '$1');
const raw = readFileSync(FIXTURE, 'utf-8');
const CLIENT_ID = 'test-client';
const MONTH = '2026-05';
const UPLOAD_ID = 'test-upload-images';

const CREATE_TABLE = `
  CREATE TABLE image_urls (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    csv_upload_id TEXT,
    month TEXT NOT NULL,
    url TEXT NOT NULL,
    hostname TEXT NOT NULL,
    content_type TEXT,
    size_bytes INTEGER,
    inlinks_count INTEGER,
    indexability TEXT,
    dimensions TEXT,
    raw_json TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`;

await test('buildImagesStatements returns 52 statements for images_all.csv', async () => {
  const stmts = buildImagesStatements(raw, CLIENT_ID, MONTH, UPLOAD_ID);
  assert.strictEqual(stmts.length, 52, `Expected 52 statements, got ${stmts.length}`);
});

await test('each statement has 12 args (matching the 12 INSERT column positions)', async () => {
  const stmts = buildImagesStatements(raw, CLIENT_ID, MONTH, UPLOAD_ID);
  for (const s of stmts) {
    assert.strictEqual(s.args.length, 12, `Expected 12 args, got ${s.args.length} for url ${s.args[4]}`);
  }
});

await test('db.batch produces 52 rows in image_urls', async () => {
  const db = createClient({ url: ':memory:' });
  await db.execute(CREATE_TABLE);
  const stmts = buildImagesStatements(raw, CLIENT_ID, MONTH, UPLOAD_ID);
  for (let i = 0; i < stmts.length; i += 100) {
    await db.batch(stmts.slice(i, i + 100), 'write');
  }
  const count = await db.execute(`SELECT COUNT(*) AS n FROM image_urls`);
  assert.strictEqual(Number(count.rows[0].n), 52, `Expected 52 rows, got ${count.rows[0].n}`);
});

await test('GoldenEagle JPEG row has content_type=image/jpeg and size_bytes=333893', async () => {
  const db = createClient({ url: ':memory:' });
  await db.execute(CREATE_TABLE);
  const stmts = buildImagesStatements(raw, CLIENT_ID, MONTH, UPLOAD_ID);
  for (let i = 0; i < stmts.length; i += 100) {
    await db.batch(stmts.slice(i, i + 100), 'write');
  }
  const jpegUrl = 'https://www.f3properties.com/wp-content/uploads/bb-plugin/cache/GoldenEagle-sold-landscape-51daea85331dfb78e2dc48606bdb83a6-60ae383c61960.jpg';
  const row = await db.execute(`SELECT content_type, size_bytes FROM image_urls WHERE url = '${jpegUrl}'`);
  assert.ok(row.rows.length > 0, `JPEG row not found for url: ${jpegUrl}`);
  assert.strictEqual(String(row.rows[0].content_type), 'image/jpeg', `Expected content_type=image/jpeg, got ${row.rows[0].content_type}`);
  assert.strictEqual(Number(row.rows[0].size_bytes), 333893, `Expected size_bytes=333893, got ${row.rows[0].size_bytes}`);
});

await test('client_id, upload_id, and month are threaded correctly', async () => {
  const stmts = buildImagesStatements(raw, CLIENT_ID, MONTH, UPLOAD_ID);
  for (const s of stmts) {
    assert.strictEqual(s.args[1], CLIENT_ID);
    assert.strictEqual(s.args[2], UPLOAD_ID);
    assert.strictEqual(s.args[3], MONTH);
  }
});

await test('empty CSV returns 0 statements without throwing', () => {
  const stmts = buildImagesStatements('', CLIENT_ID, MONTH, UPLOAD_ID);
  assert.strictEqual(stmts.length, 0);
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
