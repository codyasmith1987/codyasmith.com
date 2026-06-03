// Reparse-stored backfill tests (per
// docs/superpowers/plans/2026-06-02-reparse-stored-backfill.md).
//
// PROVES: reparseStoredChunk walks raw_csv_data rows, re-detects each
// stored file through the CURRENT detector, and for files that now have
// a typed parser it (1) calls the injected ingestFn with the verbatim
// raw + the row's client/month/filename + the 'reparse-backfill' tag,
// and (2) supersedes the OLD unknown_stored csv_uploads row by setting
// its error (only WHERE error IS NULL — idempotent). Files that still
// detect as 'unknown' are skipped: ingestFn is NOT called and their
// upload row is untouched. A row whose ingestFn throws is recorded in
// errors[] and the loop keeps going.
//
// Oracle: hand-reasoned truth set up here. No prod, no network, no Turso
// credentials. The real ingestCSV + turso singleton are NEVER called —
// reparseStoredChunk takes db + ingestFn as injectable params, and we
// pass an in-memory libsql db plus a spy ingestFn so importing the module
// under tsx never touches import.meta.env.

import assert from 'node:assert';
import { createClient } from '@libsql/client';
import { reparseStoredChunk } from '../src/lib/csv/reparse-stored.ts';

let passed = 0, failed = 0;
async function test(n, f) {
  try { await f(); console.log(`[PASS] ${n}`); passed++; }
  catch (e) { console.error(`[FAIL] ${n}: ${e.message}`); failed++; }
}

const CLIENT = 'c1';
const MONTH = '2026-05';

// A real canonicals_all.csv header signature: the detector routes this to
// 'canonicals' (Address + Occurrences + Canonical Link Element 1 + rel="next" 1).
const CANONICALS_RAW =
  'Address,Occurrences,Canonical Link Element 1,"rel=""next"" 1"\n' +
  'https://example.com/,1,https://example.com/,\n' +
  'https://example.com/about,1,https://example.com/about,\n';

// With the universal-capture fallback, ANY CSV-shaped file routes to
// sf_generic (and IS ingested), so a file like pagespeed_all.csv is no
// longer "unknown". Only input that does not parse as a CSV at all (no
// extractable rows) still detects as 'unknown' and must be skipped by
// reparse. An empty body is the clean trigger for that path.
const NON_CSV_RAW = '';

