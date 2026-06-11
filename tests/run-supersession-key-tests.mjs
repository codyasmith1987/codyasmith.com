import assert from 'node:assert';
import { createClient } from '@libsql/client';

let passed = 0, failed = 0;
function test(name, fn) {
  return fn().then(() => { console.log(`[PASS] ${name}`); passed++; })
    .catch(err => { console.error(`[FAIL] ${name}: ${err.message}`); failed++; });
}

// __clearPreviousDataForTest is a test-only re-export of the private
// clearPreviousData, parameterized to accept a db handle so we can run
// it against an in-memory libsql instance (no prod, no network).
const { __clearPreviousDataForTest } = await import('../src/lib/csv/index.ts');

async function seed() {
  // Each call to createClient with 'file::memory:' produces an isolated
  // in-memory SQLite database — no shared state between test cases.
  const db = createClient({ url: 'file::memory:' });
  await db.execute(`CREATE TABLE csv_uploads (id TEXT PRIMARY KEY, client_id TEXT, original_name TEXT, detected_format TEXT, month TEXT, row_count INTEGER, error TEXT, site_id TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE crawl_urls (id TEXT PRIMARY KEY, client_id TEXT, csv_upload_id TEXT, month TEXT, url TEXT)`);
  return db;
}

await test('clearPreviousData clears only the SAME filename, leaving sibling files intact', async () => {
  const db = await seed();
  // internal_all.csv prior upload with 3 rows
  await db.execute({ sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month) VALUES ('up_all','c1','internal_all.csv','crawl_internal','2026-05')`, args: [] });
  for (const u of ['a','b','c']) await db.execute({ sql: `INSERT INTO crawl_urls (id, client_id, csv_upload_id, month, url) VALUES (?, 'c1','up_all','2026-05', ?)`, args: [`r_${u}`, `https://x/${u}`] });
  // internal_html.csv prior upload with 1 row
  await db.execute({ sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month) VALUES ('up_html','c1','internal_html.csv','crawl_internal','2026-05')`, args: [] });
  await db.execute({ sql: `INSERT INTO crawl_urls (id, client_id, csv_upload_id, month, url) VALUES ('r_h','c1','up_html','2026-05','https://x/h')`, args: [] });

  // Simulate re-uploading internal_html.csv (new upload id 'up_html2').
  await db.execute({ sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month) VALUES ('up_html2','c1','internal_html.csv','crawl_internal','2026-05')`, args: [] });
  await __clearPreviousDataForTest(db, 'c1', '2026-05', 'crawl_internal', 'internal_html.csv', 'up_html2');

  const all = await db.execute(`SELECT COUNT(*) FROM crawl_urls WHERE csv_upload_id='up_all'`);
  const html = await db.execute(`SELECT COUNT(*) FROM crawl_urls WHERE csv_upload_id='up_html'`);
  assert.strictEqual(Number(all.rows[0][0]), 3, 'internal_all.csv rows MUST survive (different filename)');
  assert.strictEqual(Number(html.rows[0][0]), 0, 'prior internal_html.csv rows should be cleared (same filename)');
});

