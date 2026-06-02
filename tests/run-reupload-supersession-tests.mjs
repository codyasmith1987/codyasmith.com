// Reproduces the real "A concurrent upload of this file is already being
// processed" wall hit on a 155-file ZKH folder reupload.
//
// ROOT CAUSE: collectClearStatements() used to return early with empty
// statements whenever FORMAT_SOURCES[format] was undefined. Formats kept OUT of
// FORMAT_SOURCES on purpose (links, issue_urls) therefore NEVER superseded
// their own prior LIVE csv_uploads row. On a re-upload the new INSERT collided
// with the stale live row on the partial unique index ux_csv_uploads_live
// (client_id, month, detected_format, original_name) and was rejected.
//
// THE FIX: the UPLOAD-ROW supersession is now universal (runs for every
// format), while DATA-TABLE clearing stays scoped to FORMAT_SOURCES. So a
// re-upload of a 'links' or 'issue_urls' file supersedes its own prior live
// row (freeing the unique index slot) without touching sibling files' data.
//
// We exercise the real seam (__clearPreviousDataForTest -> clearPreviousData
// -> collectClearStatements) against an in-memory libsql db that mirrors the
// migration 055 DDL plus link_graph.

import assert from 'node:assert';
import { createClient } from '@libsql/client';

let passed = 0, failed = 0;
function test(name, fn) {
  return fn()
    .then(() => { console.log(`[PASS] ${name}`); passed++; })
    .catch(err => { console.error(`[FAIL] ${name}: ${err.message}`); failed++; });
}

const { __clearPreviousDataForTest } = await import('../src/lib/csv/index.ts');

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
  // Exact DDL shape from migration 055.
  await db.execute(`CREATE UNIQUE INDEX ux_csv_uploads_live
    ON csv_uploads (client_id, month, detected_format, original_name)
    WHERE error IS NULL`);
  // link_graph mirror (the columns the 'links' parser touches for dedup).
  await db.execute(`CREATE TABLE link_graph (
    id TEXT PRIMARY KEY,
    client_id TEXT,
    csv_upload_id TEXT,
    month TEXT,
    source_file TEXT
  )`);
  return db;
}

// (a) The bug: a 'links' (non-FORMAT_SOURCES) re-upload must supersede its own
// prior LIVE row so the new INSERT for the SAME key succeeds.
await test('links re-upload supersedes its own prior live row so the new INSERT does not hit UNIQUE', async () => {
  const db = await seed();

  // Prior LIVE upload for format 'links', original_name 'X/all_outlinks.csv'.
  await db.execute({
    sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month)
          VALUES ('prev', 'c1', 'X/all_outlinks.csv', 'links', '2026-05')`,
    args: [],
  });

  // The re-upload mints a new id and runs the supersession seam BEFORE its INSERT.
  const newId = 'new';
  const cleared = await __clearPreviousDataForTest(
    db, 'c1', '2026-05', 'links', 'X/all_outlinks.csv', newId,
  );

  // The seam must identify and supersede the prior live row.
  assert.strictEqual(cleared, 'prev', 'the prior live links row must be returned as superseded');
  const prevRow = await db.execute(`SELECT error FROM csv_uploads WHERE id = 'prev'`);
  assert.strictEqual(prevRow.rows[0][0], 'Superseded by newer upload', 'prior links row must be marked superseded');

  // Now the new INSERT for the SAME key must succeed (slot is free).
  let threw = false;
  try {
    await db.execute({
      sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month)
            VALUES (?, 'c1', 'X/all_outlinks.csv', 'links', '2026-05')`,
      args: [newId],
    });
  } catch (e) {
    threw = true;
    console.error('Unexpected UNIQUE violation on links re-upload:', e.message);
  }
  assert.ok(!threw, 'new links INSERT must succeed after the prior live row is superseded');

  const live = await db.execute(
    `SELECT id FROM csv_uploads WHERE client_id='c1' AND month='2026-05' AND detected_format='links' AND original_name='X/all_outlinks.csv' AND error IS NULL`,
  );
  assert.strictEqual(live.rows.length, 1, 'exactly one live links row after re-upload');
  assert.strictEqual(String(live.rows[0][0]), newId, 'the live row must be the new upload');
});

