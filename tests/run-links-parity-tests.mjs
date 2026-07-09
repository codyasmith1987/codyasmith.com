// Links parser parity tests.
// Oracle: hand-built CSV strings whose expected values are known because
// we wrote the input — not derived from the old parser.
//
// Tests parseLinksWithDb against an in-memory libsql client, threading
// a db param through the parse path (same pattern as gsc.ts Task 3).
//
// Covers:
//   1. Small (5-row) case: row count, source_url, destination_url, anchor_text,
//      source_file preserved exactly.
//   2. Large (120-row) case: all rows written — regression guard for the
//      multi-chunk batching fix (ceil(120/50)=3 flush calls, each flushed
//      via turso.batch instead of per-flush execute).
//   3. source_file dedup: re-uploading same source_file clears old rows
//      before inserting.

import assert from 'node:assert';
import { createClient } from '@libsql/client';
import { parseLinksWithDb } from '../src/lib/csv/parsers/links.ts';

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
// In-memory DB setup helper — creates link_graph table each call.
// Each createClient call produces an independent in-memory DB.
// ---------------------------------------------------------------------------
async function makeDb() {
  const db = createClient({ url: 'file::memory:' });
  await db.execute(`
    CREATE TABLE IF NOT EXISTS link_graph (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      csv_upload_id TEXT,
      month TEXT NOT NULL,
      source_file TEXT NOT NULL,
      link_type TEXT,
      source_url TEXT NOT NULL,
      source_hostname TEXT,
      destination_url TEXT NOT NULL,
      destination_hostname TEXT,
      anchor_text TEXT,
      alt_text TEXT,
      status_code INTEGER,
      follow INTEGER NOT NULL DEFAULT 1,
      target TEXT,
      rel TEXT,
      link_position TEXT,
      link_origin TEXT,
      link_path TEXT,
      size_bytes INTEGER,
      anchor_length INTEGER,
      raw_json TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  return db;
}

// ---------------------------------------------------------------------------
// Hand-built small links CSV — 5 data rows, oracle values known from input.
// Column order matches what SF exports and what links.ts parses:
//   Type, Source, Destination, Size (Bytes), Alt Text, Anchor, Status Code,
//   Status, Follow, Target, Rel, Path Type, Link Path, Link Position, Link Origin
// ---------------------------------------------------------------------------
const LINKS_CSV_SMALL = [
  'Type,Source,Destination,Size (Bytes),Alt Text,Anchor,Status Code,Status,Follow,Target,Rel,Path Type,Link Path,Link Position,Link Origin',
  'Hyperlink,https://example.com/,https://example.com/about/,10000,,About Us,200,OK,true,,,Absolute,//body/nav/a,Navigation,HTML',
  'Hyperlink,https://example.com/,https://example.com/contact/,10000,,Contact,200,OK,true,,,Absolute,//body/nav/a,Navigation,HTML',
  'Hyperlink,https://example.com/about/,https://example.com/,9000,Logo,Home,200,OK,true,,,Absolute,//body/header/a,Header,HTML',
  'Hyperlink,https://example.com/about/,https://example.com/team/,9000,,Our Team,200,OK,true,,,Absolute,//body/main/a,Content,HTML',
  'Image,https://example.com/,https://example.com/images/logo.png,5000,Company Logo,,200,OK,true,,,Absolute,//body/header/img,Header,HTML',
].join('\n');

// ---------------------------------------------------------------------------
// Test 1: 5 rows are written with the correct row count.
// ---------------------------------------------------------------------------
await test('parseLinksWithDb: writes 5 rows for small CSV', async () => {
  const db = await makeDb();
  const count = await parseLinksWithDb(LINKS_CSV_SMALL, 'cli1', '2024-05', 'upl1', 'all_outlinks.csv', db);
  assert.strictEqual(count, 5, `Expected 5 rows inserted, got ${count}`);
  const out = await db.execute(`SELECT COUNT(*) AS n FROM link_graph`);
  assert.strictEqual(Number(out.rows[0].n), 5, `DB row count: expected 5`);
});

// ---------------------------------------------------------------------------
// Test 2: source_url and destination_url columns are mapped correctly.
// Row with anchor "About Us": source=example.com/, dest=example.com/about/
// ---------------------------------------------------------------------------
await test('parseLinksWithDb: source_url + destination_url are correct', async () => {
  const db = await makeDb();
  await parseLinksWithDb(LINKS_CSV_SMALL, 'cli1', '2024-05', 'upl1', 'all_outlinks.csv', db);
  const out = await db.execute(
    `SELECT source_url, destination_url, anchor_text FROM link_graph WHERE anchor_text = 'About Us'`
  );
  assert.strictEqual(out.rows.length, 1);
  assert.strictEqual(out.rows[0].source_url, 'https://example.com/');
  assert.strictEqual(out.rows[0].destination_url, 'https://example.com/about/');
});

// ---------------------------------------------------------------------------
// Test 3: anchor_text, alt_text, source_file, link_type are preserved.
// The image row has alt_text "Company Logo" and empty anchor.
// ---------------------------------------------------------------------------
await test('parseLinksWithDb: anchor_text + alt_text + source_file + link_type correct', async () => {
  const db = await makeDb();
  await parseLinksWithDb(LINKS_CSV_SMALL, 'cli1', '2024-05', 'upl1', 'all_outlinks.csv', db);
  // Image row
  const imgRow = await db.execute(
    `SELECT link_type, anchor_text, alt_text, source_file FROM link_graph WHERE destination_url LIKE '%logo.png'`
  );
  assert.strictEqual(imgRow.rows.length, 1);
  assert.strictEqual(imgRow.rows[0].link_type, 'Image');
  assert.strictEqual(imgRow.rows[0].alt_text, 'Company Logo');
  assert.strictEqual(imgRow.rows[0].anchor_text, null, `anchor_text should be null for empty cell`);
  assert.strictEqual(imgRow.rows[0].source_file, 'all_outlinks');
});

// ---------------------------------------------------------------------------
// Test 4: hostnames are extracted from source_url and destination_url.
// source https://example.com/ -> hostname example.com
// destination https://example.com/about/ -> hostname example.com
// ---------------------------------------------------------------------------
await test('parseLinksWithDb: source_hostname + destination_hostname extracted', async () => {
  const db = await makeDb();
  await parseLinksWithDb(LINKS_CSV_SMALL, 'cli1', '2024-05', 'upl1', 'all_outlinks.csv', db);
  const out = await db.execute(
    `SELECT source_hostname, destination_hostname FROM link_graph WHERE anchor_text = 'About Us'`
  );
  assert.strictEqual(out.rows[0].source_hostname, 'example.com');
  assert.strictEqual(out.rows[0].destination_hostname, 'example.com');
});

// ---------------------------------------------------------------------------
// Test 5: source_file dedup — re-uploading same filename wipes prior rows.
// First upload: 5 rows for all_outlinks.
// Second upload: 2 rows for all_outlinks (same source_file).
// Expected: 2 rows total (prior 5 replaced).
// ---------------------------------------------------------------------------
await test('parseLinksWithDb: source_file dedup replaces prior rows on re-upload', async () => {
  const db = await makeDb();
  await parseLinksWithDb(LINKS_CSV_SMALL, 'cli1', '2024-05', 'upl1', 'all_outlinks.csv', db);
  const after1 = await db.execute(`SELECT COUNT(*) AS n FROM link_graph`);
  assert.strictEqual(Number(after1.rows[0].n), 5, `First upload: expected 5`);

  const LINKS_CSV_SECOND = [
    'Type,Source,Destination,Size (Bytes),Alt Text,Anchor,Status Code,Status,Follow,Target,Rel,Path Type,Link Path,Link Position,Link Origin',
    'Hyperlink,https://example.com/,https://example.com/new-page/,10000,,New Page,200,OK,true,,,Absolute,//body/nav/a,Navigation,HTML',
    'Hyperlink,https://example.com/,https://example.com/other/,10000,,Other,200,OK,true,,,Absolute,//body/nav/a,Navigation,HTML',
  ].join('\n');
  await parseLinksWithDb(LINKS_CSV_SECOND, 'cli1', '2024-05', 'upl2', 'all_outlinks.csv', db);
  const after2 = await db.execute(`SELECT COUNT(*) AS n FROM link_graph`);
  assert.strictEqual(Number(after2.rows[0].n), 2, `After re-upload: expected 2 (old rows replaced)`);
});

// ---------------------------------------------------------------------------
// Test 6: different source_files coexist (no cross-file dedup).
// Upload all_outlinks (5 rows) then all_inlinks (2 rows).
// Expected: 7 rows total.
// ---------------------------------------------------------------------------
await test('parseLinksWithDb: different source_files coexist without cross-dedup', async () => {
  const db = await makeDb();
  await parseLinksWithDb(LINKS_CSV_SMALL, 'cli1', '2024-05', 'upl1', 'all_outlinks.csv', db);
  const INLINKS_CSV = [
    'Type,Source,Destination,Size (Bytes),Alt Text,Anchor,Status Code,Status,Follow,Target,Rel,Path Type,Link Path,Link Position,Link Origin',
    'Hyperlink,https://other.com/,https://example.com/,0,,Read more,200,OK,true,,,Absolute,//body/a,Content,HTML',
    'Hyperlink,https://another.com/,https://example.com/,0,,Visit,200,OK,true,,,Absolute,//body/a,Content,HTML',
  ].join('\n');
  await parseLinksWithDb(INLINKS_CSV, 'cli1', '2024-05', 'upl2', 'all_inlinks.csv', db);
  const out = await db.execute(`SELECT COUNT(*) AS n FROM link_graph`);
  assert.strictEqual(Number(out.rows[0].n), 7, `Expected 7 (5 outlinks + 2 inlinks)`);
});

// ---------------------------------------------------------------------------
// Test 7: Large 120-row CSV — proves multi-chunk batching writes ALL rows.
// BATCH_SIZE=50 means 3 flush calls for 120 rows; each flush is now a
// turso.batch call, not a per-flush execute. This is the regression guard
// for the round-trip fix: if the batch loop is broken, count will be < 120.
// ---------------------------------------------------------------------------
const LINKS_CSV_LARGE = (() => {
  const header = 'Type,Source,Destination,Size (Bytes),Alt Text,Anchor,Status Code,Status,Follow,Target,Rel,Path Type,Link Path,Link Position,Link Origin';
  const rows = Array.from({ length: 120 }, (_, i) =>
    `Hyperlink,https://example.com/page${i}/,https://example.com/dest${i}/,1000,,Link ${i},200,OK,true,,,Absolute,//body/a,Content,HTML`
  );
  return [header, ...rows].join('\n');
})();

