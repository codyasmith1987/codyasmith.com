// Slice 18b — GA4 sync end-to-end tests.
//
// Eight cases covering the layers we can honestly verify without
// real Google credentials:
//
//   1. buildGa4ReportRequest shape — correct metrics list, no
//      dimensions, right date range
//   2. mapGa4ResponseToMetrics happy path — fixture -> 5 typed rows
//      with correct metric_key translation and value parsing
//   3. mapGa4ResponseToMetrics empty path — 0 metrics, not error
//   4. syncGa4ForBinding happy path with fake Ga4Client -> rows in
//      metric_snapshots under source='ga4', category='traffic',
//      binding heartbeat stamped
//   5. syncGa4ForBinding period lock guard -> failed + audit trail
//   6. syncGa4ForBinding no-config -> failed honestly
//   7. getTrafficMetricsForPeriod read helper -> typed object with
//      all 5 keys, null when incomplete
//   8. Naming convention sanity — TRAFFIC_METRIC_KEYS length + order,
//      GA4_METRIC_MAP length + API name surface
//
// Isolation: fresh synthetic contract + connection + binding with
// config_json manually set. Period '2099-03' (distinct from Slice 18
// which uses '2099-01'/'2099-02'). Cleanup on all paths.
//
// Run:
//   npx tsx scripts/phase1-test-slice18b-ga4.ts
//   (GOOGLE_TOKEN_KEY is set via the slice 18 test pattern if absent)

import 'dotenv/config';
import { createClient } from '@libsql/client';
import { nanoid } from 'nanoid';
import crypto from 'node:crypto';
import {
  buildGa4ReportRequest,
  mapGa4ResponseToMetrics,
  GA4_METRIC_MAP,
  type Ga4Client,
  type Ga4RunReportRequest,
  type Ga4RunReportResponse,
} from '../src/lib/google/ga4';
import {
  TRAFFIC_METRIC_KEYS,
  getTrafficMetricsForPeriod,
  getLatestTrafficPeriodId,
} from '../src/lib/traffic-metrics';
import { syncGa4ForBinding } from '../src/lib/google/sync';
import { createConnection, deleteConnection } from '../src/lib/google/connections';
import { GSC_SCOPE, GA4_SCOPE } from '../src/lib/google/oauth';
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

// Same env-stub pattern as slice 18 so the crypto lib can run.
if (!process.env.GOOGLE_TOKEN_KEY) {
  process.env.GOOGLE_TOKEN_KEY = crypto.randomBytes(32).toString('base64');
}

async function findTestClient(): Promise<{ id: string; adminUserId: string }> {
  const c = await db.execute({
    sql: 'SELECT id FROM clients WHERE slug = ? OR name LIKE ? LIMIT 1',
    args: ['zipkit-homes', '%ZipKit%'],
  });
  assert(c.rows.length > 0, 'ZipKit missing');
  const a = await db.execute({ sql: `SELECT id FROM users WHERE role = 'admin' LIMIT 1` });
  assert(a.rows.length > 0, 'no admin user');
  return { id: String(c.rows[0][0]), adminUserId: String(a.rows[0][0]) };
}

