// Phase 1 Slice 13 — module enforcement tests.
//
// Layers:
//   1. parseModulesJson — valid, invalid, array-of-unknown-keys, null
//   2. pathRequiresModule — every portal path maps to the right gate,
//      unknown paths return null (no gate), dashboard is never gated
//   3. isPathAllowed — gate + always-on dashboard + no-gate fall-through
//   4. Completeness guard — every MODULE_KEYS entry has at least one
//      MODULE_ROUTE_MAP entry (via a reverse check) EXCEPT dashboard
//      which is intentionally always-on
//   5. getEnabledModulesForClient integration — union across two
//      active contracts on a fresh synthetic client, plus the
//      zero-contracts fallback, plus the corrupt-JSON fallback
//
// Isolation: this test provisions two fresh contracts under ZipKit
// with unique titles and cleans them up. It never touches snapshot
// tables or live ingestion. It DOES temporarily mutate the
// contracts.modules_json of a test contract (for the corrupt-JSON
// fallback case) — that mutation is bounded to contracts this test
// created, not ZipKit's real contracts.
//
// Run:
//   npx tsx scripts/phase1-test-module-enforcement.ts

import 'dotenv/config';
import { createClient } from '@libsql/client';
import { provisionContract, deleteContract } from '../src/lib/contracts';
import {
  parseModulesJson,
  pathRequiresModule,
  isPathAllowed,
  getEnabledModulesForClient,
  MODULE_KEYS,
  DEFAULT_MODULES,
  type ModuleKey,
} from '../src/lib/modules';

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
function setEq(actual: Set<ModuleKey>, expected: ModuleKey[], label: string) {
  const a = Array.from(actual).sort();
  const e = [...expected].sort();
  if (JSON.stringify(a) !== JSON.stringify(e)) {
    console.error(`ASSERT FAILED: ${label}`);
    console.error(`  expected: ${JSON.stringify(e)}`);
    console.error(`  actual:   ${JSON.stringify(a)}`);
    throw new Error(label);
  }
}

async function findTestClient(): Promise<{ id: string; adminUserId: string }> {
  const c = await db.execute({
    sql: 'SELECT id FROM clients WHERE slug = ? OR name LIKE ? LIMIT 1',
    args: ['zipkit-homes', '%ZipKit%'],
  });
  assert(c.rows.length > 0, 'ZipKit test client missing');
  const a = await db.execute({ sql: `SELECT id FROM users WHERE role = 'admin' LIMIT 1` });
  assert(a.rows.length > 0, 'No admin user');
  return { id: String(c.rows[0][0]), adminUserId: String(a.rows[0][0]) };
}

// Activates a contract by flipping status to 'active' so
// getEnabledModulesForClient picks it up.
async function activateContract(contractId: string) {
  await db.execute({
    sql: `UPDATE contracts SET status = 'active' WHERE id = ?`,
    args: [contractId],
  });
}

async function cleanupContract(contractId: string, scheduledJobId: string | null) {
  await db.execute({
    sql: 'DELETE FROM data_source_bindings WHERE contract_id = ?',
    args: [contractId],
  });
  if (scheduledJobId) {
    await db.execute({
      sql: 'DELETE FROM scheduled_jobs WHERE id = ?',
      args: [scheduledJobId],
    });
  }
  await db.execute({
    sql: 'DELETE FROM activity_log WHERE entity_type = ? AND entity_id = ?',
    args: ['contract', contractId],
  });
  try {
    await deleteContract(contractId);
  } catch {
    await db.execute({
      sql: `DELETE FROM milestones WHERE project_id IN (SELECT id FROM projects WHERE contract_id = ?)`,
      args: [contractId],
    });
    await db.execute({
      sql: 'DELETE FROM projects WHERE contract_id = ?',
      args: [contractId],
    });
    await db.execute({ sql: 'DELETE FROM contracts WHERE id = ?', args: [contractId] });
  }
}

