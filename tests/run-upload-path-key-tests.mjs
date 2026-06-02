// DB-level invariant tests for the CSV upload path-key fix.
//
// Proves that using the full relative path as original_name lets two
// same-basename files from different subfolders coexist as DISTINCT
// live rows in csv_uploads, while a true duplicate (identical
// original_name) is still rejected by the partial unique index.
//
// Mirrors the DDL in migration 055 and run-supersession-key-tests.mjs.

import assert from 'node:assert';
import { createClient } from '@libsql/client';

let passed = 0, failed = 0;
function test(name, fn) {
  return fn()
    .then(() => { console.log(`[PASS] ${name}`); passed++; })
    .catch(err => { console.error(`[FAIL] ${name}: ${err.message}`); failed++; });
}

async function seed() {
  const db = createClient({ url: 'file::memory:' });
  await db.execute(`CREATE TABLE csv_uploads (
    id TEXT PRIMARY KEY,
    client_id TEXT,
    original_name TEXT,
    detected_format TEXT,
    month TEXT,
    row_count INTEGER,
    error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  // Exact DDL from migration 055.
  await db.execute(`CREATE UNIQUE INDEX ux_csv_uploads_live
    ON csv_uploads (client_id, month, detected_format, original_name)
    WHERE error IS NULL`);
  return db;
}

// Test 1: path-distinct filenames with the same basename both live simultaneously.
await test('path-distinct original_names coexist as live rows (core fix invariant)', async () => {
  const db = await seed();

  // Top-level file — basename only (e.g. uploaded standalone or at zip root).
  await db.execute({
    sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month)
          VALUES ('u1', 'c1', 'images_missing_alt_text.csv', 'issue_urls', '2026-05')`,
    args: [],
  });

  // Same basename in a subfolder — the path-inclusive key from the fix.
  // Must NOT conflict with u1.
  let threw = false;
  try {
    await db.execute({
      sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month)
            VALUES ('u2', 'c1', 'issues_reports/images_missing_alt_text.csv', 'issue_urls', '2026-05')`,
      args: [],
    });
  } catch (e) {
    threw = true;
    console.error('Unexpected conflict:', e.message);
  }

  assert.ok(!threw, 'path-distinct names must NOT conflict on the partial unique index');

  const live = await db.execute(
    `SELECT id FROM csv_uploads WHERE client_id='c1' AND month='2026-05' AND error IS NULL ORDER BY id`,
  );
  assert.strictEqual(live.rows.length, 2, 'both path-distinct rows must be live simultaneously');
  assert.strictEqual(String(live.rows[0][0]), 'u1');
  assert.strictEqual(String(live.rows[1][0]), 'u2');
});

// Test 2: identical original_name (true duplicate) is still rejected.
await test('identical original_name (true duplicate) is rejected by the partial unique index', async () => {
  const db = await seed();

  await db.execute({
    sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month)
          VALUES ('u1', 'c1', 'images_missing_alt_text.csv', 'issue_urls', '2026-05')`,
    args: [],
  });

  let rejected = false;
  try {
    await db.execute({
      sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month)
            VALUES ('u2', 'c1', 'images_missing_alt_text.csv', 'issue_urls', '2026-05')`,
      args: [],
    });
  } catch (e) {
    rejected = true;
    assert.ok(
      e.message?.toLowerCase().includes('unique'),
      `expected UNIQUE constraint error, got: ${e.message}`,
    );
  }

  assert.ok(rejected, 'second live row with identical original_name must be rejected');
});

// Test 3: ZIP-entry path format (archive.zip:subfolder/file.csv vs archive.zip:file.csv)
// also yields distinct keys, matching the ZIP ingest path in the fix.
await test('ZIP-entry path keys are distinct for same-basename entries in different subdirs', async () => {
  const db = await seed();

  const zipRoot = 'sf_export.zip:images_missing_alt_text.csv';
  const zipSub  = 'sf_export.zip:issues_reports/images_missing_alt_text.csv';

  await db.execute({
    sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month)
          VALUES ('u1', 'c1', ?, 'issue_urls', '2026-05')`,
    args: [zipRoot],
  });

  let threw = false;
  try {
    await db.execute({
      sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month)
            VALUES ('u2', 'c1', ?, 'issue_urls', '2026-05')`,
      args: [zipSub],
    });
  } catch (e) {
    threw = true;
    console.error('Unexpected conflict on ZIP-path keys:', e.message);
  }

  assert.ok(!threw, 'ZIP-entry path-distinct keys must not conflict');

  const live = await db.execute(
    `SELECT COUNT(*) FROM csv_uploads WHERE client_id='c1' AND month='2026-05' AND error IS NULL`,
  );
  assert.strictEqual(Number(live.rows[0][0]), 2, 'both ZIP-entry rows must be live');
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
