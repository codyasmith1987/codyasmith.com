// GA4 parser parity tests.
// Oracle: hand-built GA4-format strings whose expected values are known
// because we wrote the input — not derived from the old parser.
//
// Tests splitIntoBlocks directly (pure function, no DB) and then
// the full parseTrafficAcquisition against an in-memory libsql client
// after threading a db param through the parse path.

import assert from 'node:assert';
import { createClient } from '@libsql/client';

// Import splitIntoBlocks via a named re-export we'll add in ga4.ts.
// If the export is not yet present the test will error with a clear message.
import { splitIntoBlocksForTest, parseTrafficAcquisitionWithDb } from '../src/lib/csv/parsers/ga4.ts';

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
// Hand-built GA4 multi-block string.
// Two blocks, each with # Start date / # End date markers.
// Block 1: header "Channel,Sessions,Engaged sessions" + 3 data rows.
// Block 2: header "Channel,Sessions" + 2 data rows.
// The expected values below are read directly from this literal string.
// ---------------------------------------------------------------------------
const GA4_TWO_BLOCKS = [
  '# Google Analytics report',
  '# Account: Test Account',
  '# ----------------------------------------',
  '# Start date: 20240101',
  '# End date: 20240131',
  'Channel,Sessions,Engaged sessions',
  'Organic Search,1000,800',
  'Direct,500,400',
  'Referral,200,150',
  '',
  '# Start date: 20240201',
  '# End date: 20240229',
  'Channel,Sessions',
  'Organic Search,1200',
  'Direct,600',
].join('\n');

// ---------------------------------------------------------------------------
// Test 1: splitIntoBlocks returns correct block count
// ---------------------------------------------------------------------------
await test('splitIntoBlocks: 2-block GA4 file returns 2 blocks', () => {
  const blocks = splitIntoBlocksForTest(GA4_TWO_BLOCKS);
  assert.strictEqual(blocks.length, 2, `Expected 2 blocks, got ${blocks.length}`);
});

// ---------------------------------------------------------------------------
// Test 2: Block 1 has correct metadata (startDate, endDate) and headers
// ---------------------------------------------------------------------------
await test('splitIntoBlocks: block 1 has correct date metadata and headers', () => {
  const blocks = splitIntoBlocksForTest(GA4_TWO_BLOCKS);
  const b1 = blocks[0];
  assert.strictEqual(b1.startDate, '20240101', `Block 1 startDate: got ${b1.startDate}`);
  assert.strictEqual(b1.endDate, '20240131', `Block 1 endDate: got ${b1.endDate}`);
  assert.deepStrictEqual(b1.headers, ['Channel', 'Sessions', 'Engaged sessions'],
    `Block 1 headers: got ${JSON.stringify(b1.headers)}`);
});

// ---------------------------------------------------------------------------
// Test 3: Block 1 has 3 data rows with correct cell values
// ---------------------------------------------------------------------------
await test('splitIntoBlocks: block 1 has 3 data rows, correct cell values', () => {
  const blocks = splitIntoBlocksForTest(GA4_TWO_BLOCKS);
  const b1 = blocks[0];
  assert.strictEqual(b1.rows.length, 3, `Block 1 rows: expected 3, got ${b1.rows.length}`);
  assert.strictEqual(b1.rows[0][0], 'Organic Search');
  assert.strictEqual(b1.rows[0][1], '1000');
  assert.strictEqual(b1.rows[0][2], '800');
  assert.strictEqual(b1.rows[2][0], 'Referral');
  assert.strictEqual(b1.rows[2][1], '200');
});

// ---------------------------------------------------------------------------
// Test 4: Block 2 has correct metadata and 2 data rows
// ---------------------------------------------------------------------------
await test('splitIntoBlocks: block 2 has correct date metadata and 2 rows', () => {
  const blocks = splitIntoBlocksForTest(GA4_TWO_BLOCKS);
  const b2 = blocks[1];
  assert.strictEqual(b2.startDate, '20240201', `Block 2 startDate: got ${b2.startDate}`);
  assert.strictEqual(b2.endDate, '20240229', `Block 2 endDate: got ${b2.endDate}`);
  assert.strictEqual(b2.rows.length, 2, `Block 2 rows: expected 2, got ${b2.rows.length}`);
  assert.strictEqual(b2.rows[1][0], 'Direct');
  assert.strictEqual(b2.rows[1][1], '600');
});

// ---------------------------------------------------------------------------
// Test 5: # comment markers are handled — a line starting with # that is
// NOT a Start/End date line is skipped (not treated as data)
// ---------------------------------------------------------------------------
await test('splitIntoBlocks: non-date # comment lines are skipped', () => {
  const withExtraComments = [
    '# ----------------------------------------',
    '# Arbitrary comment inside block area',
    '# Start date: 20240101',
    '# End date: 20240131',
    '# Another comment here',
    'Col1,Col2',
    'A,1',
    'B,2',
  ].join('\n');
  const blocks = splitIntoBlocksForTest(withExtraComments);
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].rows.length, 2);
  assert.strictEqual(blocks[0].rows[0][0], 'A');
});

// ---------------------------------------------------------------------------
// Test 6: Full parseTrafficAcquisition writes correct rows to in-memory DB.
// The hand-built input has 3 channels — expected 3 rows in ga4_channels.
// ---------------------------------------------------------------------------
const GA4_TRAFFIC = [
  '# Google Analytics report',
  '# Start date: 20240101',
  '# End date: 20240131',
  'Session primary channel group,Sessions,Engaged sessions,Engagement rate,Average engagement time per session,Events per session,Event count,Key events,Session key event rate,Total revenue',
  'Organic Search,1000,800,0.80,120.5,5.2,5200,50,0.05,0.00',
  'Direct,500,400,0.80,95.0,4.0,2000,20,0.04,0.00',
  'Referral,200,150,0.75,60.0,3.0,600,5,0.025,0.00',
].join('\n');

await test('parseTrafficAcquisitionWithDb: writes 3 channel rows to ga4_channels', async () => {
  const db = createClient({ url: 'file::memory:?cache=shared' });
  await db.execute(`
    CREATE TABLE ga4_channels (
      id TEXT, client_id TEXT, csv_upload_id TEXT, month TEXT, channel TEXT,
      sessions INTEGER, engaged_sessions INTEGER, engagement_rate REAL,
      avg_engagement_time_per_session REAL, events_per_session REAL,
      event_count INTEGER, key_events INTEGER, session_key_event_rate REAL,
      total_revenue REAL
    )
  `);
  const count = await parseTrafficAcquisitionWithDb(GA4_TRAFFIC, 'cli1', '2024-01', 'upl1', db);
  assert.strictEqual(count, 3, `Expected 3 rows inserted, got ${count}`);
  const out = await db.execute(`SELECT channel, sessions, engaged_sessions FROM ga4_channels ORDER BY sessions DESC`);
  assert.strictEqual(out.rows.length, 3);
  assert.strictEqual(out.rows[0].channel, 'Organic Search');
  assert.strictEqual(Number(out.rows[0].sessions), 1000);
  assert.strictEqual(Number(out.rows[0].engaged_sessions), 800);
  assert.strictEqual(out.rows[2].channel, 'Referral');
  assert.strictEqual(Number(out.rows[2].sessions), 200);
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
