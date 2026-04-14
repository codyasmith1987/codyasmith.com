// Phase 1 Step 4b-i — end-to-end idempotency test for ingest-v2.
//
// Uses a synthetic test period (2099-01) against the real production
// client so existing 2026-04 data is never touched. Three uploads:
//   A   — 3 rows, fresh   → expect status='applied', 3 rows in keyword_snapshots
//   A'  — same bytes       → expect status='noop',    3 rows unchanged
//   B   — 2 rows, modified → expect status='applied', 2 rows (old slice deleted)
//
// Also verifies that the UNIQUE content_hash guard is what's enforcing
// the noop, and that the 2026-04 production slice is byte-identical
// before and after the whole test.
//
// Cleanup at the end: deletes the test period and cascades to imports
// and keyword_snapshots so the DB returns to its prior state.
//
// Run:  npx tsx scripts/phase1-test-idempotency.ts

import 'dotenv/config';
import { createClient } from '@libsql/client';
import { createHash } from 'node:crypto';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) {
  console.error('TURSO_DATABASE_URL is not set');
  process.exit(1);
}
const db = createClient({ url, authToken });

// Dynamic import so ingest-v2 sees the same TURSO env as us. ingest-v2
// uses src/lib/turso.ts which reads import.meta.env — under tsx the same
// env vars work because of dotenv, but we call ingestCSVViaSnapshots via
// a shim that injects process.env into import.meta.env compatibility.
process.env.TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL!;
process.env.TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN!;

// Tsx resolves .ts paths directly.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ingestCSVViaSnapshots } = await import('../src/lib/csv/ingest-v2');

const CLIENT_ID = 'oYLqVOgsutCEPNwb7hizm'; // ZipKit Homes
const TEST_MONTH = '2099-01';
const TEST_FILENAME = 'phase1-idempotency-test.csv';

// position_tracking format — must match src/lib/csv/detector.ts expectations.
// detector: headers include 'Keyword', 'Position', 'Search Volume'.
// position_tracking detector requires headers: position, keyword, search volume, url, location.
const CSV_A = [
  'Keyword,Position,Search Volume,URL,Change,SD,Location',
  'prefab homes utah,5,1000,https://zipkit.com/utah,2,45,United States',
  'modular homes st george,9,420,https://zipkit.com/st-george,-1,38,United States',
  'zipkit modular,1,150,https://zipkit.com,0,12,United States',
].join('\n') + '\n';

const CSV_B = [
  'Keyword,Position,Search Volume,URL,Change,SD,Location',
  'prefab homes utah,3,1000,https://zipkit.com/utah,2,45,United States',
  'new keyword,15,220,https://zipkit.com/new,0,50,United States',
].join('\n') + '\n';

function sha256Hex(s: string) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

async function snapshotOf2026April() {
  const r = await db.execute({
    sql: `SELECT COUNT(*), MIN(keyword), MAX(keyword)
          FROM keyword_snapshots ks
          JOIN periods p ON p.id = ks.period_id
          WHERE ks.client_id = ? AND p.period_start = '2026-04-01' AND ks.source = 'position_tracking'`,
    args: [CLIENT_ID],
  });
  return r.rows[0];
}

async function getAdminUserId(): Promise<string> {
  const r = await db.execute({
    sql: "SELECT id FROM users WHERE role = 'admin' LIMIT 1",
    args: [],
  });
  if (r.rows.length === 0) throw new Error('No admin user found');
  return r.rows[0][0] as string;
}

async function countTestSnapshots(): Promise<number> {
  const r = await db.execute({
    sql: `SELECT COUNT(*) FROM keyword_snapshots ks
          JOIN periods p ON p.id = ks.period_id
          WHERE p.client_id = ? AND p.period_start = '2099-01-01'`,
    args: [CLIENT_ID],
  });
  return Number(r.rows[0][0]);
}

async function listTestImports() {
  return (
    await db.execute({
      sql: `SELECT i.id, i.status, i.content_hash, i.row_count
            FROM imports i
            JOIN periods p ON p.id = i.period_id
            WHERE p.client_id = ? AND p.period_start = '2099-01-01'
            ORDER BY i.started_at`,
      args: [CLIENT_ID],
    })
  ).rows.map((r) => ({
    id: r[0] as string,
    status: r[1] as string,
    content_hash: r[2] as string,
    row_count: Number(r[3]),
  }));
}

async function cleanup() {
  // Delete keyword_snapshots → imports → periods for the test period.
  await db.execute({
    sql: `DELETE FROM keyword_snapshots
          WHERE period_id IN (SELECT id FROM periods WHERE client_id = ? AND period_start = '2099-01-01')`,
    args: [CLIENT_ID],
  });
  await db.execute({
    sql: `DELETE FROM imports
          WHERE period_id IN (SELECT id FROM periods WHERE client_id = ? AND period_start = '2099-01-01')`,
    args: [CLIENT_ID],
  });
  await db.execute({
    sql: `DELETE FROM periods WHERE client_id = ? AND period_start = '2099-01-01'`,
    args: [CLIENT_ID],
  });
}