// Fresh in-memory db with the two tables reparse touches: raw_csv_data
// (source rows) and csv_uploads (the unknown_stored rows it supersedes),
// plus the partial unique index that guards one-live-upload-per-key.
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
  await db.execute(`CREATE TABLE raw_csv_data (
    id TEXT PRIMARY KEY,
    client_id TEXT,
    csv_upload_id TEXT,
    month TEXT,
    filename TEXT,
    headers TEXT,
    row_count INTEGER,
    raw_text TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  await db.execute(`CREATE UNIQUE INDEX ux_csv_uploads_live
    ON csv_uploads (client_id, month, detected_format, original_name)
    WHERE error IS NULL`);
  return db;
}

// Seed an unknown_stored upload row + its raw_csv_data row, the way a
// pre-parser upload landed. ordinal feeds created_at so ORDER BY is stable.
async function seedStored(db, { uploadId, rawId, filename, raw, ordinal }) {
  await db.execute({
    sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month, uploaded_by, row_count, error, created_at)
          VALUES (?, ?, ?, 'unknown_stored', ?, 'tester', ?, NULL, ?)`,
    args: [uploadId, CLIENT, filename, MONTH, 1, `2026-05-01 00:00:0${ordinal}`],
  });
  await db.execute({
    sql: `INSERT INTO raw_csv_data (id, client_id, csv_upload_id, month, filename, headers, row_count, raw_text, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [rawId, CLIENT, uploadId, MONTH, filename, '[]', 1, raw, `2026-05-01 00:00:0${ordinal}`],
  });
}

// Spy ingestFn: records each call; behavior controllable per filename.
function makeSpy({ throwOn, returnErrorOn } = {}) {
  const calls = [];
  const fn = async (raw, clientId, month, filename, uploadedBy) => {
    calls.push({ raw, clientId, month, filename, uploadedBy });
    if (throwOn && filename === throwOn) {
      throw new Error(`boom on ${filename}`);
    }
    if (returnErrorOn && filename === returnErrorOn) {
      // The REAL ingestCSV contract: it catches its own DB errors (FK
      // violations, racing unique index) and RETURNS { error } rather than
      // throwing. reparse must treat this as a failure, not a success.
      return { uploadId: 'new_' + filename, format: 'unknown', rowCount: 0, headers: [], error: 'FOREIGN KEY constraint failed' };
    }
    return { uploadId: 'new_' + filename, format: 'canonicals', rowCount: 2, headers: [] };
  };
  return { fn, calls };
}

// ─── (1) canonicals raw -> ingest called + unknown_stored superseded ─────────
await test('(1) typed file: ingestFn called with verbatim raw + reparse-backfill tag, old unknown_stored row superseded', async () => {
  const db = await freshDb();
  await seedStored(db, { uploadId: 'up_can', rawId: 'raw_can', filename: 'canonicals_all.csv', raw: CANONICALS_RAW, ordinal: 1 });
  const spy = makeSpy();

  const summary = await reparseStoredChunk(db, { limit: 25, offset: 0, uploadedBy: 'u_admin' }, spy.fn);

  // ingestFn called exactly once, with the row's raw/client/month/filename
  // and the 'reparse-backfill' tag.
  assert.strictEqual(spy.calls.length, 1, 'ingestFn must be called once');
  assert.strictEqual(spy.calls[0].raw, CANONICALS_RAW, 'raw passed verbatim');
  assert.strictEqual(spy.calls[0].clientId, CLIENT, 'client_id from the row');
  assert.strictEqual(spy.calls[0].month, MONTH, 'month from the row');
  assert.strictEqual(spy.calls[0].filename, 'canonicals_all.csv', 'filename from the row');
  assert.strictEqual(spy.calls[0].uploadedBy, 'u_admin', 'uploadedBy threaded as the real admin user id (NOT a literal tag — it is a NOT NULL FK to users)');

  // Summary reflects one retyped, zero skipped, zero errors.
  assert.strictEqual(summary.processed, 1, 'processed = 1');
  assert.strictEqual(summary.skippedUnknown, 0, 'skippedUnknown = 0');
  assert.strictEqual(summary.errors.length, 0, 'no errors');
  assert.strictEqual(summary.retyped.length, 1, 'one retyped entry');
  assert.strictEqual(summary.retyped[0].format, 'canonicals', 'retyped format');
  assert.strictEqual(summary.retyped[0].filename, 'canonicals_all.csv', 'retyped filename');

  // Old unknown_stored upload row superseded (error set).
  const up = await db.execute({ sql: `SELECT error FROM csv_uploads WHERE id = ?`, args: ['up_can'] });
  assert.ok(/reparsed into canonicals/i.test(String(up.rows[0].error)), 'old upload row error names the format');

  // Raw row KEPT (non-destructive).
  const raw = await db.execute({ sql: `SELECT COUNT(*) AS n FROM raw_csv_data WHERE id = ?`, args: ['raw_can'] });
  assert.strictEqual(Number(raw.rows[0].n), 1, 'raw_csv_data row preserved');
});

// ─── (2) genuinely non-CSV raw -> skipped, ingest NOT called, upload untouched ─
await test('(2) non-CSV file (still detects unknown): skippedUnknown++, ingestFn NOT called, upload row untouched', async () => {
  const db = await freshDb();
  await seedStored(db, { uploadId: 'up_ps', rawId: 'raw_ps', filename: 'broken.csv', raw: NON_CSV_RAW, ordinal: 1 });
  const spy = makeSpy();

  const summary = await reparseStoredChunk(db, { limit: 25, offset: 0, uploadedBy: 'u_admin' }, spy.fn);

  assert.strictEqual(spy.calls.length, 0, 'ingestFn must NOT be called for unknown');
  assert.strictEqual(summary.processed, 1, 'processed = 1');
  assert.strictEqual(summary.skippedUnknown, 1, 'skippedUnknown = 1');
  assert.strictEqual(summary.retyped.length, 0, 'nothing retyped');
  assert.strictEqual(summary.errors.length, 0, 'no errors');

  // Upload row error still NULL (untouched).
  const up = await db.execute({ sql: `SELECT error FROM csv_uploads WHERE id = ?`, args: ['up_ps'] });
  assert.strictEqual(up.rows[0].error, null, 'unknown upload row left untouched');
});

// ─── (3) idempotent re-run: no double-supersede, no error ────────────────────
await test('(3) idempotent: second pass over an already-retyped row does not double-supersede and does not error', async () => {
  const db = await freshDb();
  await seedStored(db, { uploadId: 'up_can', rawId: 'raw_can', filename: 'canonicals_all.csv', raw: CANONICALS_RAW, ordinal: 1 });
  const spy = makeSpy();

  // First pass supersedes the upload row.
  await reparseStoredChunk(db, { limit: 25, offset: 0, uploadedBy: 'u_admin' }, spy.fn);
  const afterFirst = await db.execute({ sql: `SELECT error FROM csv_uploads WHERE id = ?`, args: ['up_can'] });
  const firstError = String(afterFirst.rows[0].error);
  assert.ok(/reparsed into/i.test(firstError), 'superseded on first pass');

  // Second pass: ingestFn runs again (typed path self-supersedes its own
  // upload by key — no dupes), but the unknown_stored UPDATE is a no-op
  // because error IS NULL no longer matches. No throw.
  const summary2 = await reparseStoredChunk(db, { limit: 25, offset: 0, uploadedBy: 'u_admin' }, spy.fn);
  assert.strictEqual(summary2.errors.length, 0, 'no errors on idempotent re-run');
  assert.strictEqual(summary2.retyped.length, 1, 'still routed as typed on re-run');

  // Error string unchanged (not double-appended / re-marked).
  const afterSecond = await db.execute({ sql: `SELECT error FROM csv_uploads WHERE id = ?`, args: ['up_can'] });
  assert.strictEqual(String(afterSecond.rows[0].error), firstError, 'error not changed by the no-op second pass');
});

// ─── (4) ingestFn throws -> recorded in errors[], loop continues ─────────────
await test('(4) one row whose ingestFn throws is recorded in errors[]; the loop continues to the next row', async () => {
  const db = await freshDb();
  // Two typed rows; the first one's ingestFn throws, the second succeeds.
  await seedStored(db, { uploadId: 'up_bad', rawId: 'raw_bad', filename: 'directives_all.csv', raw: CANONICALS_RAW, ordinal: 1 });
  await seedStored(db, { uploadId: 'up_ok', rawId: 'raw_ok', filename: 'canonicals_all.csv', raw: CANONICALS_RAW, ordinal: 2 });
  const spy = makeSpy({ throwOn: 'directives_all.csv' });

  const summary = await reparseStoredChunk(db, { limit: 25, offset: 0, uploadedBy: 'u_admin' }, spy.fn);

  // Both rows attempted; the second succeeded after the first threw.
  assert.strictEqual(spy.calls.length, 2, 'ingestFn attempted on both typed rows');
  assert.strictEqual(summary.processed, 2, 'processed = 2');
  assert.strictEqual(summary.errors.length, 1, 'one error recorded');
  assert.strictEqual(summary.errors[0].filename, 'directives_all.csv', 'error names the bad file');
  assert.ok(/boom/.test(summary.errors[0].error), 'error carries the thrown message');
  assert.strictEqual(summary.retyped.length, 1, 'the good row still retyped');
  assert.strictEqual(summary.retyped[0].filename, 'canonicals_all.csv', 'good row retyped');

  // The bad row's upload was NOT superseded (ingest threw before supersede).
  const bad = await db.execute({ sql: `SELECT error FROM csv_uploads WHERE id = ?`, args: ['up_bad'] });
  assert.strictEqual(bad.rows[0].error, null, 'bad row upload not superseded (ingest threw first)');

  // The good row's upload WAS superseded.
  const ok = await db.execute({ sql: `SELECT error FROM csv_uploads WHERE id = ?`, args: ['up_ok'] });
  assert.ok(/reparsed into/i.test(String(ok.rows[0].error)), 'good row upload superseded');
});

// ─── (5) ingestFn RETURNS { error } -> errors[], NOT retyped, upload NOT superseded ──
// Regression guard for the bug that hid the uploaded_by FK failure: ingestCSV
// catches DB errors and RETURNS { error } instead of throwing, so the throw-only
// catch never fired and a failed ingest was counted as retyped + superseded the
// raw row (data vanished from "unknown" without ever landing).
await test('(5) ingestFn returns { error } (real ingestCSV contract): recorded in errors[], NOT retyped, raw upload NOT superseded', async () => {
  const db = await freshDb();
  await seedStored(db, { uploadId: 'up_fk', rawId: 'raw_fk', filename: 'canonicals_all.csv', raw: CANONICALS_RAW, ordinal: 1 });
  const spy = makeSpy({ returnErrorOn: 'canonicals_all.csv' });

  const summary = await reparseStoredChunk(db, { limit: 25, offset: 0, uploadedBy: 'u_admin' }, spy.fn);

  assert.strictEqual(spy.calls.length, 1, 'ingestFn called once');
  assert.strictEqual(summary.retyped.length, 0, 'a returned-error ingest is NOT counted as retyped');
  assert.strictEqual(summary.errors.length, 1, 'returned error recorded in errors[]');
  assert.strictEqual(summary.errors[0].filename, 'canonicals_all.csv', 'error names the file');
  assert.ok(/foreign key/i.test(summary.errors[0].error), 'error carries the returned message');

  // The unknown_stored upload row must stay LIVE — the data never landed, so
  // the file must keep showing as stored/unparsed, not silently disappear.
  const up = await db.execute({ sql: `SELECT error FROM csv_uploads WHERE id = ?`, args: ['up_fk'] });
  assert.strictEqual(up.rows[0].error, null, 'upload row left live (not superseded) on a returned error');
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
