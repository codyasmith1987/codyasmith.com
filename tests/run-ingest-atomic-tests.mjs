// Atomicity test for the Class-A ingest transaction (Task 8).
//
// PROVES the keystone property: clear(prior) + insert(new upload) + parser
// INSERTs + rowcount all run in ONE turso.batch('write'), so a parser failure
// rolls back the WHOLE batch and the prior upload's data is never half-deleted.
//
// Oracle: hand-built db state we set up here, NOT the output of old code.
//
// runAtomicIngest is the exported helper ingestCSV uses to assemble + run the
// atomic statement array. We exercise it directly against an in-memory libsql
// db so the test needs no prod, no network, and no Turso credentials.
//
// libsql batch semantics (the whole design rests on this): the local sqlite3
// client runs BEGIN, then each statement; on ANY throw it never reaches COMMIT
// and the finally-block runs ROLLBACK (db.inTransaction is still true). The
// remote hrana client wraps the statements in a transaction the same way.
// Either way a failed statement rolls back the entire batch — verified below
// by case (b).

import assert from 'node:assert';
import { createClient } from '@libsql/client';
import { runAtomicIngest } from '../src/lib/csv/index.ts';

let passed = 0, failed = 0;
async function test(n, f) {
  try { await f(); console.log(`[PASS] ${n}`); passed++; }
  catch (e) { console.error(`[FAIL] ${n}: ${e.message}`); failed++; }
}

const CLIENT = 'c1';
const MONTH = '2026-05';
const FORMAT = 'crawl_internal';
const FILENAME = 'internal_all.csv';

// Build a fresh in-memory db with the csv_uploads + crawl_urls tables and the
// partial unique index that guards one-live-upload-per-key.
async function freshDb() {
  const db = createClient({ url: 'file::memory:' });
  await db.execute(`CREATE TABLE csv_uploads (
    id TEXT PRIMARY KEY,
    client_id TEXT,
    original_name TEXT,
    detected_format TEXT,
    month TEXT,
    uploaded_by TEXT,
    row_count INTEGER,
    processed_at TEXT,
    error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  await db.execute(`CREATE TABLE crawl_urls (
    id TEXT PRIMARY KEY,
    client_id TEXT,
    csv_upload_id TEXT,
    month TEXT,
    url TEXT
  )`);
  await db.execute(`CREATE UNIQUE INDEX ux_csv_uploads_live
    ON csv_uploads (client_id, month, detected_format, original_name)
    WHERE error IS NULL`);
  return db;
}

// Seed a prior LIVE upload (error IS NULL) of this key with N child rows.
async function seedPrior(db, priorId, n) {
  await db.execute({
    sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month, row_count) VALUES (?, ?, ?, ?, ?, ?)`,
    args: [priorId, CLIENT, FILENAME, FORMAT, MONTH, n],
  });
  for (let i = 0; i < n; i++) {
    await db.execute({
      sql: `INSERT INTO crawl_urls (id, client_id, csv_upload_id, month, url) VALUES (?, ?, ?, ?, ?)`,
      args: [`prior_row_${i}`, CLIENT, priorId, MONTH, `https://x/prior/${i}`],
    });
  }
}

// The clear statements collectClearStatements would return for a prior upload:
// DELETE the prior upload's child rows + supersede the prior csv_uploads row.
function clearFor(priorId) {
  return [
    { sql: `DELETE FROM crawl_urls WHERE client_id = ? AND month = ? AND csv_upload_id = ?`, args: [CLIENT, MONTH, priorId] },
    { sql: `UPDATE csv_uploads SET error = ? WHERE id = ?`, args: ['Superseded by newer upload', priorId] },
  ];
}

function uploadInsertFor(uploadId) {
  return {
    sql: 'INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)',
    args: [uploadId, CLIENT, FILENAME, FORMAT, MONTH, 'tester'],
  };
}

