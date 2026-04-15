// Slice 18e — scheduled Google sync automation tests.
//
// Five cases covering the job-scheduling layer (the sync functions
// themselves are already proven in slice 18 / 18b):
//
//   1. sync_gsc job runs through runner and re-enqueues for next month
//   2. sync_ga4 job runs through runner and re-enqueues for next month
//   3. duplicate runner calls don't multiply future jobs
//   4. locked-period failure is honest (no re-enqueue)
//   5. missing-config failure is honest (no re-enqueue)
//
// Isolation: ZipKit + tagged synthetic contracts + synthetic google_
// connections row. Uses periods '2099-05' / '2099-06' / '2099-07'
// to stay disjoint from slice 18 ('01'/'02') and slice 18b ('03').
// Injects fake GSC/GA4 clients via __setGoogleClientsForJobs so the
// runner never makes a real HTTP call. Cleanup in try/finally on
// both success and error paths.
//
// Run:
//   npx tsx scripts/phase1-test-slice18e-sync-jobs.ts

import 'dotenv/config';
import { createClient } from '@libsql/client';
import { nanoid } from 'nanoid';
import crypto from 'node:crypto';

import { runDueJobs, enqueueJob } from '../src/lib/jobs/runner';
import {
  __setGoogleClientsForJobs,
  nextMonth,
  previousMonth,
  syncRunDateFor,
  currentUtcMonth,
  seedInitialSyncJob,
} from '../src/lib/jobs/google-sync-jobs';
import {
  type GscClient,
  type SearchAnalyticsResponse,
} from '../src/lib/google/gsc';
import {
  type Ga4Client,
  type Ga4RunReportRequest,
  type Ga4RunReportResponse,
} from '../src/lib/google/ga4';
import { GSC_SCOPE, GA4_SCOPE } from '../src/lib/google/oauth';
import { createConnection, deleteConnection } from '../src/lib/google/connections';
import { provisionContract, deleteContract } from '../src/lib/contracts';
import { lockPeriod, unlockPeriod } from '../src/lib/periods';

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

// Same env-stub pattern as slice 18 / 18b so the crypto + connection
// helpers have what they need.
if (!process.env.GOOGLE_TOKEN_KEY) {
  process.env.GOOGLE_TOKEN_KEY = crypto.randomBytes(32).toString('base64');
}

async function findTestClient(): Promise<{ id: string; adminUserId: string }> {
  const c = await db.execute({
    sql: 'SELECT id FROM clients WHERE slug = ? OR name LIKE ? LIMIT 1',
    args: ['zipkit-homes', '%ZipKit%'],
  });
  assert(c.rows.length > 0, 'ZipKit missing');
  const a = await db.execute({
    sql: `SELECT id FROM users WHERE role = 'admin' LIMIT 1`,
  });
  assert(a.rows.length > 0, 'no admin user');
  return { id: String(c.rows[0][0]), adminUserId: String(a.rows[0][0]) };
}

// --- Fake GSC client (same fixture as slice 18) ---
const GSC_FIXTURE: SearchAnalyticsResponse = {
  rows: [
    { keys: ['panelized home kits', 'https://zipkithomes.com/'], clicks: 12, impressions: 340, ctr: 0.035, position: 4.2 },
    { keys: ['modular homes utah', 'https://zipkithomes.com/about'], clicks: 6, impressions: 120, ctr: 0.05, position: 11.8 },
    { keys: ['prefab home kits', 'https://zipkithomes.com/'], clicks: 3, impressions: 80, ctr: 0.0375, position: 22.3 },
    { keys: ['kit home builders', 'https://zipkithomes.com/models'], clicks: 1, impressions: 20, ctr: 0.05, position: 35.0 },
  ],
};
class FakeGscClient implements GscClient {
  calls: Array<{ property: string; startDate: string; endDate: string }> = [];
  async listSites(_accessToken: string) {
    return [{ siteUrl: 'sc-domain:zipkithomes.com', permissionLevel: 'siteOwner' }];
  }
  async querySearchAnalytics(_accessToken: string, siteUrl: string, req: any) {
    this.calls.push({ property: siteUrl, startDate: req.startDate, endDate: req.endDate });
    return GSC_FIXTURE;
  }
}

