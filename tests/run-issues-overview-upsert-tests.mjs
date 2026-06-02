// issues_overview duplicate-file site_issues upsert tests.
//
// ROOT CAUSE (confirmed empirically against the real prod schema): Screaming
// Frog ships issues_overview_report.csv in BOTH the crawl root and
// /issues_reports/. Both detect as format 'issues_overview' with DIFFERENT
// original_names, so neither supersedes the other (the supersession key
// includes original_name). Both files then write site_issues keyed by
// issue_name.
//
// PROD SCHEMA TRUTH (migration 001: id PRIMARY KEY only; migration 002: a
// NON-unique index on (client_id, month)): site_issues has NO unique
// constraint on (client_id, month, issue_name). So the real prod symptom of
// the duplicate file is NOT a thrown error -- a plain INSERT of the same
// issue_name SILENTLY inserts a SECOND row (the same issue double-counted in
// the table that feeds the client-facing Technical Health score).
//
// A named ON CONFLICT(client_id, month, issue_name) upsert cannot run against
// that schema: SQLite throws "ON CONFLICT clause does not match any PRIMARY
// KEY or UNIQUE constraint". So the upserting parser REQUIRES the unique index
// to exist first.
//
// FIX: migration 058 dedupes existing rows then creates
//   CREATE UNIQUE INDEX ux_site_issues_name
//     ON site_issues (client_id, month, issue_name)
// and parseIssuesOverviewWithDb upserts ON CONFLICT(client_id, month,
// issue_name) DO UPDATE, so a duplicate file (or a re-run) overwrites
// (last-writer-wins) instead of duplicating.
//
// Oracle: hand-built CSV strings whose expected values are known because we
// wrote the input, NOT derived from old-code output. The pre-fix reproduction
// asserts the REAL prod symptom (two duplicate rows, no throw). The post-fix
// state (one row per issue_name, last-writer-wins) is reasoned by hand against
// the migration-058 unique index.

import assert from 'node:assert';
import { createClient } from '@libsql/client';
import { nanoid } from 'nanoid';
import { parseIssuesOverviewWithDb } from '../src/lib/csv/parsers/issues-overview.ts';

let passed = 0, failed = 0;
async function test(n, f) {
  try { await f(); console.log(`[PASS] ${n}`); passed++; }
  catch (e) { console.error(`[FAIL] ${n}: ${e.message}`); failed++; }
}

const CLIENT = 'cli1';
const MONTH = '2026-05';

// site_issues exactly as migrations 001 + 002 build it in prod: id PRIMARY KEY,
// a NON-unique index on (client_id, month), and NO unique constraint on
// issue_name. This is the schema the duplicate-file collision actually hits.
async function createSiteIssues(db) {
  await db.execute(`CREATE TABLE site_issues (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    month TEXT NOT NULL,
    issue_name TEXT NOT NULL,
    issue_type TEXT,
    priority TEXT,
    affected_urls INTEGER,
    pct_of_total REAL,
    description TEXT,
    how_to_fix TEXT,
    csv_upload_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  // migration 002: NON-unique.
  await db.execute(`CREATE INDEX idx_issues_client_month ON site_issues(client_id, month)`);
  // metrics carries its own upsert key so the parser's aggregate writes don't
  // throw on the second pass (matches migration 001 metrics UNIQUE).
  await db.execute(`CREATE TABLE metrics (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    month TEXT NOT NULL,
    category TEXT NOT NULL,
    metric_key TEXT NOT NULL,
    metric_value REAL,
    source TEXT,
    csv_upload_id TEXT,
    UNIQUE(client_id, month, category, metric_key)
  )`);
}

// Pre-fix prod schema: 001 + 002, no unique on issue_name.
async function prodDb() {
  const db = createClient({ url: 'file::memory:' });
  await createSiteIssues(db);
  return db;
}

// migration 058 applied on top: dedup-then-unique-index. Mirrors the SQL in
// src/lib/migrations/058-site-issues-name-unique.ts so the test models the
// real post-migration schema the fix relies on.
async function applyMigration058(db) {
  await db.execute(`
    DELETE FROM site_issues
     WHERE id NOT IN (
       SELECT id FROM (
         SELECT id,
                ROW_NUMBER() OVER (
                  PARTITION BY client_id, month, issue_name
                  ORDER BY created_at DESC, id DESC
                ) AS rn
         FROM site_issues
       ) WHERE rn = 1
     )
  `);
  await db.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_site_issues_name
    ON site_issues (client_id, month, issue_name)
  `);
}

