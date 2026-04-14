// Phase 1 Slice 9 — test that successful CSV ingestion stamps the
// matching data_source_bindings row's last_seen_at.
//
// Exercises three layers:
//
//   1. csvFormatToDataSourceKind — pure mapping unit tests, every
//      declared CSV format plus 'unknown' / null fallback.
//
//   2. touchBindingsForClient — direct helper call against a freshly
//      provisioned contract with one binding. Returns row count; the
//      row's last_seen_at must flip from null to a recent timestamp.
//      Also verifies the helper is scoped by (client_id, source) so
//      bindings for other sources on the same client are not touched.
//
//   3. End-to-end ingest stamp — provisions a contract with a
//      position_tracking binding, uploads a minimal synthetic
//      position_tracking CSV via ingestCSVViaSnapshots, and asserts
//      the binding's last_seen_at was bumped post-commit.
//
// All writes target the live Turso DB under the ZipKit test client.
// Every created row is cleaned up on both success and failure paths.
//
// Run:
//   npx tsx scripts/phase1-test-ingest-touch.ts

import 'dotenv/config';
import { createClient } from '@libsql/client';
import { provisionContract, deleteContract } from '../src/lib/contracts';
import {
  csvFormatToDataSourceKind,
  touchBindingsForClient,
  getBindingsForContract,
  type DataSourceKind,
} from '../src/lib/data-sources';
import { ingestCSVViaSnapshots } from '../src/lib/csv/ingest-v2';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) {
  console.error('TURSO_DATABASE_URL is not set');
  process.exit(1);
}
const db = createClient({ url, authToken });

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error('ASSERT FAILED:', msg);
    throw new Error(msg);
  }
}
function eq<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) {
    console.error(`ASSERT FAILED: ${label}`);
    console.error(`  expected: ${JSON.stringify(expected)}`);
    console.error(`  actual:   ${JSON.stringify(actual)}`);
    throw new Error(label);
  }
}

async function findTestClient(): Promise<{ id: string; adminUserId: string }> {
  const clientRes = await db.execute({
    sql: 'SELECT id FROM clients WHERE slug = ? OR name LIKE ? LIMIT 1',
    args: ['zipkit-homes', '%ZipKit%'],
  });
  assert(clientRes.rows.length > 0, 'ZipKit test client not found');
  const adminRes = await db.execute({
    sql: `SELECT id FROM users WHERE role = 'admin' LIMIT 1`,
  });
  assert(adminRes.rows.length > 0, 'No admin user found');
  return {
    id: String(clientRes.rows[0][0]),
    adminUserId: String(adminRes.rows[0][0]),
  };
}

// Minimal CSV that passes detector.ts signature for position_tracking:
// requiredColumns: ['position', 'keyword', 'search volume', 'url', 'location']
const MINIMAL_POSITION_TRACKING_CSV = [
  'Position,Keyword,Search Volume,URL,Location',
  '1,slice 9 test keyword,100,https://example.com/a,United States',
  '2,slice 9 test keyword alt,50,https://example.com/b,United States',
].join('\n');

// Helper — read the current last_seen_at for one (contract, source)
// pair so the test can observe the stamp transition.
async function readLastSeen(contractId: string, source: DataSourceKind): Promise<string | null> {
  const r = await db.execute({
    sql: `SELECT last_seen_at FROM data_source_bindings
          WHERE contract_id = ? AND source = ?`,
    args: [contractId, source],
  });
  if (r.rows.length === 0) return null;
  return (r.rows[0][0] as string | null) ?? null;
}