function rowCountUpdateFor(uploadId, count) {
  return {
    sql: 'UPDATE csv_uploads SET row_count = ?, processed_at = datetime(\'now\') WHERE id = ?',
    args: [count, uploadId],
  };
}

// Valid parser INSERTs for the new upload (M child rows).
function goodParserStatements(uploadId, m) {
  const sql = `INSERT INTO crawl_urls (id, client_id, csv_upload_id, month, url) VALUES (?, ?, ?, ?, ?)`;
  return Array.from({ length: m }, (_, i) => ({
    args: [`new_row_${i}`, CLIENT, uploadId, MONTH, `https://x/new/${i}`],
    sql,
  }));
}

// ─── (a) SUCCESS ─────────────────────────────────────────────────────────────
await test('(a) SUCCESS: prior superseded + cleared, new live row + new child rows, exactly one live upload, row_count correct', async () => {
  const db = await freshDb();
  const priorId = 'up_prior';
  const newId = 'up_new';
  await seedPrior(db, priorId, 3);

  const parserStatements = goodParserStatements(newId, 5);
  await runAtomicIngest(db, {
    clearStatements: clearFor(priorId),
    uploadInsert: uploadInsertFor(newId),
    parserStatements,
    rowCountUpdate: rowCountUpdateFor(newId, parserStatements.length),
  });

  // Prior row superseded (error set).
  const prior = await db.execute({ sql: `SELECT error FROM csv_uploads WHERE id = ?`, args: [priorId] });
  assert.strictEqual(prior.rows[0].error, 'Superseded by newer upload', 'prior upload must be superseded');

  // Prior child rows deleted.
  const priorChildren = await db.execute({ sql: `SELECT COUNT(*) AS n FROM crawl_urls WHERE csv_upload_id = ?`, args: [priorId] });
  assert.strictEqual(Number(priorChildren.rows[0].n), 0, 'prior child rows must be deleted');

  // New live row present with correct row_count + processed_at.
  const newRow = await db.execute({ sql: `SELECT error, row_count, processed_at FROM csv_uploads WHERE id = ?`, args: [newId] });
  assert.strictEqual(newRow.rows[0].error, null, 'new upload must be live (error NULL)');
  assert.strictEqual(Number(newRow.rows[0].row_count), 5, 'row_count must match the builder statement count');
  assert.ok(newRow.rows[0].processed_at, 'processed_at must be set');

  // New child rows present.
  const newChildren = await db.execute({ sql: `SELECT COUNT(*) AS n FROM crawl_urls WHERE csv_upload_id = ?`, args: [newId] });
  assert.strictEqual(Number(newChildren.rows[0].n), 5, 'new child rows must be present');

  // Exactly ONE live upload for the key.
  const live = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM csv_uploads WHERE client_id = ? AND month = ? AND detected_format = ? AND original_name = ? AND error IS NULL`,
    args: [CLIENT, MONTH, FORMAT, FILENAME],
  });
  assert.strictEqual(Number(live.rows[0].n), 1, 'exactly one live upload for the key');
});

// ─── (b) FAILURE ROLLBACK (the critical proof) ───────────────────────────────
await test('(b) FAILURE ROLLBACK: a constraint-violating parser stmt makes the batch throw; prior data fully intact, no half-write', async () => {
  const db = await freshDb();
  const priorId = 'up_prior';
  const newId = 'up_new';
  await seedPrior(db, priorId, 3);

  // Poison the parser statements: a row with a DUPLICATE primary key (id) so
  // the batch throws a UNIQUE/constraint error partway through. We put one
  // good row first, then two rows sharing the same id to force the violation
  // AFTER the clear + supersede + upload-insert have already executed in-batch
  // — the worst case for a non-atomic path (half-write), the win for atomicity.
  const sql = `INSERT INTO crawl_urls (id, client_id, csv_upload_id, month, url) VALUES (?, ?, ?, ?, ?)`;
  const parserStatements = [
    { sql, args: ['dup_id', CLIENT, newId, MONTH, 'https://x/new/0'] },
    { sql, args: ['dup_id', CLIENT, newId, MONTH, 'https://x/new/1'] }, // same PK -> UNIQUE violation
  ];

  let threw = false;
  try {
    await runAtomicIngest(db, {
      clearStatements: clearFor(priorId),
      uploadInsert: uploadInsertFor(newId),
      parserStatements,
      rowCountUpdate: rowCountUpdateFor(newId, parserStatements.length),
    });
  } catch (e) {
    threw = true;
  }
  assert.ok(threw, 'the batch MUST throw on the constraint-violating statement');

  // Prior upload STILL LIVE (supersede UPDATE rolled back).
  const prior = await db.execute({ sql: `SELECT error FROM csv_uploads WHERE id = ?`, args: [priorId] });
  assert.strictEqual(prior.rows[0].error, null, 'prior upload must still be LIVE (supersede rolled back)');

  // Prior child rows STILL PRESENT (DELETE rolled back).
  const priorChildren = await db.execute({ sql: `SELECT COUNT(*) AS n FROM crawl_urls WHERE csv_upload_id = ?`, args: [priorId] });
  assert.strictEqual(Number(priorChildren.rows[0].n), 3, 'prior child rows must still be present (DELETE rolled back)');

  // NO new csv_uploads row (insert rolled back).
  const newRow = await db.execute({ sql: `SELECT COUNT(*) AS n FROM csv_uploads WHERE id = ?`, args: [newId] });
  assert.strictEqual(Number(newRow.rows[0].n), 0, 'no new upload row may exist (insert rolled back)');

  // NO new child rows (the one good insert rolled back too).
  const newChildren = await db.execute({ sql: `SELECT COUNT(*) AS n FROM crawl_urls WHERE csv_upload_id = ?`, args: [newId] });
  assert.strictEqual(Number(newChildren.rows[0].n), 0, 'no new child rows may exist (full rollback)');

  // Exactly ONE live upload for the key, and it is the prior.
  const live = await db.execute({
    sql: `SELECT id FROM csv_uploads WHERE client_id = ? AND month = ? AND detected_format = ? AND original_name = ? AND error IS NULL`,
    args: [CLIENT, MONTH, FORMAT, FILENAME],
  });
  assert.strictEqual(live.rows.length, 1, 'exactly one live upload for the key after rollback');
  assert.strictEqual(live.rows[0].id, priorId, 'the surviving live upload must be the prior one');
});

// ─── (b2) No-prior failure: rollback leaves the table untouched ───────────────
await test('(b2) FAILURE ROLLBACK with no prior upload: a failed batch leaves zero rows (no orphan)', async () => {
  const db = await freshDb();
  const newId = 'up_new';

  const sql = `INSERT INTO crawl_urls (id, client_id, csv_upload_id, month, url) VALUES (?, ?, ?, ?, ?)`;
  const parserStatements = [
    { sql, args: ['dup_id', CLIENT, newId, MONTH, 'https://x/new/0'] },
    { sql, args: ['dup_id', CLIENT, newId, MONTH, 'https://x/new/1'] },
  ];

  let threw = false;
  try {
    await runAtomicIngest(db, {
      clearStatements: [], // no prior
      uploadInsert: uploadInsertFor(newId),
      parserStatements,
      rowCountUpdate: rowCountUpdateFor(newId, parserStatements.length),
    });
  } catch { threw = true; }
  assert.ok(threw, 'batch must throw');

  const uploads = await db.execute(`SELECT COUNT(*) AS n FROM csv_uploads`);
  const children = await db.execute(`SELECT COUNT(*) AS n FROM crawl_urls`);
  assert.strictEqual(Number(uploads.rows[0].n), 0, 'no upload row after rollback');
  assert.strictEqual(Number(children.rows[0].n), 0, 'no child rows after rollback');
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
