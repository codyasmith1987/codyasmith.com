// Slice 16b — reject quick action for needs_approval expenses.
//
// "Reject" reuses the existing DELETE /portal/api/admin/expenses/[id]
// handler rather than introducing a parallel endpoint, because the
// semantics are identical: the needs_approval pending_charge row
// goes away and any activity log trail is preserved. This test
// exercises that path from end to end and verifies that the
// admin-queue emits both approve AND reject quickActions on
// needs_approval rows so Cody can choose from the queue.
//
// Cases:
//   1. admin-queue emits both approve + reject quickActions for
//      needs_approval rows (replaces the slice 13b single-action
//      shape)
//   2. DELETE handler removes a needs_approval row cleanly and
//      writes an activity_log entry
//   3. Non-admin DELETE → 403
//   4. DELETE a row bound to a NON-draft invoice → 409 (protection
//      of already-sent invoice totals)
//   5. Post-reject loadAdminQueue no longer surfaces the row in
//      unbilled_needs_approval
//
// Isolation: fresh synthetic contract under ZipKit with a tagged
// description suffix so cleanup is precise.
//
// Run:
//   npx tsx scripts/phase1-test-expense-reject.ts

import 'dotenv/config';
import { createClient } from '@libsql/client';
import { nanoid } from 'nanoid';
import { provisionContract, deleteContract } from '../src/lib/contracts';
import { loadAdminQueue } from '../src/lib/admin-queue';
import { DELETE as deleteExpense } from '../src/pages/portal/api/admin/expenses/[id]';

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