await test('parseLinksWithDb: 120-row CSV writes all rows (multi-chunk batch regression guard)', async () => {
  const db = await makeDb();
  const count = await parseLinksWithDb(LINKS_CSV_LARGE, 'cli1', '2024-05', 'upl1', 'large_links.csv', db);
  assert.strictEqual(count, 120, `Parser returned ${count}, expected 120`);
  const out = await db.execute(`SELECT COUNT(*) AS n FROM link_graph`);
  assert.strictEqual(Number(out.rows[0].n), 120, `DB row count: expected 120, got ${Number(out.rows[0].n)}`);
  // Spot-check row 0 and row 119 by anchor_text to confirm endpoints written
  const row0 = await db.execute(`SELECT anchor_text FROM link_graph WHERE destination_url = 'https://example.com/dest0/'`);
  assert.strictEqual(row0.rows.length, 1, 'Row 0 (dest0) should exist');
  assert.strictEqual(row0.rows[0].anchor_text, 'Link 0');
  const row119 = await db.execute(`SELECT anchor_text FROM link_graph WHERE destination_url = 'https://example.com/dest119/'`);
  assert.strictEqual(row119.rows.length, 1, 'Row 119 (dest119) should exist');
  assert.strictEqual(row119.rows[0].anchor_text, 'Link 119');
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