async function main() {
  console.log('=== Slice 13 test: module enforcement ===');
  console.log();

  // ---- 1. parseModulesJson ----
  console.log('--- parseModulesJson ---');
  eq(parseModulesJson(null), null, 'null → null');
  eq(parseModulesJson(undefined), null, 'undefined → null');
  eq(parseModulesJson(''), null, 'empty string → null');
  eq(parseModulesJson('not json'), null, 'invalid JSON → null');
  eq(parseModulesJson('{}'), null, 'non-array JSON → null');
  eq(parseModulesJson('"dashboard"'), null, 'string JSON → null');

  const valid = parseModulesJson('["dashboard","rankings","health","files","invoices"]');
  assert(valid !== null, 'valid parses');
  setEq(valid, ['dashboard', 'rankings', 'health', 'files', 'invoices'], 'full set parsed');

  const partial = parseModulesJson('["dashboard","rankings"]');
  assert(partial !== null, 'partial parses');
  setEq(partial, ['dashboard', 'rankings'], 'partial set parsed');

  const withUnknown = parseModulesJson('["dashboard","rankings","bogus"]');
  assert(withUnknown !== null, 'unknown-key input still parses');
  setEq(withUnknown, ['dashboard', 'rankings'], 'unknown keys filtered out');

  const empty = parseModulesJson('[]');
  assert(empty !== null, 'empty array parses');
  eq(empty.size, 0, 'empty array → empty set');

  console.log('  parseModulesJson OK');
  console.log();

  // ---- 2. pathRequiresModule ----
  console.log('--- pathRequiresModule ---');
  eq(pathRequiresModule('/portal/keywords'), 'rankings', '/portal/keywords → rankings');
  eq(pathRequiresModule('/portal/keywords/detail'), 'rankings', '/portal/keywords/detail → rankings');
  eq(pathRequiresModule('/portal/health'), 'health', '/portal/health → health');
  eq(pathRequiresModule('/portal/files'), 'files', '/portal/files → files');
  eq(pathRequiresModule('/portal/invoices'), 'invoices', '/portal/invoices → invoices');
  eq(pathRequiresModule('/portal/api/dashboard/keywords'), 'rankings', 'api keywords → rankings');
  eq(pathRequiresModule('/portal/api/dashboard/issues'), 'health', 'api issues → health');
  eq(pathRequiresModule('/portal/api/files/upload'), 'files', 'api files/upload → files');
  eq(pathRequiresModule('/portal/api/invoices/123'), 'invoices', 'api invoices/:id → invoices');

  // Dashboard and other non-gated paths return null.
  eq(pathRequiresModule('/portal/dashboard'), null, 'dashboard → null');
  eq(pathRequiresModule('/portal/notifications'), null, 'notifications → null');
  eq(pathRequiresModule('/portal/admin/contracts'), null, 'admin path → null');
  eq(pathRequiresModule('/portal/api/dashboard/summary'), null, 'api summary → null (not in map)');
  eq(pathRequiresModule('/some/random/path'), null, 'random path → null');
  console.log('  pathRequiresModule OK');
  console.log();

  // ---- 3. isPathAllowed ----
  console.log('--- isPathAllowed ---');
  const onlyDashboardAndRankings = new Set<ModuleKey>(['dashboard', 'rankings']);

  // Dashboard always allowed even if not in set (defensive always-on)
  const noDashboard = new Set<ModuleKey>(['rankings']);
  eq(
    isPathAllowed('/portal/dashboard', noDashboard),
    true,
    'dashboard always allowed even without dashboard in set'
  );
  // Rankings allowed
  eq(
    isPathAllowed('/portal/keywords', onlyDashboardAndRankings),
    true,
    'rankings allowed when in set'
  );
  // Health NOT allowed
  eq(
    isPathAllowed('/portal/health', onlyDashboardAndRankings),
    false,
    'health not allowed when not in set'
  );
  // Files NOT allowed
  eq(
    isPathAllowed('/portal/files', onlyDashboardAndRankings),
    false,
    'files not allowed when not in set'
  );
  // Invoices NOT allowed
  eq(
    isPathAllowed('/portal/invoices', onlyDashboardAndRankings),
    false,
    'invoices not allowed when not in set'
  );
  // Non-gated path (admin, notifications) allowed regardless
  eq(
    isPathAllowed('/portal/notifications', onlyDashboardAndRankings),
    true,
    'non-gated path always allowed'
  );
  eq(
    isPathAllowed('/portal/admin/contracts', onlyDashboardAndRankings),
    true,
    'admin path not module-gated (role guard handles it)'
  );

  // API gates respect the same set
  eq(
    isPathAllowed('/portal/api/dashboard/keywords', onlyDashboardAndRankings),
    true,
    'api keywords allowed'
  );
  eq(
    isPathAllowed('/portal/api/dashboard/issues', onlyDashboardAndRankings),
    false,
    'api issues blocked'
  );
  eq(
    isPathAllowed('/portal/api/files/upload', onlyDashboardAndRankings),
    false,
    'api files blocked'
  );
  console.log('  isPathAllowed OK');
  console.log();

  // ---- 4. Route-map completeness ----
  // Every ModuleKey except dashboard must be reachable via at least
  // one entry in the route map. Dashboard is intentionally always-on
  // (no gate, no route entry). A future module added to MODULE_KEYS
  // must also be added to MODULE_ROUTE_MAP or this test fails.
  console.log('--- route map completeness ---');
  for (const key of MODULE_KEYS) {
    if (key === 'dashboard') continue;
    // Probe a few likely path prefixes and confirm at least one
    // pathRequiresModule call returns this key.
    const probes = [
      `/portal/${key}`,
      `/portal/keywords`, // rankings
      `/portal/api/dashboard/${key}`,
      `/portal/api/files`,
      `/portal/api/invoices`,
    ];
    const found = probes.some((p) => pathRequiresModule(p) === key);
    assert(found, `module "${key}" has no route map entry`);
  }
  console.log('  route map completeness OK');
  console.log();

  // ---- 5. getEnabledModulesForClient integration ----
  console.log('--- getEnabledModulesForClient ---');
  const testClient = await findTestClient();

  // Snapshot existing real contract IDs so we can identify which
  // modules belong to ZipKit's genuine contracts vs our tests, and
  // filter the test assertion to only our synthetic contracts by
  // unioning only the ones we provisioned.
  //
  // Actually — getEnabledModulesForClient unions ALL active
  // contracts under the client. Since ZipKit has an existing active
  // contract, we can't make a clean assertion about "the union is
  // exactly X" without accounting for real state. To keep the test
  // honest and isolated, we:
  //   (a) read ZipKit's CURRENT union before our test contracts exist
  //   (b) provision two test contracts with specific module sets
  //   (c) assert the new union strictly contains the test modules
  //       AND the original union (no modules accidentally removed)
  //   (d) after cleanup, assert the union has returned to step (a)
  //
  // This is a safer shape than "assert == exact set" for live data.

  const baselineUnion = await getEnabledModulesForClient(testClient.id);
  console.log(`  baseline union: [${Array.from(baselineUnion).sort().join(', ')}]`);

  const contractA = await provisionContract({
    client_id: testClient.id,
    title: `slice-13-test A ${new Date().toISOString()}`,
    type: 'consulting',
    modules: ['dashboard', 'rankings'],
    created_by: testClient.adminUserId,
  });
  const contractB = await provisionContract({
    client_id: testClient.id,
    title: `slice-13-test B ${new Date().toISOString()}`,
    type: 'retainer',
    modules: ['dashboard', 'files'],
    created_by: testClient.adminUserId,
  });

  try {
    await activateContract(contractA.contract_id);
    await activateContract(contractB.contract_id);

    const unionAfter = await getEnabledModulesForClient(testClient.id);
    console.log(`  after +A +B:    [${Array.from(unionAfter).sort().join(', ')}]`);

    // The two synthetic contracts contribute dashboard, rankings, files.
    // Those three MUST be in the resulting union regardless of whatever
    // baseline ZipKit already had.
    assert(unionAfter.has('dashboard'), 'union includes dashboard from A');
    assert(unionAfter.has('rankings'), 'union includes rankings from A');
    assert(unionAfter.has('files'), 'union includes files from B');

    // Anything the baseline had must still be present (no modules
    // accidentally removed by adding new contracts).
    for (const k of baselineUnion) {
      assert(
        unionAfter.has(k),
        `baseline module "${k}" still present after adding test contracts`
      );
    }

    // --- Corrupt JSON fallback ---
    // Directly poke contractA.modules_json to invalid JSON and
    // confirm the helper falls back gracefully (the call should
    // not throw, and the resulting union should still include the
    // modules from contractB + baseline).
    await db.execute({
      sql: `UPDATE contracts SET modules_json = 'this is not json' WHERE id = ?`,
      args: [contractA.contract_id],
    });
    const unionCorrupt = await getEnabledModulesForClient(testClient.id);
    assert(unionCorrupt.has('files'), 'corrupt A still unions B files');
    for (const k of baselineUnion) {
      assert(unionCorrupt.has(k), `corrupt A still preserves baseline "${k}"`);
    }
    console.log(`  corrupt A:      [${Array.from(unionCorrupt).sort().join(', ')}]`);

    // Restore JSON so the next block is clean
    await db.execute({
      sql: `UPDATE contracts SET modules_json = '["dashboard","rankings"]' WHERE id = ?`,
      args: [contractA.contract_id],
    });
    console.log('  union + corrupt fallback OK');
    console.log();

    // --- Zero-contracts fallback on a bare synthetic client ---
    console.log('--- zero-contracts fallback ---');
    const tempClientId = 'slice-13-tmp-' + Date.now().toString(36);
    const tempSlug = `slice-13-tmp-${Date.now().toString(36)}`;
    await db.execute({
      sql: `INSERT INTO clients (id, name, slug) VALUES (?, ?, ?)`,
      args: [tempClientId, `tmp ${Date.now()}`, tempSlug],
    });
    try {
      const tempUnion = await getEnabledModulesForClient(tempClientId);
      console.log(`  bare client:    [${Array.from(tempUnion).sort().join(', ')}]`);
      setEq(tempUnion, Array.from(DEFAULT_MODULES), 'bare client → DEFAULT_MODULES');
    } finally {
      await db.execute({ sql: 'DELETE FROM clients WHERE id = ?', args: [tempClientId] });
    }
    console.log('  zero-contracts fallback OK');
    console.log();
  } finally {
    await cleanupContract(contractA.contract_id, contractA.scheduled_job_id);
    await cleanupContract(contractB.contract_id, contractB.scheduled_job_id);

    // Paranoia: confirm union returned to baseline after cleanup.
    const postClean = await getEnabledModulesForClient(testClient.id);
    for (const k of baselineUnion) {
      assert(postClean.has(k), `baseline "${k}" still present after cleanup`);
    }
    // Synthetic modules should be gone unless baseline also had them.
    for (const syntheticOnly of ['rankings', 'files'] as ModuleKey[]) {
      if (!baselineUnion.has(syntheticOnly)) {
        assert(
          !postClean.has(syntheticOnly),
          `synthetic "${syntheticOnly}" removed after cleanup`
        );
      }
    }
    console.log(`  post-cleanup:   [${Array.from(postClean).sort().join(', ')}]`);
    console.log();
  }

  console.log('SLICE 13 TEST PASSED ✓');
}

main().catch((err) => {
  console.error();
  console.error('SLICE 13 TEST FAILED:', err);
  process.exit(1);
});
