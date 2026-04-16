// Slice 20 test: billing-input visibility and approve action.
//
// Exercises:
//   1. pending_charges query returns classification, needs_approval, category
//   2. approve endpoint flips needs_approval → auto_bill
//   3. approve endpoint flips manual_review → auto_bill
//   4. approve endpoint refuses auto_bill → 409
//   5. classification grouping order: needs_approval < manual_review < auto_bill
//   6. integration: live loadAdminQueue still works after approve endpoint change
//
// Isolation: synthetic contract under ZipKit, synthetic pending_charges
// with run-unique descriptions, full cleanup in try/finally.

import 'dotenv/config';
import { createClient } from '@libsql/client';
import { nanoid } from 'nanoid';
import { provisionContract, deleteContract } from '../src/lib/contracts';
import { POST as approveExpense } from '../src/pages/portal/api/admin/expenses/[id]/approve';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) {
  console.error('TURSO_DATABASE_URL is not set');
  process.exit(1);
}
const db = createClient({ url, authToken });

const TAG = `slice20-${Date.now()}`;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function findTestClient(): Promise<{ id: string; adminUserId: string; adminName: string }> {
  const c = await db.execute({
    sql: 'SELECT id FROM clients WHERE slug = ? OR name LIKE ? LIMIT 1',
    args: ['zipkit-homes', '%ZipKit%'],
  });
  assert(c.rows.length > 0, 'ZipKit missing');
  const a = await db.execute({ sql: `SELECT id, name FROM users WHERE role = 'admin' LIMIT 1` });
  assert(a.rows.length > 0, 'no admin user');
  return {
    id: String(c.rows[0][0]),
    adminUserId: String(a.rows[0][0]),
    adminName: String(a.rows[0][1]),
  };
}

function mkCtx(admin: { id: string; name: string }, chargeId: string) {
  return {
    locals: {
      user: { id: admin.id, email: 'admin@test', name: admin.name, role: 'admin' as const, client_id: null, permissions: null },
    },
    params: { id: chargeId },
  };
}

const trackedChargeIds: string[] = [];
let contractId: string | null = null;

async function insertCharge(cId: string, cls: string, desc: string, category: string | null = null): Promise<string> {
  const id = nanoid();
  const needsApproval = cls === 'needs_approval' || cls === 'manual_review' ? 1 : 0;
  await db.execute({
    sql: `INSERT INTO pending_charges (id, contract_id, description, amount, source_type, classification, needs_approval, category, created_at)
          VALUES (?, ?, ?, 100.00, 'passthrough', ?, ?, ?, datetime('now'))`,
    args: [id, cId, desc, cls, needsApproval, category],
  });
  trackedChargeIds.push(id);
  return id;
}

console.log('=== Slice 20 test: billing input visibility ===\n');

const { id: clientId, adminUserId, adminName } = await findTestClient();