function mkAdminCtx(admin: { id: string; name: string }, chargeId: string) {
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
function mkClientCtx(chargeId: string) {
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
  console.log('=== Slice 16b test: expense reject ===');
  console.log();

  const testClient = await findTestClient();
  const admin = { id: testClient.adminUserId, name: testClient.adminName };
  const tag = nanoid(6);

  const provision = await provisionContract({
    client_id: testClient.id,
    title: `slice-16b-test-${tag}`,
    type: 'retainer',
    created_by: testClient.adminUserId,
  });
  await db.execute({
    sql: `UPDATE contracts SET status = 'active' WHERE id = ?`,
    args: [provision.contract_id],
  });

  const chargeIds: string[] = [];
  try {
    // Seed three needs_approval charges so we can verify:
    //   - the queue shows both approve and reject quickActions
    //   - one reject call removes its row
    //   - the remaining rows are unaffected
    const id1 = nanoid();
    const id2 = nanoid();
    const id3 = nanoid();
    chargeIds.push(id1, id2, id3);
    for (const [id, desc, amt] of [
      [id1, `slice16b-${tag}-alpha`, 120],
      [id2, `slice16b-${tag}-beta`, 60],
      [id3, `slice16b-${tag}-gamma`, 200],
    ] as const) {
      await db.execute({
        sql: `INSERT INTO pending_charges
              (id, contract_id, description, amount, source_type, category, classification, needs_approval)
              VALUES (?, ?, ?, ?, 'passthrough', 'hosting', 'needs_approval', 1)`,
        args: [id, provision.contract_id, desc, amt],
      });
    }

    // ---- Case 1: queue shows both approve and reject ----
    console.log('--- case 1: queue quickActions shape ---');
    const queue1 = await loadAdminQueue();
    const naSection = queue1.sections.find((s) => s.key === 'unbilled_needs_approval');
    assert(naSection, 'unbilled_needs_approval section exists');
    const myRow = naSection!.rows.find((r) => r.id === id1);
    assert(myRow, 'test row in section');
    assert(
      myRow!.quickActions && myRow!.quickActions.length === 2,
      'row has exactly 2 quickActions'
    );
    const approveAction = myRow!.quickActions!.find((a) => a.label === 'approve');
    const rejectAction = myRow!.quickActions!.find((a) => a.label === 'reject');
    assert(approveAction, 'approve action present');
    assert(rejectAction, 'reject action present');
    eq(approveAction!.method, 'POST', 'approve method POST');
    eq(rejectAction!.method, 'DELETE', 'reject method DELETE');
    assert(
      approveAction!.url.endsWith(`/expenses/${id1}/approve`),
      'approve url is the approve endpoint'
    );
    assert(
      rejectAction!.url.endsWith(`/expenses/${id1}`),
      'reject url is the base DELETE endpoint'
    );
    console.log('  OK');
    console.log();

    // ---- Case 2: DELETE removes a needs_approval row ----
    console.log('--- case 2: reject deletes needs_approval row ---');
    const r2 = await deleteExpense(mkAdminCtx(admin, id1) as any);
    eq(r2.status, 200, 'delete 200');
    const body2 = await r2.json();
    eq(body2.ok, true, 'body.ok');

    const stillThere = await db.execute({
      sql: 'SELECT COUNT(*) FROM pending_charges WHERE id = ?',
      args: [id1],
    });
    eq(Number(stillThere.rows[0][0]), 0, 'row removed from DB');

    const act = await db.execute({
      sql: `SELECT summary FROM activity_log
            WHERE action = 'deleted' AND entity_type = 'pending_charge' AND entity_id = ?`,
      args: [id1],
    });
    eq(act.rows.length, 1, 'activity row for delete');
    assert(/deleted expense/.test(String(act.rows[0][0])), 'summary says deleted');
    console.log('  OK');
    console.log();

    // ---- Case 3: non-admin forbidden ----
    console.log('--- case 3: non-admin 403 ---');
    const r3 = await deleteExpense(mkClientCtx(id2) as any);
    eq(r3.status, 403, 'non-admin 403');
    const stillThereAfter3 = await db.execute({
      sql: 'SELECT COUNT(*) FROM pending_charges WHERE id = ?',
      args: [id2],
    });
    eq(Number(stillThereAfter3.rows[0][0]), 1, 'row untouched after non-admin delete attempt');
    console.log('  OK');
    console.log();

    // ---- Case 4: DELETE protected when bound to sent invoice ----
    console.log('--- case 4: protected from deleting sent-invoice-bound row ---');
    // Create a sent invoice + bind charge id3 to it.
    const invId = nanoid();
    await db.execute({
      sql: `INSERT INTO invoices
            (id, contract_id, client_id, invoice_number, status, issued_date, due_date,
             subtotal, tax, total, amount_paid, client_visible, created_by)
            VALUES (?, ?, ?, ?, 'sent', date('now'), date('now', '+30 days'),
                    200, 0, 200, 0, 1, ?)`,
      args: [
        invId,
        provision.contract_id,
        testClient.id,
        `SLICE16B-${tag}`,
        testClient.adminUserId,
      ],
    });
    try {
      await db.execute({
        sql: `UPDATE pending_charges SET billed_invoice_id = ? WHERE id = ?`,
        args: [invId, id3],
      });
      const r4 = await deleteExpense(mkAdminCtx(admin, id3) as any);
      eq(r4.status, 409, 'sent-invoice-bound row 409');
      const body4 = await r4.json();
      assert(/cannot delete/i.test(body4.error), '409 error mentions cannot delete');

      const stillThereAfter4 = await db.execute({
        sql: 'SELECT COUNT(*) FROM pending_charges WHERE id = ?',
        args: [id3],
      });
      eq(Number(stillThereAfter4.rows[0][0]), 1, 'row still there after blocked delete');
    } finally {
      // Unbind + delete the synthetic invoice before teardown.
      await db.execute({
        sql: `UPDATE pending_charges SET billed_invoice_id = NULL WHERE id = ?`,
        args: [id3],
      });
      await db.execute({ sql: 'DELETE FROM invoices WHERE id = ?', args: [invId] });
    }
    console.log('  OK');
    console.log();

    // ---- Case 5: queue no longer surfaces rejected row ----
    console.log('--- case 5: queue reflects removed row ---');
    const queue5 = await loadAdminQueue();
    const naSection5 = queue5.sections.find((s) => s.key === 'unbilled_needs_approval');
    assert(naSection5, 'section still exists');
    const rejectedRow = naSection5!.rows.find((r) => r.id === id1);
    eq(rejectedRow, undefined, 'rejected row no longer in queue');
    const remainingRow = naSection5!.rows.find((r) => r.id === id2);
    assert(remainingRow, 'other test row still in queue');
    console.log('  OK');
    console.log();
  } finally {
    for (const cid of chargeIds) {
      await db.execute({ sql: 'DELETE FROM pending_charges WHERE id = ?', args: [cid] });
      await db.execute({
        sql: 'DELETE FROM activity_log WHERE entity_type = ? AND entity_id = ?',
        args: ['pending_charge', cid],
      });
    }
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
  }

  console.log('SLICE 16b TEST PASSED ✓');
}

main().catch((err) => {
  console.error();
  console.error('SLICE 16b TEST FAILED:', err);
  process.exit(1);
});
