// sf-generic universal-capture parser tests.
//
// PROVES: parseSfGenericWithDb row-explodes any CSV into sf_export_rows with
// the URL column hoisted, the FULL row preserved as raw_json, report_type
// derived from the filename, sequential row_index, blank rows skipped, and
// self-dedup by (client, month, report_type) on re-upload while sibling
// reports coexist. In-memory libsql; the prod turso singleton is never called
// (db is injected).

import assert from 'node:assert';
import { createClient } from '@libsql/client';
import { parseSfGenericWithDb, reportTypeForFilename } from '../src/lib/csv/parsers/sf-generic.ts';

let passed = 0, failed = 0;
async function test(n, f) {
  try { await f(); console.log(`[PASS] ${n}`); passed++; }
  catch (e) { console.error(`[FAIL] ${n}: ${e.message}`); failed++; }
}

const CLIENT = 'c1';
const MONTH = '2026-06';

async function freshDb() {
  const db = createClient({ url: 'file::memory:' });
  await db.execute(`CREATE TABLE sf_export_rows (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    csv_upload_id TEXT,
    month TEXT NOT NULL,
    report_type TEXT NOT NULL,
    source_file TEXT NOT NULL,
    row_index INTEGER NOT NULL,
    url TEXT,
    raw_json TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  return db;
}

const AMP_RAW =
  'Address,AMP Issue,Indexability\n' +
  'https://x.com/a,Missing Canonical,Indexable\n' +
  'https://x.com/b,Missing Canonical,Indexable\n';

// A report whose URL column is "Source" (link-style), not "Address".
const SOURCE_RAW =
  'Source,Destination,Anchor\n' +
  'https://x.com/p,https://y.com/q,click\n';

// A report with NO url-bearing column at all (a summary). Still captured.
const SUMMARY_RAW =
  'Metric,Value\n' +
  'Total URLs,123\n' +
  'Crawl Depth,4\n';

await test('(1) row-explode: url hoisted from Address, raw_json keeps all cols, report_type + row_index correct', async () => {
  const db = await freshDb();
  const n = await parseSfGenericWithDb(AMP_RAW, CLIENT, MONTH, 'up1', 'Screaming frog scrape/amp_missing_canonical.csv', db);
  assert.strictEqual(n, 2, 'two data rows captured');

  const rows = (await db.execute(`SELECT report_type, source_file, row_index, url, raw_json FROM sf_export_rows ORDER BY row_index`)).rows;
  assert.strictEqual(String(rows[0].report_type), 'amp_missing_canonical', 'report_type from filename (path + .csv stripped, lowercased)');
  assert.strictEqual(String(rows[0].source_file), 'amp_missing_canonical.csv', 'source_file is the bare filename');
  assert.strictEqual(Number(rows[0].row_index), 0, 'row_index starts at 0');
  assert.strictEqual(Number(rows[1].row_index), 1, 'row_index increments');
  assert.strictEqual(String(rows[0].url), 'https://x.com/a', 'url hoisted from Address');
  const json = JSON.parse(String(rows[0].raw_json));
  assert.strictEqual(json['AMP Issue'], 'Missing Canonical', 'raw_json preserves non-url columns');
  assert.strictEqual(json['Indexability'], 'Indexable', 'raw_json preserves every column');
});

await test('(2) url hoist falls back to Source when there is no Address/URL', async () => {
  const db = await freshDb();
  await parseSfGenericWithDb(SOURCE_RAW, CLIENT, MONTH, 'up2', 'external_links.csv', db);
  const row = (await db.execute(`SELECT url, raw_json FROM sf_export_rows`)).rows[0];
  assert.strictEqual(String(row.url), 'https://x.com/p', 'url hoisted from Source');
  assert.strictEqual(JSON.parse(String(row.raw_json))['Destination'], 'https://y.com/q', 'other cols preserved');
});

await test('(3) report with no url column is still captured (url NULL, full row in raw_json)', async () => {
  const db = await freshDb();
  const n = await parseSfGenericWithDb(SUMMARY_RAW, CLIENT, MONTH, 'up3', 'crawl_summary.csv', db);
  assert.strictEqual(n, 2, 'both summary rows captured');
  const rows = (await db.execute(`SELECT url, raw_json FROM sf_export_rows ORDER BY row_index`)).rows;
  assert.strictEqual(rows[0].url, null, 'url is NULL when no url column present');
  assert.strictEqual(JSON.parse(String(rows[0].raw_json))['Metric'], 'Total URLs', 'data still queryable via raw_json');
});

await test('(4) self-dedup by (client, month, report_type); sibling report types coexist', async () => {
  const db = await freshDb();
  // Two different report types in the same month.
  await parseSfGenericWithDb(AMP_RAW, CLIENT, MONTH, 'up1', 'amp_missing_canonical.csv', db);
  await parseSfGenericWithDb(SUMMARY_RAW, CLIENT, MONTH, 'up2', 'crawl_summary.csv', db);
  assert.strictEqual(Number((await db.execute(`SELECT COUNT(*) AS n FROM sf_export_rows`)).rows[0].n), 4, '2 + 2 rows');

  // Re-upload amp (1 row this time) -> replaces only amp rows, summary intact.
  await parseSfGenericWithDb('Address,AMP Issue\nhttps://x.com/c,Fixed\n', CLIENT, MONTH, 'up3', 'amp_missing_canonical.csv', db);
  const amp = (await db.execute(`SELECT COUNT(*) AS n FROM sf_export_rows WHERE report_type='amp_missing_canonical'`)).rows[0];
  const summary = (await db.execute(`SELECT COUNT(*) AS n FROM sf_export_rows WHERE report_type='crawl_summary'`)).rows[0];
  assert.strictEqual(Number(amp.n), 1, 'amp rows replaced (old 2 gone, new 1)');
  assert.strictEqual(Number(summary.n), 2, 'sibling report (summary) untouched');
});

await test('(5) blank trailing rows are skipped, not stored as empty', async () => {
  const db = await freshDb();
  const n = await parseSfGenericWithDb('Address,X\nhttps://x.com/a,1\n,\n', CLIENT, MONTH, 'up1', 'r.csv', db);
  assert.strictEqual(n, 1, 'only the row with real data is captured');
});

await test('(6) reportTypeForFilename strips path, zip prefix, extension; lowercases', async () => {
  assert.strictEqual(reportTypeForFilename('Folder/AMP_Missing.CSV'), 'amp_missing');
  assert.strictEqual(reportTypeForFilename('export.zip:Pages_Report.csv'), 'pages_report');
  assert.strictEqual(reportTypeForFilename('plain.csv'), 'plain');
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
