// GSC parser parity tests.
// Oracle: hand-built GSC-format strings whose expected values are known
// because we wrote the input — not derived from the old parser.
//
// Tests parseDimensionFile (via parseGscQueriesWithDb) and parseGscFilters
// (via parseGscFiltersWithDb) against an in-memory libsql client, threading
// a db param through the parse path (same pattern as ga4.ts Task 2).
//
// CTR assertion: parseCtrPercent("5.20%") → 5.20 / 100 = 0.052.

import assert from 'node:assert';
import { createClient } from '@libsql/client';
import { parseGscQueriesWithDb, parseGscFiltersWithDb } from '../src/lib/csv/parsers/gsc.ts';

let passed = 0, failed = 0;
async function test(n, f) {
  try {
    await f();
    console.log(`[PASS] ${n}`);
    passed++;
  } catch (e) {
    console.error(`[FAIL] ${n}: ${e.message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Shared in-memory DB setup helper.
// Each createClient call produces an independent in-memory DB instance,
// so each test gets a clean slate with no row bleed.
// ---------------------------------------------------------------------------
async function makeDb() {
  const db = createClient({ url: 'file::memory:' });
  await db.execute(`
    CREATE TABLE IF NOT EXISTS gsc_dimensions (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      csv_upload_id TEXT NOT NULL,
      month TEXT NOT NULL,
      dimension_type TEXT NOT NULL,
      dimension_value TEXT NOT NULL,
      clicks INTEGER,
      impressions INTEGER,
      ctr REAL,
      position REAL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS gsc_filters (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      csv_upload_id TEXT NOT NULL,
      month TEXT NOT NULL,
      filter_key TEXT NOT NULL,
      filter_value TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  return db;
}

// ---------------------------------------------------------------------------
// Hand-built GSC dimensions CSV (Top queries shape).
// Header: Top queries,Clicks,Impressions,CTR,Position
// 3 data rows — expected values are read directly from this literal string.
// ---------------------------------------------------------------------------
const GSC_QUERIES_CSV = [
  'Top queries,Clicks,Impressions,CTR,Position',
  'best running shoes,120,3400,5.20%,4.8',
  'trail running gear,45,1800,2.50%,7.2',
  'minimalist shoes review,10,920,1.09%,11.5',
].join('\n');

// ---------------------------------------------------------------------------
// Test 1: 3 rows are written to gsc_dimensions with correct row count.
// ---------------------------------------------------------------------------
await test('parseGscQueriesWithDb: writes 3 rows to gsc_dimensions', async () => {
  const db = await makeDb();
  const count = await parseGscQueriesWithDb(GSC_QUERIES_CSV, 'cli1', '2024-05', 'upl1', db);
  assert.strictEqual(count, 3, `Expected 3 rows inserted, got ${count}`);
  const out = await db.execute(`SELECT COUNT(*) AS n FROM gsc_dimensions`);
  assert.strictEqual(Number(out.rows[0].n), 3, `DB row count: expected 3`);
});

// ---------------------------------------------------------------------------
// Test 2: dimension_value, clicks, impressions columns are correct.
// Row 0 (order by dimension_value): 'best running shoes', 120, 3400
// ---------------------------------------------------------------------------
await test('parseGscQueriesWithDb: dimension_value + clicks + impressions are correct', async () => {
  const db = await makeDb();
  await parseGscQueriesWithDb(GSC_QUERIES_CSV, 'cli1', '2024-05', 'upl1', db);
  const out = await db.execute(
    `SELECT dimension_value, clicks, impressions FROM gsc_dimensions ORDER BY clicks DESC`
  );
  assert.strictEqual(out.rows[0].dimension_value, 'best running shoes');
  assert.strictEqual(Number(out.rows[0].clicks), 120);
  assert.strictEqual(Number(out.rows[0].impressions), 3400);
  assert.strictEqual(out.rows[2].dimension_value, 'minimalist shoes review');
  assert.strictEqual(Number(out.rows[2].clicks), 10);
});

// ---------------------------------------------------------------------------
// Test 3: CTR is stored as a 0..1 float (parseCtrPercent contract).
// "5.20%" → 0.052   "2.50%" → 0.025   "1.09%" → 0.0109
// ---------------------------------------------------------------------------
await test('parseGscQueriesWithDb: CTR parsed as 0..1 float', async () => {
  const db = await makeDb();
  await parseGscQueriesWithDb(GSC_QUERIES_CSV, 'cli1', '2024-05', 'upl1', db);
  const out = await db.execute(
    `SELECT dimension_value, ctr FROM gsc_dimensions ORDER BY clicks DESC`
  );
  // "5.20%" → 0.052
  const ctr0 = Number(out.rows[0].ctr);
  assert.ok(
    Math.abs(ctr0 - 0.052) < 1e-9,
    `Row 0 CTR: expected 0.052, got ${ctr0}`,
  );
  // "1.09%" → 0.0109
  const ctr2 = Number(out.rows[2].ctr);
  assert.ok(
    Math.abs(ctr2 - 0.0109) < 1e-9,
    `Row 2 CTR: expected 0.0109, got ${ctr2}`,
  );
});

// ---------------------------------------------------------------------------
// Test 4: position is stored as a float.
// "4.8" → 4.8
// ---------------------------------------------------------------------------
await test('parseGscQueriesWithDb: position stored as float', async () => {
  const db = await makeDb();
  await parseGscQueriesWithDb(GSC_QUERIES_CSV, 'cli1', '2024-05', 'upl1', db);
  const out = await db.execute(
    `SELECT dimension_value, position FROM gsc_dimensions ORDER BY clicks DESC`
  );
  const pos0 = Number(out.rows[0].position);
  assert.ok(
    Math.abs(pos0 - 4.8) < 1e-9,
    `Row 0 position: expected 4.8, got ${pos0}`,
  );
});

// ---------------------------------------------------------------------------
// Hand-built GSC Filters CSV.
// Header: Filter,Value
// 2 data rows.
// ---------------------------------------------------------------------------
const GSC_FILTERS_CSV = [
  'Filter,Value',
  'Search type,Web',
  'Date range,Last 3 months',
].join('\n');

// ---------------------------------------------------------------------------
// Test 5: 2 rows are written to gsc_filters with correct row count.
// ---------------------------------------------------------------------------
await test('parseGscFiltersWithDb: writes 2 rows to gsc_filters', async () => {
  const db = await makeDb();
  const count = await parseGscFiltersWithDb(GSC_FILTERS_CSV, 'cli1', '2024-05', 'upl1', db);
  assert.strictEqual(count, 2, `Expected 2 rows inserted, got ${count}`);
  const out = await db.execute(`SELECT COUNT(*) AS n FROM gsc_filters`);
  assert.strictEqual(Number(out.rows[0].n), 2, `DB row count: expected 2`);
});

// ---------------------------------------------------------------------------
// Test 6: filter_key and filter_value are correct.
// Row 0 (order by filter_key): 'Date range' → 'Last 3 months'
// Row 1: 'Search type' → 'Web'
// ---------------------------------------------------------------------------
await test('parseGscFiltersWithDb: filter_key and filter_value are correct', async () => {
  const db = await makeDb();
  await parseGscFiltersWithDb(GSC_FILTERS_CSV, 'cli1', '2024-05', 'upl1', db);
  const out = await db.execute(
    `SELECT filter_key, filter_value FROM gsc_filters ORDER BY filter_key`
  );
  assert.strictEqual(out.rows[0].filter_key, 'Date range');
  assert.strictEqual(out.rows[0].filter_value, 'Last 3 months');
  assert.strictEqual(out.rows[1].filter_key, 'Search type');
  assert.strictEqual(out.rows[1].filter_value, 'Web');
});

// ---------------------------------------------------------------------------
// Test 7: filter_value is null when Value cell is empty (|| null branch).
// ---------------------------------------------------------------------------
await test('parseGscFiltersWithDb: empty Value cell stored as null', async () => {
  const db = await makeDb();
  const csvWithEmpty = ['Filter,Value', 'Search type,', 'Date range,Last 6 months'].join('\n');
  await parseGscFiltersWithDb(csvWithEmpty, 'cli1', '2024-05', 'upl1', db);
  const out = await db.execute(
    `SELECT filter_key, filter_value FROM gsc_filters ORDER BY filter_key`
  );
  assert.strictEqual(out.rows[0].filter_key, 'Date range');
  assert.strictEqual(out.rows[0].filter_value, 'Last 6 months');
  assert.strictEqual(out.rows[1].filter_key, 'Search type');
  assert.strictEqual(out.rows[1].filter_value, null, `Expected null for empty Value, got ${out.rows[1].filter_value}`);
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