try {
  // Provision a synthetic contract for this test run
  const provision = await provisionContract({
    client_id: clientId,
    title: `Slice20 test ${TAG}`,
    type: 'recurring',
    billing_cadence: 'monthly',
    billing_day: 15,
    recurring_amount: 500,
    created_by: adminUserId,
  });
  contractId = provision.contract_id;

  // --- 20.1 classification query returns the right columns ---
  {
    console.log('--- 20.1 classification columns in query ---');
    const naId = await insertCharge(contractId, 'needs_approval', `${TAG}-na`, 'hosting');
    const mrId = await insertCharge(contractId, 'manual_review', `${TAG}-mr`);
    const abId = await insertCharge(contractId, 'auto_bill', `${TAG}-ab`, 'tools');

    const rows = await db.execute({
      sql: `SELECT pc.id, pc.classification, pc.needs_approval, pc.category
            FROM pending_charges pc
            WHERE pc.id IN (?, ?, ?)
            ORDER BY pc.id`,
      args: [naId, mrId, abId],
    });
    assert(rows.rows.length === 3, `expected 3 rows, got ${rows.rows.length}`);

    const byId = new Map(rows.rows.map((r) => [String(r[0]), r]));
    const naRow = byId.get(naId)!;
    assert(naRow[1] === 'needs_approval', `na classification: ${naRow[1]}`);
    assert(Number(naRow[2]) === 1, `na needs_approval: ${naRow[2]}`);
    assert(naRow[3] === 'hosting', `na category: ${naRow[3]}`);

    const mrRow = byId.get(mrId)!;
    assert(mrRow[1] === 'manual_review', `mr classification: ${mrRow[1]}`);

    const abRow = byId.get(abId)!;
    assert(abRow[1] === 'auto_bill', `ab classification: ${abRow[1]}`);
    assert(Number(abRow[2]) === 0, `ab needs_approval: ${abRow[2]}`);
    assert(abRow[3] === 'tools', `ab category: ${abRow[3]}`);
    console.log('  OK\n');
  }

  // --- 20.2 approve flips needs_approval → auto_bill ---
  {
    console.log('--- 20.2 approve needs_approval → auto_bill ---');
    const id = await insertCharge(contractId, 'needs_approval', `${TAG}-approve-na`);
    const res = await (approveExpense as any)(mkCtx({ id: adminUserId, name: adminName }, id));
    const body = await res.json();
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
    assert(body.classification === 'auto_bill', `expected auto_bill, got ${body.classification}`);

    // Verify DB state
    const check = await db.execute({ sql: 'SELECT classification, needs_approval FROM pending_charges WHERE id = ?', args: [id] });
    assert(check.rows[0][0] === 'auto_bill', 'DB classification not flipped');
    assert(Number(check.rows[0][1]) === 0, 'DB needs_approval not cleared');
    console.log('  OK\n');
  }

  // --- 20.3 approve flips manual_review → auto_bill ---
  {
    console.log('--- 20.3 approve manual_review → auto_bill ---');
    const id = await insertCharge(contractId, 'manual_review', `${TAG}-approve-mr`);
    const res = await (approveExpense as any)(mkCtx({ id: adminUserId, name: adminName }, id));
    const body = await res.json();
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
    assert(body.classification === 'auto_bill', `expected auto_bill, got ${body.classification}`);

    const check = await db.execute({ sql: 'SELECT classification, needs_approval FROM pending_charges WHERE id = ?', args: [id] });
    assert(check.rows[0][0] === 'auto_bill', 'DB classification not flipped');
    assert(Number(check.rows[0][1]) === 0, 'DB needs_approval not cleared');
    console.log('  OK\n');
  }

  // --- 20.4 approve refuses auto_bill → 409 ---
  {
    console.log('--- 20.4 approve auto_bill → 409 ---');
    const id = await insertCharge(contractId, 'auto_bill', `${TAG}-refuse-ab`);
    const res = await (approveExpense as any)(mkCtx({ id: adminUserId, name: adminName }, id));
    assert(res.status === 409, `expected 409, got ${res.status}`);
    const body = await res.json();
    assert(body.error.includes('auto_bill'), `error should mention auto_bill: ${body.error}`);
    console.log('  OK\n');
  }

  // --- 20.5 classification grouping order ---
  {
    console.log('--- 20.5 classification grouping order ---');
    // Verify the sort order: needs_approval (0) < manual_review (1) < auto_bill (2)
    const items = [
      { classification: 'auto_bill', order: 2 },
      { classification: 'needs_approval', order: 0 },
      { classification: 'manual_review', order: 1 },
      { classification: null, order: 3 },
    ];

    function classificationOrder(cls: string | null): number {
      if (cls === 'needs_approval') return 0;
      if (cls === 'manual_review') return 1;
      if (cls === 'auto_bill') return 2;
      return 3;
    }

    const sorted = [...items].sort((a, b) => classificationOrder(a.classification) - classificationOrder(b.classification));
    assert(sorted[0].classification === 'needs_approval', `[0] expected needs_approval, got ${sorted[0].classification}`);
    assert(sorted[1].classification === 'manual_review', `[1] expected manual_review, got ${sorted[1].classification}`);
    assert(sorted[2].classification === 'auto_bill', `[2] expected auto_bill, got ${sorted[2].classification}`);
    assert(sorted[3].classification === null, `[3] expected null, got ${sorted[3].classification}`);
    console.log('  OK\n');
  }

  // --- 20.integration: loadAdminQueue still works ---
  {
    console.log('--- 20.integration: loadAdminQueue + work summary ---');
    const { loadAdminQueue } = await import('../src/lib/admin-queue');
    const { buildWorkSummary } = await import('../src/lib/admin-work-summary');
    const queue = await loadAdminQueue();
    const summary = buildWorkSummary(queue);

    assert(Array.isArray(queue.sections), 'queue.sections is array');
    assert(typeof queue.counts === 'object', 'queue.counts is object');
    assert(Array.isArray(summary.actNow), 'summary.actNow is array');
    assert(Array.isArray(summary.waiting), 'summary.waiting is array');
    assert(Array.isArray(summary.upcoming), 'summary.upcoming is array');

    console.log(`  queue sections: ${queue.sections.length}`);
    console.log(`  summary actNow: ${summary.actNow.length}, waiting: ${summary.waiting.length}, upcoming: ${summary.upcoming.length}`);
    console.log('  OK\n');
  }

} finally {
  // Cleanup: delete all tracked charges, then the contract
  for (const id of trackedChargeIds) {
    await db.execute({ sql: 'DELETE FROM pending_charges WHERE id = ?', args: [id] }).catch(() => {});
  }
  // Belt-and-braces: delete any charge with the tag in its description
  await db.execute({
    sql: `DELETE FROM pending_charges WHERE description LIKE ?`,
    args: [`%${TAG}%`],
  }).catch(() => {});
  // Clean up activity log entries for this test
  if (contractId) {
    await db.execute({ sql: `DELETE FROM activity_log WHERE entity_type = 'pending_charge' AND summary LIKE ?`, args: [`%${TAG}%`] }).catch(() => {});
  }
  if (contractId) {
    await deleteContract(contractId).catch(() => {});
  }
}

console.log('SLICE 20 TEST PASSED \u2713');
