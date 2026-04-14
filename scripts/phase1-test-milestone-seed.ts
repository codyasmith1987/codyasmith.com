// Phase 1 Slice 11 — milestone template seeding tests.
//
// Three layers:
//   1. Pure-function — getMilestoneTemplateForService returns the
//      expected number/shape per known service type and an empty
//      array for null/undefined/unknown.
//   2. Integration for each supported service type — provisionContract
//      with that service_type seeds the expected count of milestones
//      tied to the default project, each with the correct
//      title/description/sort_order/client_visible/client_update_text.
//   3. Backward-compat — provisionContract without service_type seeds
//      zero milestones.
//
// Isolation rule: each test provisions a fresh synthetic contract
// under ZipKit with a unique title, then cleans up through
// deleteContract (which cascades to project → milestones → tasks →
// artifacts) plus explicit binding/scheduled_job/activity cleanup.
// No real-month writes happen. No snapshot tables touched.
//
// Run:
//   npx tsx scripts/phase1-test-milestone-seed.ts

import 'dotenv/config';
import { createClient } from '@libsql/client';
import { provisionContract, deleteContract, type ServiceType } from '../src/lib/contracts';
import { getMilestoneTemplateForService } from '../src/lib/milestone-templates';

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
  const c = await db.execute({
    sql: 'SELECT id FROM clients WHERE slug = ? OR name LIKE ? LIMIT 1',
    args: ['zipkit-homes', '%ZipKit%'],
  });
  assert(c.rows.length > 0, 'ZipKit test client missing');
  const a = await db.execute({ sql: `SELECT id FROM users WHERE role = 'admin' LIMIT 1` });
  assert(a.rows.length > 0, 'No admin user');
  return { id: String(c.rows[0][0]), adminUserId: String(a.rows[0][0]) };
}

// Cleanup helper — fully tears down a provisioned contract + its
// surrounding rows. Safe to call on failed provisioning as long as
// the caller tracks what it got.
async function cleanupContract(
  contractId: string,
  scheduledJobId: string | null
) {
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
    // Fallback to direct row delete if cascade path chokes. Milestones
    // and projects are removed explicitly first for safety.
    await db.execute({
      sql: `DELETE FROM milestones
            WHERE project_id IN (SELECT id FROM projects WHERE contract_id = ?)`,
      args: [contractId],
    });
    await db.execute({
      sql: 'DELETE FROM projects WHERE contract_id = ?',
      args: [contractId],
    });
    await db.execute({
      sql: 'DELETE FROM contracts WHERE id = ?',
      args: [contractId],
    });
  }
}

// Read back every milestone under the project provisioned for a
// given contract. Ordered by sort_order so the assertions line up
// with the template definition order.
async function readMilestones(contractId: string): Promise<
  Array<{
    id: string;
    title: string;
    description: string | null;
    sort_order: number;
    client_visible: number;
    client_update_text: string | null;
    status: string;
  }>
> {
  const r = await db.execute({
    sql: `SELECT m.id, m.title, m.description, m.sort_order,
                 m.client_visible, m.client_update_text, m.status
          FROM milestones m
          JOIN projects p ON p.id = m.project_id
          WHERE p.contract_id = ?
          ORDER BY m.sort_order ASC`,
    args: [contractId],
  });
  return r.rows.map((row) => ({
    id: row[0] as string,
    title: row[1] as string,
    description: row[2] as string | null,
    sort_order: Number(row[3]),
    client_visible: Number(row[4]),
    client_update_text: row[5] as string | null,
    status: row[6] as string,
  }));
}