// Post-fix prod schema: 001 + 002 + 058.
async function migratedDb() {
  const db = await prodDb();
  await applyMigration058(db);
  return db;
}

// ---------------------------------------------------------------------------
// The two SF copies of issues_overview_report.csv. SAME issue_name in both,
// but the second copy (the /issues_reports/ one) reports a different URL count
// / pct / fix text so we can prove last-writer-wins after the upsert.
// ---------------------------------------------------------------------------
const OVERVIEW_ROOT = [
  'Issue Name,Issue Type,Issue Priority,URLs,% of Total,Description,How To Fix',
  'H1: Missing,Headings,High,12,30%,Pages missing an H1,Add a single H1',
  'Page Titles: Duplicate,Page Titles,Medium,4,10%,Duplicate titles,Make titles unique',
].join('\n');

// Same two issue_names, different reported values (simulating the second
// duplicate file with refreshed numbers).
const OVERVIEW_ISSUES_REPORTS = [
  'Issue Name,Issue Type,Issue Priority,URLs,% of Total,Description,How To Fix',
  'H1: Missing,Headings,Critical,7,18%,H1 absent on key pages,Add one H1 per page',
  'Page Titles: Duplicate,Page Titles,Low,2,5%,Two duplicate titles,Differentiate them',
].join('\n');

