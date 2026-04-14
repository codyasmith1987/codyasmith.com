// Slice 14b — POST /portal/api/admin/expenses/[id]/approve
//
// Imports the route handler directly and calls it with a minimal
// context object. No dev server needed. Exercises:
//   1. Happy path — needs_approval row flips to auto_bill, activity
//      log entry written, 200 ok
//   2. Wrong classification — auto_bill input → 409 with clear error
//   3. Missing id / not found → 404
//   4. Non-admin caller → 403
//
// Isolation: fresh synthetic contract under ZipKit, synthetic
// pending_charges tagged with a run-unique suffix, full cleanup on
// both success and failure.
//
// Run:
//   npx tsx scripts/phase1-test-expense-approve.ts

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

async function findTestClient(): Promise<{ id: string; adminUserId: string; adminName: string }> {
  const c = await db.execute({
    sql: 'SELECT id FROM clients WHERE slug = ? OR name LIKE ? LIMIT 1',
    args: ['zipkit-homes', '%ZipKit%'],
  });
  assert(c.rows.length > 0, 'ZipKit missing');
  const a = await db.execute({
    sql: `SELECT id, name FROM users WHERE role = 'admin' LIMIT 1`,
  });
  assert(a.rows.length > 0, 'no admin user');
  return {
    id: String(c.rows[0][0]),
    adminUserId: String(a.rows[0][0]),
    adminName: String(a.rows[0][1]),
  };
}

// Minimal APIContext-ish object. The handler only reads locals and
// params; everything else can be undefined. Cast to any at call site
// so TypeScript doesn't complain about missing APIContext fields.
function mkCtx(admin: { id: string; name: string }, chargeId: string) {
  return {
    locals: {
      user: {
        id: admin.id,
        email: 'admin@test',
        name: admin.name,
        role: 'admin' as const,
        client_id: null,
        permissions: null,
      },
    },
    params: { id: chargeId },
  };
}

function mkCtxNonAdmin(chargeId: string) {
  return {
    locals: {
      user: {
        id: 'not-admin',
        email: 'client@test',
        name: 'Client',
        role: 'client' as const,
        client_id: null,
        permissions: null,
      },
    },
    params: { id: chargeId },
  };
}

async function main() {
  console.log('=== Slice 14b test: expense approve ===');
  console.log();

  const testClient = await findTestClient();
  const tag = nanoid(6);

  const provision = await provisionContract({
    client_id: testClient.id,
    title: `slice-14b-test-${tag}`,
    type: 'retainer',
    created_by: testClient.adminUserId,
  });
  await db.execute({
    sql: `UPDATE contracts SET status = 'active' WHERE id = ?`,
    args: [provision.contract_id],
  });

  const chargeIds: string[] = [];

  try {
    // Create two test charges for this contract — one needs_approval,
    // one auto_bill (for the 409 "wrong classification" case).
    const needsId = nanoid();
    chargeIds.push(needsId);
    await db.execute({
      sql: `INSERT INTO pending_charges
            (id, contract_id, description, amount, source_type, category, classification, needs_approval)
            VALUES (?, ?, ?, ?, 'passthrough', 'hosting', 'needs_approval', 1)`,
      args: [needsId, provision.contract_id, `slice-14b-${tag}-needs`, 120],
    });

    const autoId = nanoid();
    chargeIds.push(autoId);
    await db.execute({
      sql: `INSERT INTO pending_charges
            (id, contract_id, description, amount, source_type, category, classification, needs_approval)
            VALUES (?, ?, ?, ?, 'passthrough', 'hosting', 'auto_bill', 0)`,
      args: [autoId, provision.contract_id, `slice-14b-${tag}-auto`, 30],
    });

    // Bundle admin identity once — mkCtx needs the admin user, not
    // the client row, as `user.id`. Without this, logActivity fails a
    // user_id FK check because the client_id isn't a valid users row.
    const adminIdent = { id: testClient.adminUserId, name: testClient.adminName };

    // ---- 1. Happy path ----
    console.log('--- happy path ---');
    const res = await approveExpense(mkCtx(adminIdent, needsId) as any);
    eq(res.status, 200, 'approve ok status');
    const body = await res.json();
    eq(body.ok, true, 'body.ok');
    eq(body.classification, 'auto_bill', 'body.classification');
    // Verify DB state.
    const after = await db.execute({
      sql: `SELECT classification, needs_approval FROM pending_charges WHERE id = ?`,
      args: [needsId],
    });
    eq(String(after.rows[0][0]), 'auto_bill', 'DB classification flipped');
    eq(Number(after.rows[0][1]), 0, 'DB needs_approval cleared');
    // Verify activity log.
    const act = await db.execute({
      sql: `SELECT summary FROM activity_log
            WHERE action = 'approved' AND entity_type = 'pending_charge' AND entity_id = ?`,
      args: [needsId],
    });
    eq(act.rows.length, 1, 'activity row written');
    const summary = String(act.rows[0][0]);
    assert(/approved expense/.test(summary), 'summary says approved');
    assert(/reclassified auto_bill/.test(summary), 'summary says reclassified');
    console.log('  OK');
    console.log();

    // ---- 2. Wrong classification (already auto_bill) ----
    console.log('--- wrong classification ---');
    const res2 = await approveExpense(mkCtx(adminIdent, autoId) as any);
    eq(res2.status, 409, 'approve wrong-class status');
    const body2 = await res2.json();
    assert(/cannot approve/.test(body2.error), '409 error message');
    assert(/auto_bill/.test(body2.error), '409 names current classification');
    console.log('  OK');
    console.log();

    // ---- 3. Not found ----
    console.log('--- not found ---');
    const res3 = await approveExpense(mkCtx(adminIdent, 'does-not-exist') as any);
    eq(res3.status, 404, 'approve not-found status');
    console.log('  OK');
    console.log();

    // ---- 4. Non-admin caller ----
    console.log('--- non-admin forbidden ---');
    const res4 = await approveExpense(mkCtxNonAdmin(needsId) as any);
    eq(res4.status, 403, 'approve non-admin status');
    console.log('  OK');
    console.log();

    // ---- 5. Already-approved re-call is a 409 ----
    // The happy path above flipped needsId → auto_bill. A second call
    // on the same id must hit the wrong-classification 409 branch.
    console.log('--- double approve 409 ---');
    const res5 = await approveExpense(mkCtx(adminIdent, needsId) as any);
    eq(res5.status, 409, 'double approve blocked');
    console.log('  OK');
    console.log();
  } finally {
    for (const cid of chargeIds) {
      await db.execute({ sql: 'DELETE FROM pending_charges WHERE id = ?', args: [cid] });
    }
    await db.execute({
      sql: 'DELETE FROM activity_log WHERE entity_type = ? AND entity_id IN (' +
        chargeIds.map(() => '?').join(',') +
        ')',
      args: ['pending_charge', ...chargeIds],
    });
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
      await db.execute({
        sql: 'DELETE FROM projects WHERE contract_id = ?',
        args: [provision.contract_id],
      });
      await db.execute({
        sql: 'DELETE FROM contracts WHERE id = ?',
        args: [provision.contract_id],
      });
    }
    console.log('  cleanup complete');
    console.log();
  }

  console.log('SLICE 14b TEST PASSED ✓');
}

main().catch((err) => {
  console.error();
  console.error('SLICE 14b TEST FAILED:', err);
  process.exit(1);
});