// --- Fake GA4 client ---
// Returns five traffic metrics matching the GA4_METRIC_MAP keys used
// in slice 18b. Values are arbitrary but non-zero so the handler
// writes a full snapshot.
// Matches GA4_METRIC_MAP order exactly: sessions, totalUsers,
// screenPageViews, engagedSessions, engagementRate. Maps to 5
// staged metrics after mapGa4ResponseToMetrics runs.
const GA4_FIXTURE: Ga4RunReportResponse = {
  metricHeaders: [
    { name: 'sessions', type: 'TYPE_INTEGER' },
    { name: 'totalUsers', type: 'TYPE_INTEGER' },
    { name: 'screenPageViews', type: 'TYPE_INTEGER' },
    { name: 'engagedSessions', type: 'TYPE_INTEGER' },
    { name: 'engagementRate', type: 'TYPE_FLOAT' },
  ],
  rows: [
    {
      dimensionValues: [],
      metricValues: [
        { value: '240' },
        { value: '180' },
        { value: '620' },
        { value: '150' },
        { value: '0.625' },
      ],
    },
  ],
  rowCount: 1,
};
class FakeGa4Client implements Ga4Client {
  calls: Array<{ property: string; req: Ga4RunReportRequest }> = [];
  async runReport(_accessToken: string, property: string, req: Ga4RunReportRequest) {
    this.calls.push({ property, req });
    return GA4_FIXTURE;
  }
}

function backdatedIso(): string {
  return new Date(Date.now() - 60 * 1000).toISOString();
}

async function countPendingSyncJobs(
  jobType: 'sync_gsc' | 'sync_ga4',
  bindingId: string
): Promise<number> {
  const r = await db.execute({
    sql: `SELECT COUNT(*) FROM scheduled_jobs
          WHERE job_type = ?
            AND status = 'pending'
            AND payload_json LIKE ?`,
    args: [jobType, `%"binding_id":"${bindingId}"%`],
  });
  return Number(r.rows[0][0]);
}

async function getJobRow(id: string): Promise<{
  status: string;
  last_result: string | null;
  scheduled_for: string;
  payload_json: string | null;
} | null> {
  const r = await db.execute({
    sql: `SELECT status, last_result, scheduled_for, payload_json
          FROM scheduled_jobs WHERE id = ?`,
    args: [id],
  });
  if (r.rows.length === 0) return null;
  return {
    status: String(r.rows[0][0]),
    last_result: r.rows[0][1] as string | null,
    scheduled_for: String(r.rows[0][2]),
    payload_json: r.rows[0][3] as string | null,
  };
}

async function findSoleNextSyncJob(
  jobType: 'sync_gsc' | 'sync_ga4',
  bindingId: string,
  expectedMonth: string
): Promise<{ id: string; scheduled_for: string } | null> {
  const r = await db.execute({
    sql: `SELECT id, scheduled_for FROM scheduled_jobs
          WHERE job_type = ?
            AND status = 'pending'
            AND payload_json LIKE ?
            AND payload_json LIKE ?`,
    args: [
      jobType,
      `%"binding_id":"${bindingId}"%`,
      `%"month":"${expectedMonth}"%`,
    ],
  });
  if (r.rows.length === 0) return null;
  return {
    id: String(r.rows[0][0]),
    scheduled_for: String(r.rows[0][1]),
  };
}