async function main() {
  console.log('=== Slice 9 test: ingest → touchBinding ===');
  console.log();

  // --- 1. csvFormatToDataSourceKind unit tests ---
  console.log('--- csvFormatToDataSourceKind ---');
  eq(csvFormatToDataSourceKind('position_tracking'), 'ubersuggest_position_tracking', 'position_tracking');
  eq(csvFormatToDataSourceKind('keyword_research'), 'ubersuggest_keyword_research', 'keyword_research');
  eq(csvFormatToDataSourceKind('keyword_suggestions'), 'ubersuggest_keyword_research', 'keyword_suggestions');
  eq(csvFormatToDataSourceKind('site_audit'), 'ubersuggest_site_audit', 'site_audit');
  eq(csvFormatToDataSourceKind('issues_overview'), 'ubersuggest_site_audit', 'issues_overview');
  eq(csvFormatToDataSourceKind('crawl_overview'), 'ubersuggest_site_audit', 'crawl_overview');
  eq(csvFormatToDataSourceKind('image_optimization'), 'ubersuggest_site_audit', 'image_optimization');
  eq(csvFormatToDataSourceKind('accessibility'), 'ubersuggest_site_audit', 'accessibility');
  eq(csvFormatToDataSourceKind('unknown'), null, 'unknown → null');
  eq(csvFormatToDataSourceKind('gibberish'), null, 'gibberish → null');
  console.log('  mapping OK');
  console.log();

  // --- 2. Provision a contract with three bindings, test helper ---
  const testClient = await findTestClient();
  const testTitle = `slice-9-test ${new Date().toISOString()}`;
  const provision = await provisionContract({
    client_id: testClient.id,
    title: testTitle,
    type: 'retainer',
    billing_cadence: 'monthly',
    billing_day: 9,
    recurring_amount: 500,
    data_sources: [
      { source: 'ubersuggest_position_tracking', enabled: true },
      { source: 'ubersuggest_site_audit', enabled: true },
      { source: 'gsc', enabled: false },
    ],
    created_by: testClient.adminUserId,
  });
  console.log(`  provisioned test contract ${provision.contract_id.slice(0, 10)}`);

  // Track cleanup targets so finally-block can reach them on any throw.
  const cleanup = {
    contractId: provision.contract_id,
    scheduledJobId: provision.scheduled_job_id,
    importIds: [] as string[],
    periodIds: new Set<string>(),
  };

  try {
    // --- 2a. touchBindingsForClient direct test ---
    console.log('--- touchBindingsForClient direct ---');
    const before = await readLastSeen(provision.contract_id, 'ubersuggest_position_tracking');
    eq(before, null, 'last_seen_at starts null for position_tracking');

    const otherBefore = await readLastSeen(provision.contract_id, 'ubersuggest_site_audit');
    eq(otherBefore, null, 'last_seen_at starts null for site_audit');

    const touched = await touchBindingsForClient(testClient.id, 'ubersuggest_position_tracking');
    assert(touched >= 1, `touched at least one binding (got ${touched})`);

    const afterPT = await readLastSeen(provision.contract_id, 'ubersuggest_position_tracking');
    assert(afterPT !== null, 'position_tracking last_seen_at now set');

    const afterSA = await readLastSeen(provision.contract_id, 'ubersuggest_site_audit');
    eq(afterSA, null, 'site_audit last_seen_at untouched (different source)');
    console.log(`  direct touch stamped PT only. count=${touched}`);
    console.log();

    // Null out the stamp before the ingest test so we can observe
    // ingest-v2 re-stamping it via the end-to-end path.
    await db.execute({
      sql: `UPDATE data_source_bindings SET last_seen_at = NULL
            WHERE contract_id = ? AND source = ?`,
      args: [provision.contract_id, 'ubersuggest_position_tracking'],
    });
    const reset = await readLastSeen(provision.contract_id, 'ubersuggest_position_tracking');
    eq(reset, null, 'last_seen_at reset before ingest test');

    // --- 3. End-to-end: ingest a real CSV and verify the stamp ---
    console.log('--- ingestCSVViaSnapshots end-to-end ---');

    // CRITICAL SAFETY: ingest-v2 snapshot-replaces every existing row
    // for (client_id, period_id, source) before inserting. If this
    // test ever targeted a month that holds real production data for
    // the same source, it would destroy that data. Use a far-future
    // month that cannot possibly overlap with real ZipKit ingestion.
    const monthStr = '2099-01';

    // Hard preflight: abort if any production-like rows already exist
    // under this month+source for the test client. This should always
    // be zero; if it isn't, we'd rather stop than risk clobbering.
    const preflightPeriod = await db.execute({
      sql: `SELECT id FROM periods WHERE client_id = ? AND period_type = 'month' AND period_start = ?`,
      args: [testClient.id, '2099-01-01'],
    });
    if (preflightPeriod.rows.length > 0) {
      const existingPid = preflightPeriod.rows[0][0] as string;
      const rowsThere = await db.execute({
        sql: `SELECT COUNT(*) FROM keyword_snapshots
              WHERE client_id = ? AND period_id = ? AND source = 'position_tracking'`,
        args: [testClient.id, existingPid],
      });
      if (Number(rowsThere.rows[0][0]) !== 0) {
        throw new Error(
          `Preflight failed: ${rowsThere.rows[0][0]} existing position_tracking rows for ${testClient.id} in 2099-01. Not safe to run snapshot-replace ingest.`
        );
      }
    }

    // Salt the CSV so re-running the test against the same month and
    // the same client produces a different content_hash — otherwise
    // the second run hits the "noop" idempotency branch.
    const salt = `,${nanoidTag()}`;
    const salted = MINIMAL_POSITION_TRACKING_CSV.replace(
      ',United States',
      ',United States' + salt
    );

    const ingestResult = await ingestCSVViaSnapshots(
      salted,
      testClient.id,
      monthStr,
      'slice-9-test-position-tracking.csv',
      testClient.adminUserId
    );

    console.log(`  ingest result: status=${ingestResult.status} format=${ingestResult.format} rows=${ingestResult.rowCount}`);
    eq(ingestResult.status, 'applied', 'ingest status applied');
    eq(ingestResult.format, 'position_tracking', 'ingest format position_tracking');
    assert(ingestResult.rowCount > 0, 'ingest stored at least one row');

    cleanup.importIds.push(ingestResult.importId);
    cleanup.periodIds.add(ingestResult.periodId);

    const stampedAfterIngest = await readLastSeen(provision.contract_id, 'ubersuggest_position_tracking');
    assert(stampedAfterIngest !== null, 'last_seen_at stamped by ingest-v2 post-commit');

    const stampTs = new Date(stampedAfterIngest + 'Z').getTime();
    const skew = Math.abs(Date.now() - stampTs);
    assert(skew < 5 * 60 * 1000, `stamp is within 5 min of now (skew=${skew}ms, raw=${stampedAfterIngest})`);
    console.log(`  post-ingest stamp: ${stampedAfterIngest} (skew ${skew}ms from now)`);
    console.log();

    // Sanity: site_audit binding still untouched after an ingest of a
    // different CSV format. Proves the helper's source filter matters.
    const siteAuditAfterPTIngest = await readLastSeen(provision.contract_id, 'ubersuggest_site_audit');
    eq(
      siteAuditAfterPTIngest,
      null,
      'site_audit binding still null after position_tracking ingest'
    );
    console.log('  source filter honored: site_audit binding untouched');
    console.log();
  } finally {
    // --- Cleanup ---
    console.log('--- cleanup ---');

    // Delete snapshot rows + import rows created by the ingest.
    for (const importId of cleanup.importIds) {
      await db.execute({
        sql: 'DELETE FROM keyword_snapshots WHERE import_id = ?',
        args: [importId],
      });
      await db.execute({
        sql: 'DELETE FROM issue_snapshots WHERE import_id = ?',
        args: [importId],
      });
      await db.execute({
        sql: 'DELETE FROM metric_snapshots WHERE import_id = ?',
        args: [importId],
      });
      await db.execute({
        sql: 'DELETE FROM imports WHERE id = ?',
        args: [importId],
      });
    }

    // Delete any periods we created that now have no imports hanging off
    // them. Safer than blanket DELETE because ZipKit has legitimate
    // period rows from prior production ingests we must not touch.
    for (const periodId of cleanup.periodIds) {
      const remainingImports = await db.execute({
        sql: 'SELECT COUNT(*) FROM imports WHERE period_id = ?',
        args: [periodId],
      });
      if (Number(remainingImports.rows[0][0]) === 0) {
        // But also check no snapshots still reference it from an earlier run.
        const snapRefs = await db.execute({
          sql: `SELECT
                  (SELECT COUNT(*) FROM keyword_snapshots WHERE period_id = ?) +
                  (SELECT COUNT(*) FROM issue_snapshots WHERE period_id = ?) +
                  (SELECT COUNT(*) FROM metric_snapshots WHERE period_id = ?)`,
          args: [periodId, periodId, periodId],
        });
        if (Number(snapRefs.rows[0][0]) === 0) {
          await db.execute({
            sql: 'DELETE FROM periods WHERE id = ?',
            args: [periodId],
          });
        }
      }
    }

    // Bindings are cascaded by contract_id. Delete explicitly since
    // deleteContract does not touch data_source_bindings yet.
    await db.execute({
      sql: 'DELETE FROM data_source_bindings WHERE contract_id = ?',
      args: [cleanup.contractId],
    });
    if (cleanup.scheduledJobId) {
      await db.execute({
        sql: 'DELETE FROM scheduled_jobs WHERE id = ?',
        args: [cleanup.scheduledJobId],
      });
    }
    await db.execute({
      sql: 'DELETE FROM activity_log WHERE entity_type = ? AND entity_id = ?',
      args: ['contract', cleanup.contractId],
    });
    await deleteContract(cleanup.contractId);

    const leftover = await db.execute({
      sql: 'SELECT COUNT(*) FROM data_source_bindings WHERE contract_id = ?',
      args: [cleanup.contractId],
    });
    eq(Number(leftover.rows[0][0]), 0, 'no binding rows remain');
    const contractLeftover = await db.execute({
      sql: 'SELECT COUNT(*) FROM contracts WHERE id = ?',
      args: [cleanup.contractId],
    });
    eq(Number(contractLeftover.rows[0][0]), 0, 'contract row removed');

    console.log('  cleanup complete');
    console.log();
  }

  console.log('SLICE 9 TEST PASSED ✓');
}

// Small id-ish suffix so the CSV content_hash differs per run without
// pulling in another dependency.
function nanoidTag(): string {
  return Math.random().toString(36).slice(2, 10);
}

main().catch((err) => {
  console.error();
  console.error('SLICE 9 TEST FAILED:', err);
  process.exit(1);
});
