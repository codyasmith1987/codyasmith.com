// Phase 1 Slice 13b — admin-queue integration tests.
//
// Exercises the three new axes of truth the queue now reads:
//   1. Expense classification split
//      - pending_charges with classification='needs_approval' land in
//        the unbilled_needs_approval section
//      - classification='manual_review' lands in manual_review
//      - classification='auto_bill' and NULL (legacy) land in auto_bill
//   2. Milestone delivery truth
//      - a milestone with due_date in the past and status != 'completed'
//        surfaces under overdue_milestones
//      - a milestone with due_date within 14 days surfaces under
//        upcoming_milestones
//   3. Pending-approval row flags a "missing approval contact" warning
//      when the owning client has zero contacts with role='approval'
//
// Isolation: provisions a synthetic contract under ZipKit and attaches
// synthetic pending_charges, milestones, and an approval to it. Every
// row this test creates carries a unique tag in its description /
// title so the assertions can filter out real ZipKit state.
//
// Run:
//   npx tsx scripts/phase1-test-admin-queue.ts

import 'dotenv/config';
import { createClient } from '@libsql/client';
import { nanoid } from 'nanoid';
import { provisionContract, deleteContract } from '../src/lib/contracts';
import { loadAdminQueue } from '../src/lib/admin-queue';

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