async function main() {
  console.log('=== Slice 18e test: scheduled Google sync automation ===');
  console.log();

  const testClient = await findTestClient();

  // --- Month-arithmetic unit checks (pure, no DB) ---
  console.log('--- 0. month arithmetic ---');
  eq(nextMonth('2099-05'), '2099-06', 'nextMonth basic');
  eq(nextMonth('2099-12'), '2100-01', 'nextMonth year rollover');
  eq(previousMonth('2099-05'), '2099-04', 'previousMonth basic');
  eq(previousMonth('2100-01'), '2099-12', 'previousMonth year rollover');
  eq(
    syncRunDateFor('2099-06'),
    '2099-07-02T08:00:00.000Z',
    'syncRunDateFor: syncing month M runs on day 2 of M+1'
  );
  eq(
    syncRunDateFor('2099-12'),
    '2100-01-02T08:00:00.000Z',
    'syncRunDateFor: year rollover'
  );
  eq(/^\d{4}-\d{2}$/.test(currentUtcMonth()), true, 'currentUtcMonth shape');
  console.log('  OK');
  console.log();

  // --- Preflight: verify no stale 2099 test rows exist ---
  const preflight = await db.execute({
    sql: `SELECT COUNT(*) FROM periods
          WHERE client_id = ? AND period_start IN
          ('2099-05-01', '2099-06-01', '2099-07-01', '2099-08-01')`,
    args: [testClient.id],
  });
  assert(
    Number(preflight.rows[0][0]) === 0,
    'no pre-existing 2099-05..08 periods for test client — refusing to run'
  );

  // --- Set up the primary test contract with BOTH gsc + ga4 bindings ---
  const provision = await provisionContract({
    client_id: testClient.id,
    title: `slice-18e-test-${nanoid(5)}`,
    type: 'retainer',
    service_type: 'web_management',
    data_sources: [
      { source: 'gsc', enabled: true },
      { source: 'ga4', enabled: true },
    ],
    created_by: testClient.adminUserId,
  });

  // Create one synthetic google_connections row reused by both bindings.
  const connectionId = await createConnection({
    admin_user_id: testClient.adminUserId,
    google_account_email: `slice18e-${nanoid(5)}@test.example`,
    refresh_token: 'fake-refresh-token-' + nanoid(20),
    access_token: 'fake-access-token-' + nanoid(20),
    access_token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    scopes: [GSC_SCOPE, GA4_SCOPE],
  });

  // Pull the two binding ids by source so the ordering from provision
  // doesn't matter.
  const bindingRows = await db.execute({
    sql: `SELECT id, source FROM data_source_bindings WHERE contract_id = ?`,
    args: [provision.contract_id],
  });
  const gscBindingId = String(
    bindingRows.rows.find((r) => String(r[1]) === 'gsc')?.[0] ?? ''
  );
  const ga4BindingId = String(
    bindingRows.rows.find((r) => String(r[1]) === 'ga4')?.[0] ?? ''
  );
  assert(gscBindingId, 'gsc binding id resolved');
  assert(ga4BindingId, 'ga4 binding id resolved');

  // Bind both bindings with config_json pointing at the same connection.
  await db.execute({
    sql: `UPDATE data_source_bindings SET config_json = ?, enabled = 1 WHERE id = ?`,
    args: [
      JSON.stringify({ connection_id: connectionId, property: 'sc-domain:zipkithomes.com' }),
      gscBindingId,
    ],
  });
  await db.execute({
    sql: `UPDATE data_source_bindings SET config_json = ?, enabled = 1 WHERE id = ?`,
    args: [
      JSON.stringify({ connection_id: connectionId, property: 'properties/123456789' }),
      ga4BindingId,
    ],
  });

  // Inject fake clients for the rest of the run.
  const fakeGsc = new FakeGscClient();
  const fakeGa4 = new FakeGa4Client();
  __setGoogleClientsForJobs({ gsc: fakeGsc, ga4: fakeGa4 });

  // Track periods / extra contracts / extra job ids that must be cleaned up.
  const periodIdsToCleanup: string[] = [];
  let extraContractId: string | null = null;
  let extraBindingId: string | null = null;
  const extraJobIds: string[] = [];

  try {
    // -------------------------------------------------------------
    // Test 18e.1 — sync_gsc runs through runner and re-enqueues once
    // -------------------------------------------------------------
    console.log('--- 18e.1 sync_gsc runs + re-enqueues ---');
    const gscJobId = await enqueueJob('sync_gsc', backdatedIso(), {
      binding_id: gscBindingId,
      month: '2099-05',
      created_by: testClient.adminUserId,
    });
    extraJobIds.push(gscJobId);

    const run1 = await runDueJobs(10);
    assert(run1.ranJobIds.includes(gscJobId), 'runner ran the sync_gsc job');
    assert(run1.failedJobIds.length === 0, 'no runner-level failures');

    const gscRow = await getJobRow(gscJobId);
    assert(gscRow !== null, 'sync_gsc row still exists');
    eq(gscRow!.status, 'done', 'sync_gsc status=done');
    assert(
      /sync_gsc/.test(gscRow!.last_result ?? '') &&
        /applied/.test(gscRow!.last_result ?? '') &&
        /rows=4/.test(gscRow!.last_result ?? ''),
      `last_result shape: ${gscRow!.last_result}`
    );
    assert(
      /re_queued=1/.test(gscRow!.last_result ?? ''),
      `re_queued=1 in last_result: ${gscRow!.last_result}`
    );

    // Verify the keyword_snapshots actually landed — honest proof the
    // sync function ran, not just a string assertion.
    const gscPeriod = await db.execute({
      sql: `SELECT id FROM periods
            WHERE client_id = ? AND period_type = 'month' AND period_start = '2099-05-01'`,
      args: [testClient.id],
    });
    assert(gscPeriod.rows.length === 1, 'gsc 2099-05 period created');
    const gscPeriodId = String(gscPeriod.rows[0][0]);
    periodIdsToCleanup.push(gscPeriodId);
    const gscSnaps = await db.execute({
      sql: `SELECT COUNT(*) FROM keyword_snapshots
            WHERE client_id = ? AND period_id = ? AND source = 'gsc'`,
      args: [testClient.id, gscPeriodId],
    });
    eq(Number(gscSnaps.rows[0][0]), 4, 'gsc snapshot rows=4');

    // The re-enqueue: exactly one pending sync_gsc for this binding at
    // month 2099-06, scheduled for 2099-07-02 08:00Z.
    const gscNext = await findSoleNextSyncJob('sync_gsc', gscBindingId, '2099-06');
    assert(gscNext !== null, 'next sync_gsc for 2099-06 exists');
    extraJobIds.push(gscNext!.id);
    eq(
      gscNext!.scheduled_for,
      '2099-07-02T08:00:00.000Z',
      'next sync_gsc scheduled_for'
    );
    eq(
      await countPendingSyncJobs('sync_gsc', gscBindingId),
      1,
      'exactly one pending sync_gsc for gsc binding'
    );
    console.log('  OK');
    console.log();

    // -------------------------------------------------------------
    // Test 18e.2 — sync_ga4 mirror
    // -------------------------------------------------------------
    console.log('--- 18e.2 sync_ga4 runs + re-enqueues ---');
    const ga4JobId = await enqueueJob('sync_ga4', backdatedIso(), {
      binding_id: ga4BindingId,
      month: '2099-05',
      created_by: testClient.adminUserId,
    });
    extraJobIds.push(ga4JobId);

    const run2 = await runDueJobs(10);
    assert(run2.ranJobIds.includes(ga4JobId), 'runner ran the sync_ga4 job');
    const ga4Row = await getJobRow(ga4JobId);
    eq(ga4Row!.status, 'done', 'sync_ga4 status=done');
    assert(
      /sync_ga4/.test(ga4Row!.last_result ?? '') &&
        /applied/.test(ga4Row!.last_result ?? '') &&
        /rows=5/.test(ga4Row!.last_result ?? '') &&
        /re_queued=1/.test(ga4Row!.last_result ?? ''),
      `ga4 last_result: ${ga4Row!.last_result}`
    );

    // metric_snapshots landed? (5 traffic keys)
    const ga4Snaps = await db.execute({
      sql: `SELECT COUNT(*) FROM metric_snapshots
            WHERE client_id = ?
              AND period_id = (SELECT id FROM periods
                               WHERE client_id = ? AND period_start = '2099-05-01')
              AND source = 'ga4'`,
      args: [testClient.id, testClient.id],
    });
    eq(Number(ga4Snaps.rows[0][0]), 5, 'ga4 metric_snapshots rows=5');

    const ga4Next = await findSoleNextSyncJob('sync_ga4', ga4BindingId, '2099-06');
    assert(ga4Next !== null, 'next sync_ga4 for 2099-06 exists');
    extraJobIds.push(ga4Next!.id);
    eq(
      ga4Next!.scheduled_for,
      '2099-07-02T08:00:00.000Z',
      'next sync_ga4 scheduled_for'
    );
    eq(
      await countPendingSyncJobs('sync_ga4', ga4BindingId),
      1,
      'exactly one pending sync_ga4 for ga4 binding'
    );
    console.log('  OK');
    console.log();

    // -------------------------------------------------------------
    // Test 18e.3 — duplicate runner calls don't multiply future jobs
    // -------------------------------------------------------------
    console.log('--- 18e.3 duplicate runner calls are idempotent ---');
    const run3a = await runDueJobs(10);
    const run3b = await runDueJobs(10);
    // Neither call should claim any job — both '2099-06' rows are
    // scheduled for 2099-07-02 which is far in the future. No other
    // test jobs are due right now.
    eq(
      run3a.ranJobIds.filter((id) => extraJobIds.includes(id)).length,
      0,
      'run3a did not re-run any of our sync jobs'
    );
    eq(
      run3b.ranJobIds.filter((id) => extraJobIds.includes(id)).length,
      0,
      'run3b did not re-run any of our sync jobs'
    );
    eq(
      await countPendingSyncJobs('sync_gsc', gscBindingId),
      1,
      'pending sync_gsc count still 1 after duplicate runner calls'
    );
    eq(
      await countPendingSyncJobs('sync_ga4', ga4BindingId),
      1,
      'pending sync_ga4 count still 1 after duplicate runner calls'
    );
    console.log('  OK');
    console.log();

    // -------------------------------------------------------------
    // Test 18e.4 — locked-period failure is honest (no re-enqueue)
    // -------------------------------------------------------------
    console.log('--- 18e.4 locked period halts the chain honestly ---');
    // Create 2099-07 period upfront so we can lock it before the job runs.
    const lockPeriodId = nanoid();
    await db.execute({
      sql: `INSERT INTO periods (id, client_id, period_type, period_start, period_end)
            VALUES (?, ?, 'month', '2099-07-01', '2099-07-31')`,
      args: [lockPeriodId, testClient.id],
    });
    periodIdsToCleanup.push(lockPeriodId);
    await lockPeriod(lockPeriodId);

    const lockedJobId = await enqueueJob('sync_gsc', backdatedIso(), {
      binding_id: gscBindingId,
      month: '2099-07',
      created_by: testClient.adminUserId,
    });
    extraJobIds.push(lockedJobId);

    try {
      const run4 = await runDueJobs(10);
      assert(
        run4.ranJobIds.includes(lockedJobId),
        'runner ran the locked sync_gsc job'
      );
      const lockedRow = await getJobRow(lockedJobId);
      eq(lockedRow!.status, 'done', 'locked-period job status=done');
      assert(
        /failed/.test(lockedRow!.last_result ?? ''),
        `last_result contains 'failed': ${lockedRow!.last_result}`
      );
      assert(
        /locked/.test(lockedRow!.last_result ?? ''),
        `last_result mentions 'locked': ${lockedRow!.last_result}`
      );
      // No '2099-08' re-enqueue.
      const next08 = await findSoleNextSyncJob('sync_gsc', gscBindingId, '2099-08');
      eq(next08, null, 'no sync_gsc re-enqueue for 2099-08');
      // And the binding's total pending count is still 1 — the 2099-06
      // row from 18e.1, not a new one.
      eq(
        await countPendingSyncJobs('sync_gsc', gscBindingId),
        1,
        'pending sync_gsc count still 1 after locked failure'
      );
      // Failed import audit row recorded.
      const importAudit = await db.execute({
        sql: `SELECT COUNT(*) FROM imports
              WHERE client_id = ? AND period_id = ? AND source = 'gsc' AND status = 'failed'`,
        args: [testClient.id, lockPeriodId],
      });
      assert(
        Number(importAudit.rows[0][0]) >= 1,
        'failed import row recorded by sync function'
      );
    } finally {
      await unlockPeriod(lockPeriodId);
    }
    console.log('  OK');
    console.log();

    // -------------------------------------------------------------
    // Test 18e.5 — missing-config failure is honest (no re-enqueue)
    // -------------------------------------------------------------
    console.log('--- 18e.5 missing-config halts the chain honestly ---');
    // Provision a SECOND contract with a gsc binding whose config_json
    // stays NULL. Different binding id from gscBindingId so the state
    // from 18e.1 doesn't interfere.
    const extraProvision = await provisionContract({
      client_id: testClient.id,
      title: `slice-18e-noconfig-${nanoid(5)}`,
      type: 'fixed',
      data_sources: [{ source: 'gsc', enabled: true }],
      created_by: testClient.adminUserId,
    });
    extraContractId = extraProvision.contract_id;
    extraBindingId = extraProvision.binding_ids[0];
    // Leave config_json null, enabled 0 (provisionContract writes enabled=0 by default).
    // Explicitly flip enabled=1 so the honest failure is "no config_json",
    // not "binding is disabled" — tests the specific code path we care about.
    await db.execute({
      sql: `UPDATE data_source_bindings SET enabled = 1 WHERE id = ?`,
      args: [extraBindingId],
    });

    const noConfigJobId = await enqueueJob('sync_gsc', backdatedIso(), {
      binding_id: extraBindingId,
      month: '2099-05',
      created_by: testClient.adminUserId,
    });
    extraJobIds.push(noConfigJobId);

    const run5 = await runDueJobs(10);
    assert(
      run5.ranJobIds.includes(noConfigJobId),
      'runner ran the no-config sync_gsc job'
    );
    const noConfigRow = await getJobRow(noConfigJobId);
    eq(noConfigRow!.status, 'done', 'no-config job status=done');
    assert(
      /failed/.test(noConfigRow!.last_result ?? ''),
      `last_result contains 'failed': ${noConfigRow!.last_result}`
    );
    assert(
      /connection_id|property/.test(noConfigRow!.last_result ?? ''),
      `last_result mentions connection_id/property: ${noConfigRow!.last_result}`
    );
    eq(
      await countPendingSyncJobs('sync_gsc', extraBindingId!),
      0,
      'no pending sync_gsc jobs for no-config binding — chain did not re-enqueue'
    );
    console.log('  OK');
    console.log();
  } finally {
    // Reset client overrides.
    __setGoogleClientsForJobs({ gsc: null, ga4: null });

    // Delete every scheduled_jobs row we touched by id — covers both
    // the fixture rows we enqueued directly and the re-enqueued
    // follow-on rows we captured into extraJobIds.
    for (const id of extraJobIds) {
      try {
        await db.execute({ sql: 'DELETE FROM scheduled_jobs WHERE id = ?', args: [id] });
      } catch {}
    }
    // Belt-and-braces: remove any stray 2099-xx-bearing sync jobs for
    // either of our test bindings, in case the handler re-enqueued
    // into an id we didn't capture.
    for (const bid of [gscBindingId, ga4BindingId, extraBindingId].filter(Boolean)) {
      await db.execute({
        sql: `DELETE FROM scheduled_jobs
              WHERE (job_type = 'sync_gsc' OR job_type = 'sync_ga4')
                AND payload_json LIKE ?`,
        args: [`%"binding_id":"${bid}"%`],
      });
    }

    // Period-scoped cleanup — snapshots, imports, periods.
    for (const pid of periodIdsToCleanup) {
      await db.execute({ sql: 'DELETE FROM keyword_snapshots WHERE period_id = ?', args: [pid] });
      await db.execute({ sql: 'DELETE FROM metric_snapshots WHERE period_id = ?', args: [pid] });
      await db.execute({ sql: 'DELETE FROM imports WHERE period_id = ?', args: [pid] });
      await db.execute({ sql: 'DELETE FROM periods WHERE id = ?', args: [pid] });
    }
    // Belt-and-braces for any 2099-05..08 periods we may not have tracked
    // (e.g. the ga4 happy path's period created via ensurePeriod inside
    // the sync function).
    await db.execute({
      sql: `DELETE FROM keyword_snapshots WHERE period_id IN
            (SELECT id FROM periods WHERE client_id = ?
              AND period_start IN ('2099-05-01','2099-06-01','2099-07-01','2099-08-01'))`,
      args: [testClient.id],
    });
    await db.execute({
      sql: `DELETE FROM metric_snapshots WHERE period_id IN
            (SELECT id FROM periods WHERE client_id = ?
              AND period_start IN ('2099-05-01','2099-06-01','2099-07-01','2099-08-01'))`,
      args: [testClient.id],
    });
    await db.execute({
      sql: `DELETE FROM imports WHERE period_id IN
            (SELECT id FROM periods WHERE client_id = ?
              AND period_start IN ('2099-05-01','2099-06-01','2099-07-01','2099-08-01'))`,
      args: [testClient.id],
    });
    await db.execute({
      sql: `DELETE FROM periods WHERE client_id = ?
            AND period_start IN ('2099-05-01','2099-06-01','2099-07-01','2099-08-01')`,
      args: [testClient.id],
    });

    // Drop the primary synthetic contract and its bindings.
    await db.execute({
      sql: 'DELETE FROM data_source_bindings WHERE contract_id = ?',
      args: [provision.contract_id],
    });
    if (provision.scheduled_job_id) {
      await db.execute({
        sql: 'DELETE FROM scheduled_jobs WHERE id = ?',
        args: [provision.scheduled_job_id],
      });
    }
    await db.execute({
      sql: 'DELETE FROM activity_log WHERE entity_type = ? AND entity_id = ?',
      args: ['contract', provision.contract_id],
    });
    try {
      await deleteContract(provision.contract_id);
    } catch {
      await db.execute({
        sql: `DELETE FROM milestones WHERE project_id IN (SELECT id FROM projects WHERE contract_id = ?)`,
        args: [provision.contract_id],
      });
      await db.execute({ sql: 'DELETE FROM projects WHERE contract_id = ?', args: [provision.contract_id] });
      await db.execute({ sql: 'DELETE FROM contracts WHERE id = ?', args: [provision.contract_id] });
    }

    // Drop the extra no-config contract if it was created.
    if (extraContractId) {
      await db.execute({
        sql: 'DELETE FROM data_source_bindings WHERE contract_id = ?',
        args: [extraContractId],
      });
      await db.execute({
        sql: 'DELETE FROM activity_log WHERE entity_type = ? AND entity_id = ?',
        args: ['contract', extraContractId],
      });
      try {
        await deleteContract(extraContractId);
      } catch {
        await db.execute({
          sql: `DELETE FROM milestones WHERE project_id IN (SELECT id FROM projects WHERE contract_id = ?)`,
          args: [extraContractId],
        });
        await db.execute({ sql: 'DELETE FROM projects WHERE contract_id = ?', args: [extraContractId] });
        await db.execute({ sql: 'DELETE FROM contracts WHERE id = ?', args: [extraContractId] });
      }
    }

    await deleteConnection(connectionId);
  }

  // -------------------------------------------------------------
  // Test 18e.6 — seedInitialSyncJob wiring (unit, post-cleanup)
  // -------------------------------------------------------------
  // Reuse a one-shot synthetic contract + binding so we can prove the
  // bind.ts entry point logic lands a single pending row and then
  // short-circuits on a second call. This exercises the seam that
  // bind.ts uses, without hitting the POST handler itself.
  console.log('--- 18e.6 seedInitialSyncJob is idempotent ---');
  const seedProvision = await provisionContract({
    client_id: testClient.id,
    title: `slice-18e-seed-${nanoid(5)}`,
    type: 'fixed',
    data_sources: [{ source: 'gsc', enabled: true }],
    created_by: testClient.adminUserId,
  });
  const seedBindingId = seedProvision.binding_ids[0];
  try {
    const first = await seedInitialSyncJob(seedBindingId, 'gsc', testClient.adminUserId);
    eq(first, true, 'first seedInitialSyncJob returns true');
    const second = await seedInitialSyncJob(seedBindingId, 'gsc', testClient.adminUserId);
    eq(second, false, 'second seedInitialSyncJob is a no-op');
    eq(
      await countPendingSyncJobs('sync_gsc', seedBindingId),
      1,
      'exactly one pending sync_gsc after double seed'
    );
    // Verify payload month = previousMonth(currentUtcMonth())
    const seedJobRows = await db.execute({
      sql: `SELECT payload_json FROM scheduled_jobs
            WHERE job_type = 'sync_gsc' AND payload_json LIKE ?`,
      args: [`%"binding_id":"${seedBindingId}"%`],
    });
    eq(seedJobRows.rows.length, 1, 'exactly one seed row');
    const payload = JSON.parse(String(seedJobRows.rows[0][0]));
    eq(payload.binding_id, seedBindingId, 'seed payload binding_id');
    eq(payload.month, previousMonth(currentUtcMonth()), 'seed payload month is previous month');
    console.log('  OK');
    console.log();
  } finally {
    await db.execute({
      sql: `DELETE FROM scheduled_jobs WHERE payload_json LIKE ?`,
      args: [`%"binding_id":"${seedBindingId}"%`],
    });
    await db.execute({
      sql: 'DELETE FROM data_source_bindings WHERE contract_id = ?',
      args: [seedProvision.contract_id],
    });
    await db.execute({
      sql: 'DELETE FROM activity_log WHERE entity_type = ? AND entity_id = ?',
      args: ['contract', seedProvision.contract_id],
    });
    try {
      await deleteContract(seedProvision.contract_id);
    } catch {
      await db.execute({
        sql: `DELETE FROM milestones WHERE project_id IN (SELECT id FROM projects WHERE contract_id = ?)`,
        args: [seedProvision.contract_id],
      });
      await db.execute({ sql: 'DELETE FROM projects WHERE contract_id = ?', args: [seedProvision.contract_id] });
      await db.execute({ sql: 'DELETE FROM contracts WHERE id = ?', args: [seedProvision.contract_id] });
    }
  }

  console.log('SLICE 18E TEST PASSED ✓');
}

main().catch((err) => {
  console.error();
  console.error('SLICE 18E TEST FAILED:', err);
  process.exit(1);
});