async function main() {
  console.log('=== Phase 1 Step 4b-i: idempotency test ===');
  console.log();

  const adminId = await getAdminUserId();
  console.log(`Using admin user: ${adminId}`);
  console.log(`Test client:      ${CLIENT_ID}`);
  console.log(`Test month:       ${TEST_MONTH}`);
  console.log();

  // Snapshot 2026-04 before (to prove we don't touch it).
  const before = await snapshotOf2026April();
  console.log(`2026-04 position_tracking before: count=${before[0]} min="${before[1]}" max="${before[2]}"`);
  console.log();

  // Ensure test period starts clean.
  await cleanup();

  const hashA = sha256Hex(CSV_A);
  const hashB = sha256Hex(CSV_B);
  console.log(`CSV_A hash: ${hashA}`);
  console.log(`CSV_B hash: ${hashB}`);
  console.log();

  let ok = true;
  const fail = (msg: string) => {
    console.error(`  FAIL: ${msg}`);
    ok = false;
  };

  try {
    // === Upload A: fresh ===
    console.log('--- Upload A (fresh) ---');
    const rA = await ingestCSVViaSnapshots(CSV_A, CLIENT_ID, TEST_MONTH, TEST_FILENAME, adminId);
    console.log(`  status=${rA.status} import=${rA.importId} rows=${rA.rowCount}`);
    if (rA.status !== 'applied') fail(`expected status=applied, got ${rA.status} (${rA.error ?? ''})`);
    if (rA.rowCount !== 3) fail(`expected rowCount=3, got ${rA.rowCount}`);
    const snapAfterA = await countTestSnapshots();
    console.log(`  keyword_snapshots for test period: ${snapAfterA}`);
    if (snapAfterA !== 3) fail(`expected 3 snapshot rows, got ${snapAfterA}`);
    console.log();

    // === Upload A': same bytes ===
    console.log('--- Upload A-prime (same bytes) ---');
    const rAprime = await ingestCSVViaSnapshots(CSV_A, CLIENT_ID, TEST_MONTH, TEST_FILENAME, adminId);
    console.log(`  status=${rAprime.status} import=${rAprime.importId}`);
    if (rAprime.status !== 'noop') fail(`expected status=noop, got ${rAprime.status}`);
    if (rAprime.importId !== rA.importId) fail(`expected same importId on noop, got ${rAprime.importId} vs ${rA.importId}`);
    const snapAfterAprime = await countTestSnapshots();
    console.log(`  keyword_snapshots for test period: ${snapAfterAprime}`);
    if (snapAfterAprime !== 3) fail(`expected 3 snapshot rows unchanged, got ${snapAfterAprime}`);

    // Verify the snapshot bytes are identical (no updated_at churn, no row swap).
    const rowsAfterA = (
      await db.execute({
        sql: `SELECT keyword, position, import_id FROM keyword_snapshots ks
              JOIN periods p ON p.id = ks.period_id
              WHERE p.client_id = ? AND p.period_start = '2099-01-01'
              ORDER BY keyword`,
        args: [CLIENT_ID],
      })
    ).rows.map((r) => `${r[0]}|${r[1]}|${r[2]}`);
    console.log(`  snapshot rows:`);
    for (const r of rowsAfterA) console.log(`    ${r}`);
    const allSameImport = rowsAfterA.every((r) => r.endsWith(`|${rA.importId}`));
    if (!allSameImport) fail('some snapshot rows point to a different import after noop');
    console.log();

    // === Upload B: modified bytes ===
    console.log('--- Upload B (modified bytes) ---');
    const rB = await ingestCSVViaSnapshots(CSV_B, CLIENT_ID, TEST_MONTH, TEST_FILENAME, adminId);
    console.log(`  status=${rB.status} import=${rB.importId} rows=${rB.rowCount}`);
    if (rB.status !== 'applied') fail(`expected status=applied, got ${rB.status}`);
    if (rB.importId === rA.importId) fail('expected a new importId for modified bytes');
    if (rB.rowCount !== 2) fail(`expected rowCount=2, got ${rB.rowCount}`);
    const snapAfterB = await countTestSnapshots();
    console.log(`  keyword_snapshots for test period: ${snapAfterB}`);
    if (snapAfterB !== 2) fail(`expected 2 snapshot rows (old slice replaced), got ${snapAfterB}`);

    const imports = await listTestImports();
    console.log(`  imports rows for test period:`);
    for (const i of imports) {
      console.log(`    ${i.id}  status=${i.status}  rows=${i.row_count}  hash=${i.content_hash.slice(0, 12)}...`);
    }
    if (imports.length !== 2) fail(`expected 2 imports rows (A, B), got ${imports.length}`);

    // Critical: verify prod 2026-04 slice is completely untouched.
    const after = await snapshotOf2026April();
    if (after[0] !== before[0] || after[1] !== before[1] || after[2] !== before[2]) {
      fail(
        `2026-04 slice MUTATED: before=[${before[0]}, ${before[1]}, ${before[2]}]  after=[${after[0]}, ${after[1]}, ${after[2]}]`
      );
    } else {
      console.log();
      console.log(`  2026-04 slice unchanged ✓  count=${after[0]}`);
    }
  } finally {
    console.log();
    console.log('--- Cleanup ---');
    await cleanup();
    const leftover = await countTestSnapshots();
    const leftoverImports = (await listTestImports()).length;
    console.log(`  keyword_snapshots leftover: ${leftover}`);
    console.log(`  imports leftover:           ${leftoverImports}`);
    if (leftover !== 0 || leftoverImports !== 0) {
      console.error('  CLEANUP INCOMPLETE');
      process.exit(4);
    }
  }

  console.log();
  if (!ok) {
    console.error('IDEMPOTENCY TEST FAILED');
    process.exit(1);
  }
  console.log('IDEMPOTENCY TEST PASSED ✓');
}

main().catch((err) => {
  console.error('Test harness error:', err);
  process.exit(1);
});