async function main() {
  console.log('=== Slice 13b test: admin-queue ===');
  console.log();

  const testClient = await findTestClient();
  const tag = nanoid(6);

  // Provision a fresh active contract with service_type='web_management'
  // so slice 11's milestone template auto-seeds 4 milestones. Activate
  // it immediately so the admin-queue queries surface it.
  const provision = await provisionContract({
    client_id: testClient.id,
    title: `slice-13b-test-${tag}`,
    type: 'retainer',
    service_type: 'web_management',
    created_by: testClient.adminUserId,
  });
  await db.execute({
    sql: `UPDATE contracts SET status = 'active' WHERE id = ?`,
    args: [provision.contract_id],
  });

  const pcIds: string[] = [];
  const approvalId = nanoid();
  let overdueMilestoneId: string | null = null;
  let upcomingMilestoneId: string | null = null;

  try {
    // ---- 1. Classification split ----
    console.log('--- unbilled classification split ---');
    async function insertPC(classification: string, amount: number, tagLabel: string) {
      const id = nanoid();
      pcIds.push(id);
      await db.execute({
        sql: `INSERT INTO pending_charges
              (id, contract_id, description, amount, source_type, category, classification, needs_approval)
              VALUES (?, ?, ?, ?, 'passthrough', ?, ?, ?)`,
        args: [
          id,
          provision.contract_id,
          `slice-13b-${tag}-${tagLabel}`,
          amount,
          'hosting',
          classification,
          classification === 'needs_approval' ? 1 : 0,
        ],
      });
      return id;
    }

    const naId = await insertPC('needs_approval', 120, 'need');
    const mrId = await insertPC('manual_review', 40, 'manual');
    const abId = await insertPC('auto_bill', 25, 'auto');
    // Legacy row with NULL classification — should land under auto-bill bucket
    // per the admin-queue fallback ("treat unknown as auto-bill awareness").
    const legacyId = nanoid();
    pcIds.push(legacyId);
    await db.execute({
      sql: `INSERT INTO pending_charges
            (id, contract_id, description, amount, source_type)
            VALUES (?, ?, ?, ?, 'passthrough')`,
      args: [legacyId, provision.contract_id, `slice-13b-${tag}-legacy`, 15],
    });

    // ---- 2. Milestone delivery truth ----
    // Pick two of the seeded milestones and backdate/forwarddate them.
    // Seeded milestones all have status='not_started' and no due_date
    // at provision time, so we can safely stamp dates on two of them.
    const seeded = await db.execute({
      sql: `SELECT id FROM milestones
            WHERE project_id IN (SELECT id FROM projects WHERE contract_id = ?)
            ORDER BY sort_order`,
      args: [provision.contract_id],
    });
    assert(seeded.rows.length >= 2, 'at least 2 seeded milestones');
    overdueMilestoneId = String(seeded.rows[0][0]);
    upcomingMilestoneId = String(seeded.rows[1][0]);

    await db.execute({
      sql: `UPDATE milestones SET due_date = date('now', '-5 days') WHERE id = ?`,
      args: [overdueMilestoneId],
    });
    await db.execute({
      sql: `UPDATE milestones SET due_date = date('now', '+7 days') WHERE id = ?`,
      args: [upcomingMilestoneId],
    });

    // ---- 3. Pending approval with no approval-role contact ----
    // Add a pending approval, then load the queue and check the
    // "missing approval-role contact" flag surfaces for this row
    // specifically.
    await db.execute({
      sql: `INSERT INTO approvals (id, contract_id, title, status, requested_by)
            VALUES (?, ?, ?, 'pending', ?)`,
      args: [approvalId, provision.contract_id, `slice-13b-${tag}-approval`, testClient.adminUserId],
    });

    // ---- Load the queue and assert ----
    const queue = await loadAdminQueue();

    // Expense classification split
    const naSection = queue.sections.find((s) => s.key === 'unbilled_needs_approval');
    const mrSection = queue.sections.find((s) => s.key === 'unbilled_manual_review');
    const abSection = queue.sections.find((s) => s.key === 'unbilled_auto_bill');
    assert(naSection && mrSection && abSection, 'all three unbilled sections present');

    const naIdsHere = naSection!.rows.map((r) => r.id);
    const mrIdsHere = mrSection!.rows.map((r) => r.id);
    const abIdsHere = abSection!.rows.map((r) => r.id);

    assert(naIdsHere.includes(naId), 'needs_approval row in needs_approval section');
    assert(mrIdsHere.includes(mrId), 'manual_review row in manual_review section');
    assert(abIdsHere.includes(abId), 'auto_bill row in auto_bill section');
    assert(abIdsHere.includes(legacyId), 'legacy NULL classification row in auto_bill section');

    // Cross-section contamination check — no row should appear twice.
    assert(!mrIdsHere.includes(naId), 'needs_approval row NOT in manual_review');
    assert(!abIdsHere.includes(naId), 'needs_approval row NOT in auto_bill');
    console.log('  classification split OK');

    // Needs_approval row message must mention classification clearly.
    const naRow = naSection!.rows.find((r) => r.id === naId)!;
    assert(/needs_approval at entry/.test(naRow.why), 'needs_approval why mentions classification');
    assert(/NOT auto-attach/.test(naRow.why), 'needs_approval why warns about non-attach');

    // Milestone sections
    const overdueSection = queue.sections.find((s) => s.key === 'overdue_milestones');
    const upcomingSection = queue.sections.find((s) => s.key === 'upcoming_milestones');
    assert(overdueSection && upcomingSection, 'milestone sections present');

    const overdueIds = overdueSection!.rows.map((r) => r.id);
    const upcomingIds = upcomingSection!.rows.map((r) => r.id);
    assert(overdueIds.includes(overdueMilestoneId), 'overdue milestone surfaced');
    assert(upcomingIds.includes(upcomingMilestoneId), 'upcoming milestone surfaced');

    const overdueRow = overdueSection!.rows.find((r) => r.id === overdueMilestoneId)!;
    assert(/overdue by \d+d/.test(overdueRow.why), 'overdue why mentions days');
    console.log('  milestone truth OK');

    // Pending approval missing approval-role contact
    const approvalSection = queue.sections.find((s) => s.key === 'pending_approvals');
    assert(approvalSection, 'pending_approvals section present');
    const approvalRow = approvalSection!.rows.find((r) => r.id === approvalId);
    assert(approvalRow, 'test approval row surfaced');
    assert(
      /no approval-role contact/.test(approvalRow!.why),
      'approval row flags missing approval contact'
    );
    console.log('  missing-approval-contact flag OK');
    console.log();
  } finally {
    // Cleanup — delete everything this test created.
    console.log('--- cleanup ---');
    for (const pcId of pcIds) {
      await db.execute({ sql: 'DELETE FROM pending_charges WHERE id = ?', args: [pcId] });
    }
    await db.execute({ sql: 'DELETE FROM approvals WHERE id = ?', args: [approvalId] });
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
      // fallback
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

  console.log('SLICE 13b TEST PASSED ✓');
}

main().catch((err) => {
  console.error();
  console.error('SLICE 13b TEST FAILED:', err);
  process.exit(1);
});