// Fixture GA4 response — values chosen so the mapper + read-helper
// assertions can match exact numbers.
const FIXTURE_RESPONSE: Ga4RunReportResponse = {
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

const EMPTY_RESPONSE: Ga4RunReportResponse = {
  metricHeaders: [],
  rows: [],
  rowCount: 0,
};

class FakeGa4Client implements Ga4Client {
  calls: Array<{ property: string; request: Ga4RunReportRequest }> = [];
  response: Ga4RunReportResponse;
  constructor(response: Ga4RunReportResponse = FIXTURE_RESPONSE) {
    this.response = response;
  }
  async runReport(_accessToken: string, property: string, request: Ga4RunReportRequest) {
    this.calls.push({ property, request });
    return this.response;
  }
}

async function main() {
  console.log('=== Slice 18b test: GA4 sync ===');
  console.log();

  // ---- 1. buildGa4ReportRequest shape ----
  console.log('--- 1. buildGa4ReportRequest ---');
  const req = buildGa4ReportRequest('2099-03-01', '2099-03-31');
  eq(req.dateRanges.length, 1, 'one date range');
  eq(req.dateRanges[0].startDate, '2099-03-01', 'start date');
  eq(req.dateRanges[0].endDate, '2099-03-31', 'end date');
  eq(req.metrics.length, 5, '5 metrics requested');
  eq(req.metrics[0].name, 'sessions', 'metrics[0]');
  eq(req.metrics[1].name, 'totalUsers', 'metrics[1]');
  eq(req.metrics[2].name, 'screenPageViews', 'metrics[2]');
  eq(req.metrics[3].name, 'engagedSessions', 'metrics[3]');
  eq(req.metrics[4].name, 'engagementRate', 'metrics[4]');
  eq((req as any).dimensions, undefined, 'no dimensions field (totals only)');
  console.log('  OK');
  console.log();

  // ---- 2. mapGa4ResponseToMetrics happy path ----
  console.log('--- 2. mapGa4ResponseToMetrics (fixture) ---');
  const mapped = mapGa4ResponseToMetrics(FIXTURE_RESPONSE);
  eq(mapped.length, 5, '5 staged metrics');
  eq(mapped[0].metric_key, 'sessions', 'row 0 key');
  eq(mapped[0].metric_value, 240, 'row 0 value');
  eq(mapped[1].metric_key, 'users', 'row 1 key (totalUsers → users)');
  eq(mapped[1].metric_value, 180, 'row 1 value');
  eq(mapped[2].metric_key, 'page_views', 'row 2 key (screenPageViews → page_views)');
  eq(mapped[2].metric_value, 620, 'row 2 value');
  eq(mapped[3].metric_key, 'engaged_sessions', 'row 3 key');
  eq(mapped[3].metric_value, 150, 'row 3 value');
  eq(mapped[4].metric_key, 'engagement_rate', 'row 4 key');
  eq(mapped[4].metric_value, 0.625, 'row 4 value (float)');
  console.log('  OK');
  console.log();

  // ---- 3. empty response ----
  console.log('--- 3. mapGa4ResponseToMetrics (empty) ---');
  const empty = mapGa4ResponseToMetrics(EMPTY_RESPONSE);
  eq(empty.length, 0, 'empty response → 0 rows');
  const nullRows = mapGa4ResponseToMetrics({});
  eq(nullRows.length, 0, 'undefined rows → 0');
  console.log('  OK');
  console.log();

  // ---- 8. naming convention sanity (moved up so it runs without any DB setup) ----
  console.log('--- 8. naming convention ---');
  eq(TRAFFIC_METRIC_KEYS.length, 5, '5 traffic metric keys');
  eq(TRAFFIC_METRIC_KEYS[0], 'sessions', 'keys[0]');
  eq(TRAFFIC_METRIC_KEYS[1], 'users', 'keys[1]');
  eq(TRAFFIC_METRIC_KEYS[2], 'page_views', 'keys[2]');
  eq(TRAFFIC_METRIC_KEYS[3], 'engaged_sessions', 'keys[3]');
  eq(TRAFFIC_METRIC_KEYS[4], 'engagement_rate', 'keys[4]');
  eq(GA4_METRIC_MAP.length, 5, '5 GA4 metric mappings');
  // Sanity: the API names in GA4_METRIC_MAP match the ones we send.
  const apiNames = GA4_METRIC_MAP.map((m) => m.apiName);
  assert(apiNames.includes('sessions'), 'sessions API name');
  assert(apiNames.includes('totalUsers'), 'totalUsers API name');
  assert(apiNames.includes('screenPageViews'), 'screenPageViews API name');
  assert(apiNames.includes('engagedSessions'), 'engagedSessions API name');
  assert(apiNames.includes('engagementRate'), 'engagementRate API name');
  // Scope constants exist
  assert(typeof GSC_SCOPE === 'string' && GSC_SCOPE.length > 0, 'GSC_SCOPE exported');
  assert(typeof GA4_SCOPE === 'string' && GA4_SCOPE.length > 0, 'GA4_SCOPE exported');
  assert(GA4_SCOPE.includes('analytics'), 'GA4_SCOPE mentions analytics');
  console.log('  OK');
  console.log();

  // ---- 4-7. Sync handler integration ----
  const testClient = await findTestClient();

  // Preflight: refuse to run if 2099-03 already has data for this client.
  const preflight = await db.execute({
    sql: `SELECT COUNT(*) FROM periods WHERE client_id = ? AND period_start = '2099-03-01'`,
    args: [testClient.id],
  });
  assert(
    Number(preflight.rows[0][0]) === 0,
    'no pre-existing 2099-03 period for test client'
  );

  // Provision a contract with a ga4 binding.
  const provision = await provisionContract({
    client_id: testClient.id,
    title: `slice-18b-test-${nanoid(5)}`,
    type: 'retainer',
    service_type: 'web_management',
    data_sources: [{ source: 'ga4', enabled: true }],
    created_by: testClient.adminUserId,
  });

  // Create a synthetic google_connections row.
  const connectionId = await createConnection({
    admin_user_id: testClient.adminUserId,
    google_account_email: `slice18b-${nanoid(5)}@test.example`,
    refresh_token: 'fake-refresh-' + nanoid(20),
    access_token: 'fake-access-' + nanoid(20),
    access_token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    scopes: [GA4_SCOPE],
  });

  // Bind the connection + a fake property id to the binding.
  const bindingId = provision.binding_ids[0];
  assert(bindingId, 'provision returned a binding id');
  await db.execute({
    sql: `UPDATE data_source_bindings
          SET config_json = ?, enabled = 1
          WHERE id = ?`,
    args: [JSON.stringify({ connection_id: connectionId, property: '287462318' }), bindingId],
  });

  let createdPeriodId: string | null = null;
  const extraContractIds: string[] = [];

  try {
    // ---- 4. syncGa4ForBinding happy path ----
    console.log('--- 4. syncGa4ForBinding happy path ---');
    const fake = new FakeGa4Client();
    const res1 = await syncGa4ForBinding(bindingId, '2099-03', testClient.adminUserId, fake);
    eq(res1.status, 'applied', 'sync applied');
    eq(res1.row_count, 5, 'row_count=5');
    assert(res1.period_id !== null, 'period_id returned');
    createdPeriodId = res1.period_id;
    assert(res1.import_id !== null, 'import_id returned');
    eq(fake.calls.length, 1, 'GA4 client called once');
    eq(fake.calls[0].property, '287462318', 'GA4 call property');
    eq(fake.calls[0].request.dateRanges[0].startDate, '2099-03-01', 'GA4 call startDate');
    eq(fake.calls[0].request.dateRanges[0].endDate, '2099-03-31', 'GA4 call endDate');

    // Verify metric_snapshots rows under source='ga4'.
    const snap = await db.execute({
      sql: `SELECT COUNT(*) FROM metric_snapshots
            WHERE client_id = ? AND period_id = ? AND category = 'traffic' AND source = 'ga4'`,
      args: [testClient.id, res1.period_id],
    });
    eq(Number(snap.rows[0][0]), 5, '5 traffic rows under source=ga4');

    // Verify specific keys + values landed.
    const keyRows = await db.execute({
      sql: `SELECT metric_key, metric_value FROM metric_snapshots
            WHERE client_id = ? AND period_id = ? AND category = 'traffic' AND source = 'ga4'
            ORDER BY metric_key`,
      args: [testClient.id, res1.period_id],
    });
    const keyMap = new Map<string, number>();
    for (const row of keyRows.rows) keyMap.set(String(row[0]), Number(row[1]));
    eq(keyMap.get('sessions'), 240, 'db sessions');
    eq(keyMap.get('users'), 180, 'db users');
    eq(keyMap.get('page_views'), 620, 'db page_views');
    eq(keyMap.get('engaged_sessions'), 150, 'db engaged_sessions');
    eq(keyMap.get('engagement_rate'), 0.625, 'db engagement_rate');

    // Binding heartbeat stamped.
    const bindingAfter = await db.execute({
      sql: `SELECT last_seen_at FROM data_source_bindings WHERE id = ?`,
      args: [bindingId],
    });
    assert(bindingAfter.rows[0][0] !== null, 'last_seen_at stamped');
    console.log('  OK');
    console.log();

    // ---- 7. getTrafficMetricsForPeriod read helper ----
    console.log('--- 7. getTrafficMetricsForPeriod ---');
    const readBack = await getTrafficMetricsForPeriod(testClient.id, createdPeriodId!);
    assert(readBack !== null, 'traffic metrics readable');
    eq(readBack!.sessions, 240, 'read sessions');
    eq(readBack!.users, 180, 'read users');
    eq(readBack!.page_views, 620, 'read page_views');
    eq(readBack!.engaged_sessions, 150, 'read engaged_sessions');
    eq(readBack!.engagement_rate, 0.625, 'read engagement_rate');

    // latest period id lookup
    const latestPeriod = await getLatestTrafficPeriodId(testClient.id);
    eq(latestPeriod, createdPeriodId, 'latest period id matches written period');

    // Null for a period with no traffic data
    const r = await db.execute({
      sql: `SELECT id FROM periods WHERE client_id = ? AND period_start = '2026-04-01' LIMIT 1`,
      args: [testClient.id],
    });
    if (r.rows.length > 0) {
      // ZipKit's April 2026 period has no ga4 rows — helper returns null
      const realPeriodId = String(r.rows[0][0]);
      const nullResult = await getTrafficMetricsForPeriod(testClient.id, realPeriodId);
      eq(nullResult, null, 'period with no traffic data → null');
    }
    console.log('  OK');
    console.log();

    // ---- 5. period lock guard ----
    console.log('--- 5. lock guard ---');
    await lockPeriod(createdPeriodId!);
    try {
      const res2 = await syncGa4ForBinding(
        bindingId,
        '2099-03',
        testClient.adminUserId,
        new FakeGa4Client()
      );
      eq(res2.status, 'failed', 'sync failed on locked period');
      assert(/locked/.test(res2.error ?? ''), 'error mentions locked');

      // Snapshots untouched (5 rows still there)
      const snap2 = await db.execute({
        sql: `SELECT COUNT(*) FROM metric_snapshots
              WHERE client_id = ? AND period_id = ? AND source = 'ga4'`,
        args: [testClient.id, createdPeriodId],
      });
      eq(Number(snap2.rows[0][0]), 5, '5 rows still present after lock refusal');

      // Failed import row recorded
      const imp = await db.execute({
        sql: `SELECT COUNT(*) FROM imports
              WHERE client_id = ? AND period_id = ? AND source = 'ga4' AND status = 'failed'`,
        args: [testClient.id, createdPeriodId],
      });
      assert(Number(imp.rows[0][0]) >= 1, 'failed import row recorded');
    } finally {
      await unlockPeriod(createdPeriodId!);
    }
    console.log('  OK');
    console.log();

    // ---- 6. no-config binding ----
    console.log('--- 6. no-config binding ---');
    const provision2 = await provisionContract({
      client_id: testClient.id,
      title: `slice-18b-noconfig-${nanoid(5)}`,
      type: 'fixed',
      data_sources: [{ source: 'ga4', enabled: true }],
      created_by: testClient.adminUserId,
    });
    extraContractIds.push(provision2.contract_id);
    const noConfigBindingId = provision2.binding_ids[0];
    const res3 = await syncGa4ForBinding(
      noConfigBindingId,
      '2099-04',
      testClient.adminUserId,
      new FakeGa4Client()
    );
    eq(res3.status, 'failed', 'no-config → failed');
    assert(
      /connection_id|property/.test(res3.error ?? ''),
      `error mentions missing config, got: ${res3.error}`
    );
    console.log('  OK');
    console.log();
  } finally {
    // Cleanup.
    if (createdPeriodId) {
      await db.execute({ sql: 'DELETE FROM metric_snapshots WHERE period_id = ?', args: [createdPeriodId] });
      await db.execute({ sql: 'DELETE FROM imports WHERE period_id = ?', args: [createdPeriodId] });
      await db.execute({ sql: 'DELETE FROM periods WHERE id = ?', args: [createdPeriodId] });
    }
    // Also clean up any 2099-04 period created by case 6.
    await db.execute({
      sql: `DELETE FROM metric_snapshots WHERE period_id IN (
        SELECT id FROM periods WHERE client_id = ? AND period_start IN ('2099-03-01','2099-04-01')
      )`,
      args: [testClient.id],
    });
    await db.execute({
      sql: `DELETE FROM imports WHERE period_id IN (
        SELECT id FROM periods WHERE client_id = ? AND period_start IN ('2099-03-01','2099-04-01')
      )`,
      args: [testClient.id],
    });
    await db.execute({
      sql: `DELETE FROM periods WHERE client_id = ? AND period_start IN ('2099-03-01','2099-04-01')`,
      args: [testClient.id],
    });

    // Cleanup the main test contract.
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

    // Clean up the extra contracts (case 6's no-config contract).
    for (const cid of extraContractIds) {
      await db.execute({ sql: 'DELETE FROM data_source_bindings WHERE contract_id = ?', args: [cid] });
      await db.execute({
        sql: 'DELETE FROM scheduled_jobs WHERE payload_json LIKE ?',
        args: [`%"contract_id":"${cid}"%`],
      });
      await db.execute({
        sql: 'DELETE FROM activity_log WHERE entity_type = ? AND entity_id = ?',
        args: ['contract', cid],
      });
      try {
        await deleteContract(cid);
      } catch {
        await db.execute({
          sql: `DELETE FROM milestones WHERE project_id IN (SELECT id FROM projects WHERE contract_id = ?)`,
          args: [cid],
        });
        await db.execute({ sql: 'DELETE FROM projects WHERE contract_id = ?', args: [cid] });
        await db.execute({ sql: 'DELETE FROM contracts WHERE id = ?', args: [cid] });
      }
    }

    await deleteConnection(connectionId);
  }

  console.log('SLICE 18b TEST PASSED ✓');
}

main().catch((err) => {
  console.error();
  console.error('SLICE 18b TEST FAILED:', err);
  process.exit(1);
});