const plainInsert = (db, uploadId, issueName) => db.execute({
  sql: `INSERT INTO site_issues (id, client_id, month, issue_name, issue_type, priority, affected_urls, pct_of_total, description, how_to_fix, csv_upload_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  args: [nanoid(), CLIENT, MONTH, issueName, 'Headings', 'High', 12, 30, 'x', 'y', uploadId],
});

// ---------------------------------------------------------------------------
// Test 0 (REPRODUCTION — the REAL prod symptom): against the actual prod
// schema (001 + 002, NO unique on issue_name), a duplicate-issue_name INSERT
// does NOT throw. It SILENTLY inserts a second row -> the issue is
// double-counted. This is the genuine prod failure the fix corrects, NOT a
// thrown UNIQUE error.
// ---------------------------------------------------------------------------
await test('REPRO (real prod symptom): on the prod schema a duplicate issue_name does NOT throw -- it silently inserts a SECOND row (issue double-counted)', async () => {
  const db = await prodDb();
  await plainInsert(db, 'up_root', 'H1: Missing');         // first file: fine
  let threw = false;
  try {
    await plainInsert(db, 'up_issues_reports', 'H1: Missing'); // second file, same issue_name
  } catch (e) {
    threw = true;
  }
  assert.strictEqual(threw, false, 'on the real prod schema the duplicate INSERT must NOT throw (no unique constraint exists yet)');
  const total = await db.execute(`SELECT COUNT(*) AS n FROM site_issues WHERE issue_name = ?`, ['H1: Missing']);
  assert.strictEqual(Number(total.rows[0].n), 2, 'the real symptom: TWO duplicate rows for the same issue_name (double-counted)');
});

// ---------------------------------------------------------------------------
// Test 0b (why the index is required): the upserting parser's named
// ON CONFLICT(client_id, month, issue_name) clause CANNOT run against the prod
// schema -- SQLite throws because there is no matching unique constraint. This
// proves migration 058's unique index must exist before the upsert is valid.
// ---------------------------------------------------------------------------
await test('GUARD: the ON CONFLICT upsert throws on the prod schema (no matching unique constraint) -- migration 058 is required', async () => {
  const db = await prodDb();
  let threw = false, msg = '';
  try {
    await parseIssuesOverviewWithDb(OVERVIEW_ROOT, CLIENT, MONTH, 'up_root', db);
  } catch (e) {
    threw = true; msg = e.message;
  }
  assert.ok(threw, 'the named ON CONFLICT upsert must throw without the unique index');
  assert.ok(/ON CONFLICT clause does not match/i.test(msg), `expected the missing-constraint error, got: ${msg}`);
});

// ---------------------------------------------------------------------------
// Test 0c (post-migration the constraint fires): once migration 058's unique
// index exists, a PLAIN INSERT of a duplicate issue_name DOES throw UNIQUE.
// This is true only AFTER the index is created, not on the pre-fix prod schema.
// ---------------------------------------------------------------------------
await test('POST-058: a plain INSERT of a duplicate (client, month, issue_name) throws UNIQUE (the index now backs the upsert)', async () => {
  const db = await migratedDb();
  await plainInsert(db, 'up_root', 'H1: Missing');
  let threw = false, msg = '';
  try {
    await plainInsert(db, 'up_issues_reports', 'H1: Missing');
  } catch (e) {
    threw = true; msg = e.message;
  }
  assert.ok(threw, 'after migration 058 a plain INSERT of the duplicate issue_name MUST throw');
  assert.ok(/UNIQUE constraint failed/i.test(msg), `expected a UNIQUE constraint error, got: ${msg}`);
});

// ---------------------------------------------------------------------------
// Test 1 (the fix): on the migrated schema, ingest the two duplicate files via
// the upserting parser. NO error. Exactly one row per issue_name. Two distinct
// issue_names -> two rows total.
// ---------------------------------------------------------------------------
await test('parseIssuesOverviewWithDb (post-058): the two duplicate files ingest with NO error; one row per issue_name', async () => {
  const db = await migratedDb();
  const c1 = await parseIssuesOverviewWithDb(OVERVIEW_ROOT, CLIENT, MONTH, 'up_root', db);
  assert.strictEqual(c1, 2, 'first file reports 2 issue rows');

  // Second (duplicate) file -> the prod symptom would have been a 2nd dup row;
  // post-058 the upsert overwrites instead.
  const c2 = await parseIssuesOverviewWithDb(OVERVIEW_ISSUES_REPORTS, CLIENT, MONTH, 'up_issues_reports', db);
  assert.strictEqual(c2, 2, 'second duplicate file also reports 2 issue rows (no throw)');

  const total = await db.execute(`SELECT COUNT(*) AS n FROM site_issues`);
  assert.strictEqual(Number(total.rows[0].n), 2, 'exactly 2 rows total (one per distinct issue_name)');

  const perName = await db.execute(`SELECT issue_name, COUNT(*) AS n FROM site_issues GROUP BY issue_name`);
  for (const r of perName.rows) {
    assert.strictEqual(Number(r.n), 1, `exactly one row for issue_name "${r.issue_name}"`);
  }
});

// ---------------------------------------------------------------------------
// Test 2 (last-writer-wins): after the second file, the row carries the
// SECOND file's values, not the first's. Hand truth from OVERVIEW_ISSUES_REPORTS.
// ---------------------------------------------------------------------------
await test('parseIssuesOverviewWithDb (post-058): last writer wins, the row reflects the second file values', async () => {
  const db = await migratedDb();
  await parseIssuesOverviewWithDb(OVERVIEW_ROOT, CLIENT, MONTH, 'up_root', db);
  await parseIssuesOverviewWithDb(OVERVIEW_ISSUES_REPORTS, CLIENT, MONTH, 'up_issues_reports', db);

  const h1 = await db.execute({
    sql: `SELECT issue_type, priority, affected_urls, pct_of_total, description, how_to_fix, csv_upload_id
          FROM site_issues WHERE client_id = ? AND month = ? AND issue_name = ?`,
    args: [CLIENT, MONTH, 'H1: Missing'],
  });
  assert.strictEqual(h1.rows.length, 1, 'exactly one H1: Missing row');
  const r = h1.rows[0];
  assert.strictEqual(r.priority, 'Critical', 'priority overwritten to second-file value');
  assert.strictEqual(Number(r.affected_urls), 7, 'affected_urls overwritten to 7 (second file)');
  assert.strictEqual(Number(r.pct_of_total), 18, 'pct_of_total overwritten to 18 (second file)');
  assert.strictEqual(r.description, 'H1 absent on key pages', 'description overwritten (second file)');
  assert.strictEqual(r.how_to_fix, 'Add one H1 per page', 'how_to_fix overwritten (second file)');
  assert.strictEqual(r.csv_upload_id, 'up_issues_reports', 'csv_upload_id points at the second (winning) upload');

  const titles = await db.execute({
    sql: `SELECT affected_urls FROM site_issues WHERE client_id = ? AND month = ? AND issue_name = ?`,
    args: [CLIENT, MONTH, 'Page Titles: Duplicate'],
  });
  assert.strictEqual(Number(titles.rows[0].affected_urls), 2, 'second issue_name also overwritten to second-file value');
});

// ---------------------------------------------------------------------------
// Test 3 (idempotent re-run): ingesting the exact same file twice is a no-op
// on row count and leaves the same values. Covers the "or a re-run" case.
// ---------------------------------------------------------------------------
await test('parseIssuesOverviewWithDb (post-058): re-ingesting the identical file is idempotent (no throw, no dup rows)', async () => {
  const db = await migratedDb();
  await parseIssuesOverviewWithDb(OVERVIEW_ROOT, CLIENT, MONTH, 'up_a', db);
  await parseIssuesOverviewWithDb(OVERVIEW_ROOT, CLIENT, MONTH, 'up_b', db);
  const total = await db.execute(`SELECT COUNT(*) AS n FROM site_issues`);
  assert.strictEqual(Number(total.rows[0].n), 2, 're-run leaves exactly 2 rows');
  const h1 = await db.execute({
    sql: `SELECT affected_urls FROM site_issues WHERE issue_name = ?`,
    args: ['H1: Missing'],
  });
  assert.strictEqual(Number(h1.rows[0].affected_urls), 12, 'values unchanged on identical re-run');
});

// ---------------------------------------------------------------------------
// Test 4 (migration 058 dedup): the dedup step collapses pre-existing
// duplicate rows (the prod state before the index) down to one per
// (client, month, issue_name), keeping the NEWEST, before the unique index is
// created. Proves the migration can run on dirty prod data.
// ---------------------------------------------------------------------------
await test('migration 058 dedup: pre-existing duplicate rows collapse to one (newest kept) so the unique index builds on dirty data', async () => {
  const db = await prodDb();
  // Seed the real prod symptom: two rows for the same issue_name, the second
  // (newer) carrying refreshed values.
  await db.execute({
    sql: `INSERT INTO site_issues (id, client_id, month, issue_name, affected_urls, csv_upload_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, '2026-05-01 00:00:00')`,
    args: ['old', CLIENT, MONTH, 'H1: Missing', 12, 'up_root'],
  });
  await db.execute({
    sql: `INSERT INTO site_issues (id, client_id, month, issue_name, affected_urls, csv_upload_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, '2026-05-02 00:00:00')`,
    args: ['new', CLIENT, MONTH, 'H1: Missing', 7, 'up_issues_reports'],
  });
  // A distinct issue_name that must survive untouched.
  await db.execute({
    sql: `INSERT INTO site_issues (id, client_id, month, issue_name, affected_urls, csv_upload_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, '2026-05-01 00:00:00')`,
    args: ['titles', CLIENT, MONTH, 'Page Titles: Duplicate', 4, 'up_root'],
  });

  await applyMigration058(db);

  const total = await db.execute(`SELECT COUNT(*) AS n FROM site_issues`);
  assert.strictEqual(Number(total.rows[0].n), 2, 'two distinct issue_names remain after dedup');
  const h1 = await db.execute({
    sql: `SELECT id, affected_urls FROM site_issues WHERE issue_name = ?`,
    args: ['H1: Missing'],
  });
  assert.strictEqual(h1.rows.length, 1, 'exactly one H1: Missing row survives');
  assert.strictEqual(h1.rows[0].id, 'new', 'the NEWEST row is kept');
  assert.strictEqual(Number(h1.rows[0].affected_urls), 7, 'the surviving row carries the newest values');
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
