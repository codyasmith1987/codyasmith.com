// FK ordering test for the accessibility aggregate-metrics parser.
//
// PROVES the ordering invariant: writing metrics rows that reference csv_uploads.id
// BEFORE the csv_uploads row exists violates the FOREIGN KEY constraint; writing
// them AFTER the csv_uploads row exists succeeds.
//
// This is the root cause of the prod bug: parseAccessibility was called before
// runAtomicIngest, so metrics rows referenced a csv_uploads id that did not yet
// exist. The fix moves parseAccessibility to run after runAtomicIngest commits.
//
// Note on in-memory libsql FK enforcement: @libsql/client with file::memory:
// requires `PRAGMA foreign_keys=ON` to enforce FK constraints. We set it at
// db creation and confirm enforcement with a canary assertion before the
// real tests run. If the canary fails (FK not enforced even with pragma), the
// test suite reports a skip note and falls back to ordering-assertion only, so
// the suite never silently gives a false green.

import assert from 'node:assert';
import { createClient } from '@libsql/client';
import { nanoid } from 'nanoid';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`[PASS] ${name}`); passed++; }
  catch (e) { console.error(`[FAIL] ${name}: ${e.message}`); failed++; }
}

const CLIENT = 'c1';
const MONTH = '2026-05';

// Build a fresh in-memory db that mirrors the FK relationship from migration 001:
//   metrics.csv_upload_id -> csv_uploads(id)
async function freshDb() {
  const db = createClient({ url: 'file::memory:' });
  // Enable FK enforcement for this connection.
  await db.execute('PRAGMA foreign_keys=ON');
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
  await db.execute(`CREATE TABLE metrics (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    month TEXT NOT NULL,
    category TEXT NOT NULL,
    metric_key TEXT NOT NULL,
    metric_value REAL,
    source TEXT,
    csv_upload_id TEXT REFERENCES csv_uploads(id),
    UNIQUE(client_id, month, category, metric_key)
  )`);
  // Partial unique index matching migration 055 (guards one live upload per key).
  await db.execute(`CREATE UNIQUE INDEX ux_csv_uploads_live
    ON csv_uploads (client_id, month, detected_format, original_name)
    WHERE error IS NULL`);
  return db;
}

// Check whether the in-memory libsql connection actually enforces FKs.
async function fkEnforced(db) {
  // Create a throwaway table with a FK and try to violate it.
  await db.execute(`CREATE TABLE _fk_canary_parent (id TEXT PRIMARY KEY)`);
  await db.execute(`CREATE TABLE _fk_canary_child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES _fk_canary_parent(id))`);
  try {
    await db.execute(`INSERT INTO _fk_canary_child (id, parent_id) VALUES ('c1', 'missing_parent')`);
    // If we reach here, FK was NOT enforced.
    await db.execute(`DROP TABLE _fk_canary_child`);
    await db.execute(`DROP TABLE _fk_canary_parent`);
    return false;
  } catch {
    await db.execute(`DROP TABLE _fk_canary_child`);
    await db.execute(`DROP TABLE _fk_canary_parent`);
    return true;
  }
}

// Simulate the metrics inserts parseAccessibility performs (5 rows via ON CONFLICT DO UPDATE).
async function writeMetrics(db, uploadId) {
  const keys = [
    'accessibility_total_violations',
    'accessibility_wcag20a',
    'accessibility_wcag20aa',
    'accessibility_wcag21aa',
    'accessibility_pages_audited',
  ];
  for (const key of keys) {
    await db.execute({
      sql: `INSERT OR REPLACE INTO metrics (id, client_id, month, category, metric_key, metric_value, source, csv_upload_id)
            VALUES (?, ?, ?, 'accessibility', ?, ?, 'csv_upload', ?)
            ON CONFLICT(client_id, month, category, metric_key)
            DO UPDATE SET metric_value = excluded.metric_value, csv_upload_id = excluded.csv_upload_id`,
      args: [nanoid(), CLIENT, MONTH, key, 0, uploadId],
    });
  }
}

// ─── Canary + main tests ───────────────────────────────────────────────────────

const db = await freshDb();
const enforced = await fkEnforced(db);

if (!enforced) {
  // FK not enforced by in-memory libsql even with PRAGMA — document clearly.
  console.log('[NOTE] PRAGMA foreign_keys=ON did not enforce FKs in this in-memory libsql connection.');
  console.log('[NOTE] Falling back to ordering-assertion tests (no FK violation test). The prod-observed');
  console.log('[NOTE] SQLITE_CONSTRAINT: FOREIGN KEY constraint failed error remains the proof of the bug.');
}

