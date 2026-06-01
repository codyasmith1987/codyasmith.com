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
  await db.execute(`CREATE TABLE csv_uploads (id TEXT PRIMARY KEY, client_id TEXT, original_name TEXT, detected_format TEXT, month TEXT, row_count INTEGER, error TEXT, created_at TEXT DEFAULT (datetime('now')))`);
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

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
