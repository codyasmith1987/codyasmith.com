// Parity test for buildContentUrlsStatements.
//
// Oracle: content_all.csv from src/data/raised-bar-f3-csvs/.
// Row count (12) and spot-check values are derived by reading the
// fixture file directly — not by running old code.
//
// Fixture facts (verified by independent Python read of the CSV):
//   - 12 data rows, all with valid Address, 0 duplicates
//   - Expected inserts: 12
//   - Row 0: url=https://www.f3properties.com/ word_count=325 language=en-US
//   - No DELETE in this parser (Class-A; clear is in ingestCSV/clearPreviousData)

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createClient } from '@libsql/client';
import { buildContentUrlsStatements } from '../src/lib/csv/parsers/content-urls.ts';

let passed = 0, failed = 0;
async function test(n, f) {
  try { await f(); console.log(`[PASS] ${n}`); passed++; }
  catch (e) { console.error(`[FAIL] ${n}: ${e.message}`); failed++; }
}

const FIXTURE = new URL('../src/data/raised-bar-f3-csvs/content_all.csv', import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, '$1');
const raw = readFileSync(FIXTURE, 'utf-8');
const CLIENT_ID = 'test-client';
const MONTH = '2026-05';
const UPLOAD_ID = 'test-upload-content';

const CREATE_TABLE = `
  CREATE TABLE content_urls (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    csv_upload_id TEXT,
    month TEXT NOT NULL,
    url TEXT NOT NULL,
    hostname TEXT NOT NULL,
    word_count INTEGER,
    sentence_count INTEGER,
    avg_words_per_sentence REAL,
    flesch_reading_ease REAL,
    readability_grade TEXT,
    closest_near_duplicate_url TEXT,
    near_duplicate_count INTEGER,
    closest_semantic_similar_url TEXT,
    semantic_similarity_score REAL,
    semantic_relevance_score REAL,
    spelling_errors INTEGER,
    grammar_errors INTEGER,
    language TEXT,
    raw_json TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`;

await test('buildContentUrlsStatements returns 12 statements for content_all.csv', async () => {
  const stmts = buildContentUrlsStatements(raw, CLIENT_ID, MONTH, UPLOAD_ID);
  assert.strictEqual(stmts.length, 12, `Expected 12 statements, got ${stmts.length}`);
});

await test('each statement has 20 args (matching the 20 INSERT column positions)', async () => {
  const stmts = buildContentUrlsStatements(raw, CLIENT_ID, MONTH, UPLOAD_ID);
  for (const s of stmts) {
    assert.strictEqual(s.args.length, 20, `Expected 20 args, got ${s.args.length} for url ${s.args[4]}`);
  }
});

await test('db.batch produces 12 rows in content_urls', async () => {
  const db = createClient({ url: ':memory:' });
  await db.execute(CREATE_TABLE);
  const stmts = buildContentUrlsStatements(raw, CLIENT_ID, MONTH, UPLOAD_ID);
  for (let i = 0; i < stmts.length; i += 100) {
    await db.batch(stmts.slice(i, i + 100), 'write');
  }
  const count = await db.execute(`SELECT COUNT(*) AS n FROM content_urls`);
  assert.strictEqual(Number(count.rows[0].n), 12, `Expected 12 rows, got ${count.rows[0].n}`);
});

await test('homepage row has word_count=325 and language=en-US', async () => {
  const db = createClient({ url: ':memory:' });
  await db.execute(CREATE_TABLE);
  const stmts = buildContentUrlsStatements(raw, CLIENT_ID, MONTH, UPLOAD_ID);
  for (let i = 0; i < stmts.length; i += 100) {
    await db.batch(stmts.slice(i, i + 100), 'write');
  }
  const row = await db.execute(`SELECT word_count, language FROM content_urls WHERE url = 'https://www.f3properties.com/'`);
  assert.ok(row.rows.length > 0, 'Homepage row not found');
  assert.strictEqual(Number(row.rows[0].word_count), 325, `Expected word_count=325, got ${row.rows[0].word_count}`);
  assert.strictEqual(String(row.rows[0].language), 'en-US', `Expected language=en-US, got ${row.rows[0].language}`);
});

await test('client_id, upload_id, and month are threaded correctly', async () => {
  const stmts = buildContentUrlsStatements(raw, CLIENT_ID, MONTH, UPLOAD_ID);
  for (const s of stmts) {
    assert.strictEqual(s.args[1], CLIENT_ID);
    assert.strictEqual(s.args[2], UPLOAD_ID);
    assert.strictEqual(s.args[3], MONTH);
  }
});

await test('empty CSV returns 0 statements without throwing', () => {
  const stmts = buildContentUrlsStatements('', CLIENT_ID, MONTH, UPLOAD_ID);
  assert.strictEqual(stmts.length, 0);
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