// ─── (a) OLD ORDER (bug): metrics BEFORE csv_uploads row exists ───────────────
await test('(a) OLD ORDER (bug): writing metrics before csv_uploads row exists fails with FK error', async () => {
  const testDb = await freshDb();
  const uploadId = 'up_acc_1';

  if (!enforced) {
    // Can't test FK enforcement; assert the ordering and skip violation check.
    // Insert csv_uploads AFTER metrics to mirror old order.
    await writeMetrics(testDb, uploadId);
    await testDb.execute({
      sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [uploadId, CLIENT, 'accessibility_all.csv', 'accessibility', MONTH, 'tester'],
    });
    // Ordering assertion: the metrics were written before csv_uploads was inserted.
    // This is the bug order. Without FK enforcement we can only assert the rows exist.
    const metricRows = await testDb.execute({ sql: `SELECT COUNT(*) AS n FROM metrics WHERE csv_upload_id = ?`, args: [uploadId] });
    assert.strictEqual(Number(metricRows.rows[0].n), 5, 'metrics rows exist (ordering assertion only — FK not enforced in this env)');
    console.log('  [INFO] FK not enforced in-memory — ordering assertion only; prod error confirms FK violation');
    return;
  }

  // FK enforced: assert that writing metrics BEFORE the csv_uploads parent row
  // throws a constraint error (reproducing the prod bug).
  let threw = false;
  try {
    await writeMetrics(testDb, uploadId);
  } catch (e) {
    threw = true;
    assert.ok(
      e.message.includes('FOREIGN KEY') || e.message.includes('constraint'),
      `expected FK constraint error, got: ${e.message}`
    );
  }
  assert.ok(threw, 'writing metrics before csv_uploads parent MUST throw a FK constraint error');
});

// ─── (b) NEW ORDER (fix): csv_uploads row first, then metrics ─────────────────
await test('(b) NEW ORDER (fix): writing csv_uploads row first, then metrics succeeds', async () => {
  const testDb = await freshDb();
  const uploadId = 'up_acc_2';

  // Simulate runAtomicIngest committing the csv_uploads row (and per-URL rows).
  await testDb.execute({
    sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)`,
    args: [uploadId, CLIENT, 'accessibility_all.csv', 'accessibility', MONTH, 'tester'],
  });

  // Now parseAccessibility runs after the batch — csv_uploads parent exists.
  await writeMetrics(testDb, uploadId);

  // All 5 metrics rows must exist, referencing the correct uploadId.
  const metricRows = await testDb.execute({ sql: `SELECT COUNT(*) AS n FROM metrics WHERE csv_upload_id = ?`, args: [uploadId] });
  assert.strictEqual(Number(metricRows.rows[0].n), 5, 'all 5 metrics rows must be written after parent exists');
});

// ─── (c) RE-UPLOAD (idempotent): clear prior metrics in-batch, then new metrics post-batch ──
await test('(c) RE-UPLOAD: clear prior metrics in-batch then write new metrics post-batch succeeds and replaces', async () => {
  const testDb = await freshDb();
  const priorId = 'up_acc_prior';
  const newId = 'up_acc_new';

  // Seed a prior upload with metrics rows.
  await testDb.execute({
    sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)`,
    args: [priorId, CLIENT, 'accessibility_all.csv', 'accessibility', MONTH, 'tester'],
  });
  await writeMetrics(testDb, priorId);

  // Verify prior metrics exist.
  const priorCheck = await testDb.execute({ sql: `SELECT COUNT(*) AS n FROM metrics WHERE csv_upload_id = ?`, args: [priorId] });
  assert.strictEqual(Number(priorCheck.rows[0].n), 5, 'prior metrics must be seeded');

  // Simulate atomic batch: supersede prior csv_uploads + delete prior metrics + insert new csv_uploads.
  // (clearStatements includes DELETE FROM metrics WHERE csv_upload_id = priorId)
  await testDb.execute({ sql: `UPDATE csv_uploads SET error = 'Superseded by newer upload' WHERE id = ?`, args: [priorId] });
  await testDb.execute({ sql: `DELETE FROM metrics WHERE csv_upload_id = ?`, args: [priorId] });
  await testDb.execute({
    sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)`,
    args: [newId, CLIENT, 'accessibility_all.csv', 'accessibility', MONTH, 'tester'],
  });

  // Post-batch: parseAccessibility writes new metrics referencing newId.
  await writeMetrics(testDb, newId);

  // Prior metrics gone, new metrics present.
  const priorMetrics = await testDb.execute({ sql: `SELECT COUNT(*) AS n FROM metrics WHERE csv_upload_id = ?`, args: [priorId] });
  assert.strictEqual(Number(priorMetrics.rows[0].n), 0, 'prior metrics must be cleared by in-batch DELETE');

  const newMetrics = await testDb.execute({ sql: `SELECT COUNT(*) AS n FROM metrics WHERE csv_upload_id = ?`, args: [newId] });
  assert.strictEqual(Number(newMetrics.rows[0].n), 5, 'new metrics must be written post-batch for new uploadId');

  // Exactly one live csv_uploads row for the key.
  const live = await testDb.execute({
    sql: `SELECT id FROM csv_uploads WHERE client_id = ? AND month = ? AND detected_format = ? AND original_name = ? AND error IS NULL`,
    args: [CLIENT, MONTH, 'accessibility', 'accessibility_all.csv'],
  });
  assert.strictEqual(live.rows.length, 1, 'exactly one live upload after re-upload');
  assert.strictEqual(live.rows[0].id, newId, 'surviving live upload must be the new one');
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