await test('partial unique index allows one LIVE upload per key, rejects a second live duplicate', async () => {
  const db = await seed();
  await db.execute(`CREATE UNIQUE INDEX ux_csv_uploads_live ON csv_uploads (client_id, month, detected_format, original_name) WHERE error IS NULL`);
  await db.execute({ sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month) VALUES ('u1','c1','internal_all.csv','crawl_internal','2026-05')`, args: [] });
  let rejected = false;
  try {
    await db.execute({ sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month) VALUES ('u2','c1','internal_all.csv','crawl_internal','2026-05')`, args: [] });
  } catch { rejected = true; }
  assert.ok(rejected, 'second LIVE upload of same key must be rejected by the partial unique index');
  // After superseding u1 (set error), a new live row IS allowed (re-upload works):
  await db.execute(`UPDATE csv_uploads SET error='Superseded by newer upload' WHERE id='u1'`);
  await db.execute({ sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month) VALUES ('u3','c1','internal_all.csv','crawl_internal','2026-05')`, args: [] });
  const live = await db.execute(`SELECT COUNT(*) FROM csv_uploads WHERE client_id='c1' AND original_name='internal_all.csv' AND error IS NULL`);
  assert.strictEqual(Number(live.rows[0][0]), 1, 'exactly one live upload after supersede + re-upload');
});

// ─── Rollback ordering regression ───────────────────────────────────────────
//
// Reproduces the data-loss bug introduced when the supersede-before-insert
// reorder was added without updating the catch block. The partial unique index
// ux_csv_uploads_live enforces at most ONE row with error IS NULL per
// (client_id, month, detected_format, original_name). On parse failure the
// catch block must:
//   1. Error the NEW (failed) upload → removes it from the index.
//   2. THEN restore the prior superseded upload to error IS NULL → safe,
//      only one live row exists.
// The OLD (buggy) order did step 2 before step 1, causing a UNIQUE violation
// that aborted the whole rollback and left the prior row stuck superseded
// with its child rows already deleted.

async function seedWithIndex() {
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
  await db.execute(`CREATE UNIQUE INDEX ux_csv_uploads_live
    ON csv_uploads (client_id, month, detected_format, original_name)
    WHERE error IS NULL`);
  return db;
}

await test('FIXED rollback order: error new row first, then restore prior — no unique violation', async () => {
  const db = await seedWithIndex();

  // Insert a prior live upload (the "good" upload that was superseded).
  await db.execute({
    sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month) VALUES ('prior','c1','report.csv','crawl_internal','2026-05')`,
    args: [],
  });

  // Simulate the supersede step: prior row is marked superseded.
  await db.execute({
    sql: `UPDATE csv_uploads SET error = 'Superseded by newer upload' WHERE id = 'prior'`,
    args: [],
  });

  // Insert the new (failed) upload row — it is currently live (error IS NULL).
  await db.execute({
    sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month) VALUES ('newup','c1','report.csv','crawl_internal','2026-05')`,
    args: [],
  });

  // FIXED ORDER: error the new row first, then restore prior.
  // Step 1 — new row leaves the index.
  await db.execute({
    sql: `UPDATE csv_uploads SET error = 'parse failed' WHERE id = 'newup'`,
    args: [],
  });
  // Step 2 — prior row re-enters the index; safe now.
  await db.execute({
    sql: `UPDATE csv_uploads SET error = NULL WHERE id = 'prior'`,
    args: [],
  });

  const live = await db.execute(
    `SELECT id, error FROM csv_uploads WHERE client_id='c1' AND original_name='report.csv' AND error IS NULL`,
  );
  assert.strictEqual(live.rows.length, 1, 'exactly one live row after rollback');
  assert.strictEqual(live.rows[0][0], 'prior', 'the live row must be the restored prior upload');

  const newRow = await db.execute(`SELECT error FROM csv_uploads WHERE id = 'newup'`);
  assert.strictEqual(newRow.rows[0][0], 'parse failed', 'the new (failed) row must be errored');
});

await test('INVERSE assertion: OLD buggy order (restore prior while new still live) throws unique violation', async () => {
  const db = await seedWithIndex();

  // Same setup: prior superseded, new row live.
  await db.execute({
    sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month) VALUES ('prior2','c1','report.csv','crawl_internal','2026-06')`,
    args: [],
  });
  await db.execute({
    sql: `UPDATE csv_uploads SET error = 'Superseded by newer upload' WHERE id = 'prior2'`,
    args: [],
  });
  await db.execute({
    sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month) VALUES ('newup2','c1','report.csv','crawl_internal','2026-06')`,
    args: [],
  });

  // OLD (buggy) order: attempt to restore prior while the new row is STILL live.
  // This must throw a UNIQUE constraint violation — that's exactly the bug.
  let threw = false;
  try {
    await db.execute({
      sql: `UPDATE csv_uploads SET error = NULL WHERE id = 'prior2'`,
      args: [],
    });
  } catch (e) {
    threw = true;
    assert.ok(
      e.message?.includes('UNIQUE') || e.message?.includes('unique'),
      `expected a UNIQUE constraint error, got: ${e.message}`,
    );
  }
  assert.ok(threw, 'restoring prior row while new row is still live MUST violate the partial unique index');
});

// ─── Site-aware key (multi-site Phase 1, migration 070) ─────────────────────
//
// Two sites of ONE client share filenames (GA4 snapshots, GSC Queries.csv...).
// Before site keying, the second site's upload superseded the first site's
// data — silent loss. The key now includes COALESCE(site_id,'') so the same
// filename lives once PER SITE per month, while a re-upload for the SAME site
// still supersedes its own prior row. NULL = the client's primary site.

await test("a DIFFERENT site's same-named upload does NOT supersede this site's data", async () => {
  const db = await seed();
  // Primary site's upload (site_id NULL) with a child row.
  await db.execute({ sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month, site_id) VALUES ('up_zkh','c1','data-export.csv','crawl_internal','2026-06', NULL)`, args: [] });
  await db.execute({ sql: `INSERT INTO crawl_urls (id, client_id, csv_upload_id, month, url) VALUES ('r_zkh','c1','up_zkh','2026-06','https://zkh/x')`, args: [] });
  // Second site uploads the SAME filename, same month, same format.
  await db.execute({ sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month, site_id) VALUES ('up_mvp','c1','data-export.csv','crawl_internal','2026-06','site-mvp')`, args: [] });
  await __clearPreviousDataForTest(db, 'c1', '2026-06', 'crawl_internal', 'data-export.csv', 'up_mvp', 'site-mvp');

  const zkhRows = await db.execute(`SELECT COUNT(*) FROM crawl_urls WHERE csv_upload_id='up_zkh'`);
  const zkhLive = await db.execute(`SELECT COUNT(*) FROM csv_uploads WHERE id='up_zkh' AND error IS NULL`);
  assert.strictEqual(Number(zkhRows.rows[0][0]), 1, "the OTHER site's child rows must survive");
  assert.strictEqual(Number(zkhLive.rows[0][0]), 1, "the OTHER site's upload row must stay live");
});

await test("a re-upload for the SAME site still supersedes that site's prior row", async () => {
  const db = await seed();
  await db.execute({ sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month, site_id) VALUES ('up_mvp1','c1','data-export.csv','crawl_internal','2026-06','site-mvp')`, args: [] });
  await db.execute({ sql: `INSERT INTO crawl_urls (id, client_id, csv_upload_id, month, url) VALUES ('r_mvp','c1','up_mvp1','2026-06','https://mvp/x')`, args: [] });
  await db.execute({ sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month, site_id) VALUES ('up_mvp2','c1','data-export.csv','crawl_internal','2026-06','site-mvp')`, args: [] });
  await __clearPreviousDataForTest(db, 'c1', '2026-06', 'crawl_internal', 'data-export.csv', 'up_mvp2', 'site-mvp');

  const prior = await db.execute(`SELECT error FROM csv_uploads WHERE id='up_mvp1'`);
  const rows = await db.execute(`SELECT COUNT(*) FROM crawl_urls WHERE csv_upload_id='up_mvp1'`);
  assert.ok(prior.rows[0][0], "same site's prior upload must be superseded");
  assert.strictEqual(Number(rows.rows[0][0]), 0, "same site's prior child rows must be cleared");
});

await test('the site-aware live unique index allows the same filename once PER SITE, still one per site', async () => {
  const db = await seed();
  await db.execute(`CREATE UNIQUE INDEX ux_csv_uploads_live ON csv_uploads (client_id, month, detected_format, original_name, COALESCE(site_id, '')) WHERE error IS NULL`);
  // Same key, two sites: both live — allowed.
  await db.execute({ sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month, site_id) VALUES ('a','c1','Queries.csv','gsc_queries','2026-06', NULL)`, args: [] });
  await db.execute({ sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month, site_id) VALUES ('b','c1','Queries.csv','gsc_queries','2026-06','site-mvp')`, args: [] });
  // A second LIVE row for the SAME site is still rejected.
  let rejected = false;
  try {
    await db.execute({ sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month, site_id) VALUES ('c','c1','Queries.csv','gsc_queries','2026-06','site-mvp')`, args: [] });
  } catch { rejected = true; }
  assert.ok(rejected, 'second live upload of the same key for the SAME site must be rejected');
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