async function testServiceType(
  testClient: { id: string; adminUserId: string },
  serviceType: ServiceType
) {
  console.log(`--- ${serviceType} ---`);
  const expected = getMilestoneTemplateForService(serviceType);
  assert(expected.length > 0, `${serviceType} template non-empty`);

  const result = await provisionContract({
    client_id: testClient.id,
    title: `slice-11-test ${serviceType} ${new Date().toISOString()}`,
    service_type: serviceType,
    type: 'retainer',
    created_by: testClient.adminUserId,
  });

  try {
    eq(result.milestone_ids.length, expected.length, `${serviceType} milestone_ids length`);

    const actual = await readMilestones(result.contract_id);
    eq(actual.length, expected.length, `${serviceType} milestones row count`);

    for (let i = 0; i < expected.length; i++) {
      const e = expected[i];
      const a = actual[i];
      eq(a.title, e.title, `${serviceType}[${i}].title`);
      eq(a.description, e.description, `${serviceType}[${i}].description`);
      eq(a.sort_order, e.sort_order, `${serviceType}[${i}].sort_order`);
      eq(a.client_visible, e.client_visible ? 1 : 0, `${serviceType}[${i}].client_visible`);
      eq(a.client_update_text, e.client_update_text, `${serviceType}[${i}].client_update_text`);
      eq(a.status, 'not_started', `${serviceType}[${i}].status defaults to not_started`);

      // Plain-language rule — client_update_text must not exceed a
      // sanity threshold and must not contain obvious jargon markers.
      // This is a heuristic guard against a future "quick update" that
      // pastes an admin-side sentence into the client copy.
      assert(a.client_update_text!.length <= 140, `${serviceType}[${i}] client text ≤ 140 chars`);
      const forbidden = ['SEO', 'CTA', 'GSC', 'Ubersuggest', 'KPI'];
      for (const bad of forbidden) {
        assert(
          !a.client_update_text!.includes(bad),
          `${serviceType}[${i}] client text avoids "${bad}"`
        );
      }
    }

    // Activity log summary should name the count and service_type.
    const act = await db.execute({
      sql: `SELECT summary FROM activity_log
            WHERE entity_type = 'contract' AND entity_id = ?`,
      args: [result.contract_id],
    });
    eq(act.rows.length, 1, `${serviceType} one activity row`);
    const summary = String(act.rows[0][0]);
    assert(
      summary.includes(`${expected.length} ${serviceType} milestones`),
      `${serviceType} activity summary mentions count + service_type`
    );

    console.log(`  ${serviceType} OK (${expected.length} milestones)`);
  } finally {
    await cleanupContract(result.contract_id, result.scheduled_job_id);
  }
}

async function main() {
  console.log('=== Slice 11 test: milestone template seeding ===');
  console.log();

  // --- Pure-function tests ---
  console.log('--- getMilestoneTemplateForService ---');
  eq(getMilestoneTemplateForService(null).length, 0, 'null → []');
  eq(getMilestoneTemplateForService(undefined).length, 0, 'undefined → []');
  eq(
    getMilestoneTemplateForService('unknown' as ServiceType).length,
    0,
    'unknown service type → []'
  );
  eq(getMilestoneTemplateForService('web_management').length, 4, 'web_management → 4');
  eq(getMilestoneTemplateForService('consulting').length, 4, 'consulting → 4');
  eq(getMilestoneTemplateForService('hybrid').length, 4, 'hybrid → 4');

  // Mutation guard: the getter clones, so mutating the returned array
  // must NOT affect subsequent calls.
  const a = getMilestoneTemplateForService('web_management');
  a[0].title = 'mutated';
  const b = getMilestoneTemplateForService('web_management');
  assert(b[0].title !== 'mutated', 'template clone is safe from mutation');
  console.log('  pure-function OK');
  console.log();

  // --- Integration: each service type seeds correctly ---
  const testClient = await findTestClient();

  for (const st of ['web_management', 'consulting', 'hybrid'] as ServiceType[]) {
    await testServiceType(testClient, st);
  }
  console.log();

  // --- Backward compat: no service_type → no milestones ---
  console.log('--- no service_type ---');
  const bareResult = await provisionContract({
    client_id: testClient.id,
    title: `slice-11-test bare ${new Date().toISOString()}`,
    type: 'retainer',
    created_by: testClient.adminUserId,
  });
  try {
    eq(bareResult.milestone_ids.length, 0, 'bare provisioning → 0 milestone ids');
    const rows = await readMilestones(bareResult.contract_id);
    eq(rows.length, 0, 'bare provisioning → 0 milestone rows');
    console.log('  no-service-type OK (0 milestones)');
  } finally {
    await cleanupContract(bareResult.contract_id, bareResult.scheduled_job_id);
  }
  console.log();

  console.log('SLICE 11 TEST PASSED ✓');
}

main().catch((err) => {
  console.error();
  console.error('SLICE 11 TEST FAILED:', err);
  process.exit(1);
});