// (a-inverse) Prove the bug is real: with NO supersession (the old behavior for
// non-FORMAT_SOURCES formats), the prior row stays live and the new INSERT
// throws a UNIQUE violation. This is the failure the fix removes.
await test('INVERSE: skipping supersession (old behavior) leaves prior live and new INSERT throws UNIQUE', async () => {
  const db = await seed();

  await db.execute({
    sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month)
          VALUES ('prev', 'c1', 'X/all_outlinks.csv', 'links', '2026-05')`,
    args: [],
  });

  // Simulate the OLD code path: collectClearStatements returned empty for a
  // non-FORMAT_SOURCES format, so NO supersede ran. Prior row stays live.
  let threw = false;
  try {
    await db.execute({
      sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month)
            VALUES ('new', 'c1', 'X/all_outlinks.csv', 'links', '2026-05')`,
      args: [],
    });
  } catch (e) {
    threw = true;
    assert.ok(
      e.message?.toLowerCase().includes('unique'),
      `expected a UNIQUE constraint error, got: ${e.message}`,
    );
  }
  assert.ok(threw, 'without supersession the new INSERT MUST collide with the stale live row (the real bug)');
});

// (b) Sibling coexistence: processing 'X/h2_missing.csv' (issue_urls) must NOT
// supersede the live 'X/h1_missing.csv' row (different original_name).
await test('issue_urls siblings coexist: processing h2_missing.csv does not supersede h1_missing.csv', async () => {
  const db = await seed();

  // Two distinct live issue_urls files in the same month.
  await db.execute({
    sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month)
          VALUES ('h1', 'c1', 'X/h1_missing.csv', 'issue_urls', '2026-05')`,
    args: [],
  });
  await db.execute({
    sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month)
          VALUES ('h2', 'c1', 'X/h2_missing.csv', 'issue_urls', '2026-05')`,
    args: [],
  });

  // Re-upload h2_missing.csv (new id). The seam runs for h2 only.
  const cleared = await __clearPreviousDataForTest(
    db, 'c1', '2026-05', 'issue_urls', 'X/h2_missing.csv', 'h2new',
  );

  assert.strictEqual(cleared, 'h2', 'only the prior h2_missing.csv row should be superseded');

  const h1 = await db.execute(`SELECT error FROM csv_uploads WHERE id = 'h1'`);
  assert.strictEqual(h1.rows[0][0], null, 'sibling h1_missing.csv must remain LIVE (untouched)');

  const h2 = await db.execute(`SELECT error FROM csv_uploads WHERE id = 'h2'`);
  assert.strictEqual(h2.rows[0][0], 'Superseded by newer upload', 'prior h2_missing.csv must be superseded');
});

// (c) No prior row -> no statements, no supersession (clean first upload).
await test('first upload of a links file with no prior row supersedes nothing', async () => {
  const db = await seed();
  const cleared = await __clearPreviousDataForTest(
    db, 'c1', '2026-05', 'links', 'X/all_outlinks.csv', 'first',
  );
  assert.strictEqual(cleared, null, 'no prior row -> nothing superseded');
});

// (d) FORMAT_SOURCES formats still get BOTH the data-table DELETE and the
// supersede (universal supersession must not regress Class-A/Class-B-tracked).
await test('FORMAT_SOURCES format still clears its data table AND supersedes the prior row', async () => {
  const db = await seed();
  await db.execute(`CREATE TABLE crawl_urls (id TEXT PRIMARY KEY, client_id TEXT, csv_upload_id TEXT, month TEXT, url TEXT)`);

  await db.execute({
    sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month)
          VALUES ('cprev', 'c1', 'internal_all.csv', 'crawl_internal', '2026-05')`,
    args: [],
  });
  for (const u of ['a', 'b', 'c']) {
    await db.execute({
      sql: `INSERT INTO crawl_urls (id, client_id, csv_upload_id, month, url) VALUES (?, 'c1', 'cprev', '2026-05', ?)`,
      args: [`r_${u}`, `https://x/${u}`],
    });
  }

  const cleared = await __clearPreviousDataForTest(
    db, 'c1', '2026-05', 'crawl_internal', 'internal_all.csv', 'cnew',
  );

  assert.strictEqual(cleared, 'cprev', 'prior crawl_internal row superseded');
  const rows = await db.execute(`SELECT COUNT(*) FROM crawl_urls WHERE csv_upload_id = 'cprev'`);
  assert.strictEqual(Number(rows.rows[0][0]), 0, 'prior crawl_urls rows must be cleared (FORMAT_SOURCES data sweep)');
  const prev = await db.execute(`SELECT error FROM csv_uploads WHERE id = 'cprev'`);
  assert.strictEqual(prev.rows[0][0], 'Superseded by newer upload', 'prior crawl_internal upload superseded');
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
