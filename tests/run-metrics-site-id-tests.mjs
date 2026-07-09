// Per-site keying for metrics + site_issues (migration 075).
//
// PROVES the fix for the cross-site overwrite: with the new
// COALESCE(site_id,'') unique indexes, a secondary site's metric/issue with
// the SAME (client, month, category, metric_key)/(issue_name) as the primary
// COEXISTS instead of overwriting it, while a re-upload from the SAME site
// supersedes its own row. Uses the EXACT INSERT...ON CONFLICT SQL the parsers
// run, against an in-memory libsql db whose schema mirrors migration 075's
// output — so a drift between the parser ON CONFLICT target and the index
// expression fails here, not on prod.

import assert from 'node:assert';
import { createClient } from '@libsql/client';

let passed = 0, failed = 0;
async function test(n, f) {
  try { await f(); console.log(`[PASS] ${n}`); passed++; }
  catch (e) { console.error(`[FAIL] ${n}: ${e.message}`); failed++; }
}

const CLIENT = 'c1', MONTH = '2026-06';
const PRIMARY = null;            // primary site stores NULL (NULL = primary)
const MVP = 'site_mvp';          // a secondary site

// Schema mirroring migration 075's end state.
async function freshDb() {
  const db = createClient({ url: 'file::memory:' });
  await db.execute(`CREATE TABLE metrics (
    id TEXT PRIMARY KEY, client_id TEXT NOT NULL, month TEXT NOT NULL,
    category TEXT NOT NULL, metric_key TEXT NOT NULL, metric_value REAL NOT NULL,
    source TEXT, csv_upload_id TEXT, site_id TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  await db.execute(`CREATE UNIQUE INDEX ux_metrics_site ON metrics(client_id, month, category, metric_key, COALESCE(site_id, ''))`);
  await db.execute(`CREATE TABLE site_issues (
    id TEXT PRIMARY KEY, client_id TEXT NOT NULL, month TEXT NOT NULL, issue_name TEXT NOT NULL,
    issue_type TEXT, priority TEXT, affected_urls INTEGER, pct_of_total REAL,
    description TEXT, how_to_fix TEXT, csv_upload_id TEXT, site_id TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  await db.execute(`CREATE UNIQUE INDEX ux_site_issues_name_site ON site_issues(client_id, month, issue_name, COALESCE(site_id, ''))`);
  return db;
}

// The exact metric upsert the crawl-overview/accessibility/image/issues parsers run.
const METRIC_SQL = `INSERT INTO metrics (id, client_id, month, category, metric_key, metric_value, source, csv_upload_id, site_id)
  VALUES (?, ?, ?, ?, ?, ?, 'csv_upload', ?, ?)
  ON CONFLICT(client_id, month, category, metric_key, COALESCE(site_id, ''))
  DO UPDATE SET metric_value = excluded.metric_value, csv_upload_id = excluded.csv_upload_id`;
const writeMetric = (db, id, category, key, value, uploadId, siteId) =>
  db.execute({ sql: METRIC_SQL, args: [id, CLIENT, MONTH, category, key, value, uploadId, siteId] });

const ISSUE_SQL = `INSERT INTO site_issues (id, client_id, month, issue_name, issue_type, priority, affected_urls, pct_of_total, description, how_to_fix, csv_upload_id, site_id)
  VALUES (?, ?, ?, ?, 'audit', 'medium', ?, ?, ?, ?, ?, ?)
  ON CONFLICT(client_id, month, issue_name, COALESCE(site_id, ''))
  DO UPDATE SET affected_urls = excluded.affected_urls, csv_upload_id = excluded.csv_upload_id`;
const writeIssue = (db, id, name, affected, uploadId, siteId) =>
  db.execute({ sql: ISSUE_SQL, args: [id, CLIENT, MONTH, name, affected, null, `${affected} urls`, null, uploadId, siteId] });

await test('(1) two sites, SAME metric key COEXIST (the overwrite is gone)', async () => {
  const db = await freshDb();
  await writeMetric(db, 'm1', 'crawl', 'total_urls', 62, 'up_zkh', PRIMARY);
  await writeMetric(db, 'm2', 'crawl', 'total_urls', 12, 'up_mvp', MVP);
  const r = await db.execute({ sql: `SELECT site_id, metric_value FROM metrics WHERE category='crawl' AND metric_key='total_urls' ORDER BY metric_value DESC`, args: [] });
  assert.strictEqual(r.rows.length, 2, 'both sites keep their own row');
  assert.strictEqual(Number(r.rows[0].metric_value), 62, 'primary (ZKH) value intact');
  assert.strictEqual(r.rows[0].site_id, null, 'primary row keyed NULL');
  assert.strictEqual(Number(r.rows[1].metric_value), 12, 'secondary (MVP) value intact');
  assert.strictEqual(r.rows[1].site_id, MVP, 'secondary row keyed to its site');
});

await test('(2) same-site re-upload SUPERSEDES that site only (no third row)', async () => {
  const db = await freshDb();
  await writeMetric(db, 'm1', 'crawl', 'total_urls', 62, 'up_zkh1', PRIMARY);
  await writeMetric(db, 'm2', 'crawl', 'total_urls', 12, 'up_mvp', MVP);
  await writeMetric(db, 'm3', 'crawl', 'total_urls', 70, 'up_zkh2', PRIMARY); // ZKH re-upload, new value
  const r = await db.execute({ sql: `SELECT site_id, metric_value, csv_upload_id FROM metrics WHERE category='crawl' AND metric_key='total_urls' ORDER BY metric_value DESC`, args: [] });
  assert.strictEqual(r.rows.length, 2, 'still exactly two rows (ZKH updated in place)');
  assert.strictEqual(Number(r.rows[0].metric_value), 70, 'ZKH row updated to the new value');
  assert.strictEqual(r.rows[0].csv_upload_id, 'up_zkh2', 'ZKH row now owned by the re-upload');
  assert.strictEqual(Number(r.rows[1].metric_value), 12, 'MVP row untouched by ZKH re-upload');
  assert.strictEqual(r.rows[1].csv_upload_id, 'up_mvp', 'MVP row still owned by MVP upload');
});

await test('(3) site_issues: same issue_name on two sites COEXIST; same-site re-upload supersedes', async () => {
  const db = await freshDb();
  await writeIssue(db, 'i1', 'H1: Missing', 5, 'up_zkh', PRIMARY);
  await writeIssue(db, 'i2', 'H1: Missing', 2, 'up_mvp', MVP);
  await writeIssue(db, 'i3', 'H1: Missing', 9, 'up_zkh2', PRIMARY); // ZKH re-upload
  const r = await db.execute({ sql: `SELECT site_id, affected_urls FROM site_issues WHERE issue_name='H1: Missing' ORDER BY affected_urls DESC`, args: [] });
  assert.strictEqual(r.rows.length, 2, 'one issue row per site');
  assert.strictEqual(Number(r.rows[0].affected_urls), 9, 'ZKH issue updated by its re-upload');
  assert.strictEqual(r.rows[0].site_id, null, 'ZKH keyed NULL');
  assert.strictEqual(Number(r.rows[1].affected_urls), 2, 'MVP issue untouched');
  assert.strictEqual(r.rows[1].site_id, MVP, 'MVP keyed to its site');
});

await test('(4) different metric keys still independent per site', async () => {
  const db = await freshDb();
  await writeMetric(db, 'm1', 'response_codes', '2xx', 50, 'up_mvp', MVP);
  await writeMetric(db, 'm2', 'response_codes', '4xx', 3, 'up_mvp', MVP);
  const r = await db.execute({ sql: `SELECT COUNT(*) n FROM metrics WHERE site_id = ?`, args: [MVP] });
  assert.strictEqual(Number(r.rows[0].n), 2, 'distinct keys both stored for one site');
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
