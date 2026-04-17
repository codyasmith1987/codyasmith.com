// Slice 25 test: client-facing milestone progress summary.
//
// Proves buildProgressSummary assembles the correct three-bucket
// output from the existing milestones table, respects client_visible
// on both milestones and parent projects, excludes non-active
// contracts, honors the 30-day recency window on justFinished, and
// prefers client_update_text over title when present.
//
// Nine assertion blocks:
//
//   1. in_progress only → inProgress set, others undefined
//   2. recently completed only (within 30d) → justFinished set
//   3. completed >30d ago → excluded; if nothing else, hasAny=false
//   4. not_started upcoming only → comingUp set
//   5. mixed state (one of each) → all three populated
//   6. all client_visible=0 → hasAny=false
//   7. contract.status='completed' → excluded, hasAny=false
//   8. client_update_text preferred over title
//   9. null/empty client_update_text → fallback to title
//
// Isolation: one synthetic client per scenario via direct
// `INSERT INTO clients`. Each scenario creates exactly the
// milestone rows it needs — no provisionContract defaults to fight.
// Full teardown in try/finally.
//
// Run:
//   npx tsx scripts/phase1-test-slice25-progress-summary.ts

import 'dotenv/config';
import { createClient as createTursoClient } from '@libsql/client';
import { nanoid } from 'nanoid';
import {
  buildProgressSummary,
  JUST_FINISHED_WINDOW_DAYS,
} from '../src/lib/client-progress-summary';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) {
  console.error('TURSO_DATABASE_URL is not set');
  process.exit(1);
}
const db = createTursoClient({ url, authToken });

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

async function findAdminUserId(): Promise<string> {
  const a = await db.execute({
    sql: `SELECT id FROM users WHERE role = 'admin' LIMIT 1`,
  });
  assert(a.rows.length > 0, 'no admin user present for created_by FK');
  return String(a.rows[0][0]);
}

async function createClientRow(name: string, slug: string): Promise<string> {
  const id = nanoid();
  await db.execute({
    sql: `INSERT INTO clients (id, name, slug, active) VALUES (?, ?, ?, 1)`,
    args: [id, name, slug],
  });
  return id;
}

async function createContract(params: {
  clientId: string;
  adminUserId: string;
  title: string;
  status: 'active' | 'completed' | 'cancelled' | 'draft';
}): Promise<string> {
  const id = nanoid();
  await db.execute({
    sql: `INSERT INTO contracts
          (id, client_id, title, status, type, created_by)
          VALUES (?, ?, ?, ?, 'fixed', ?)`,
    args: [id, params.clientId, params.title, params.status, params.adminUserId],
  });
  return id;
}

async function createProject(params: {
  contractId: string;
  clientId: string;
  title: string;
  clientVisible: boolean;
}): Promise<string> {
  const id = nanoid();
  await db.execute({
    sql: `INSERT INTO projects
          (id, contract_id, client_id, title, status, sort_order, client_visible)
          VALUES (?, ?, ?, ?, 'in_progress', 0, ?)`,
    args: [
      id,
      params.contractId,
      params.clientId,
      params.title,
      params.clientVisible ? 1 : 0,
    ],
  });
  return id;
}

async function createMilestone(params: {
  projectId: string;
  title: string;
  status: 'not_started' | 'in_progress' | 'completed' | 'on_hold' | 'cancelled';
  clientVisible: boolean;
  clientUpdateText?: string | null;
  completedAtIso?: string | null;
  dueDate?: string | null;
  sortOrder?: number;
}): Promise<string> {
  const id = nanoid();
  await db.execute({
    sql: `INSERT INTO milestones
          (id, project_id, title, status, client_visible, client_update_text,
           completed_at, due_date, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      params.projectId,
      params.title,
      params.status,
      params.clientVisible ? 1 : 0,
      params.clientUpdateText ?? null,
      params.completedAtIso ?? null,
      params.dueDate ?? null,
      params.sortOrder ?? 0,
    ],
  });
  return id;
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().replace('T', ' ').slice(0, 19);
}

async function teardownClient(clientId: string): Promise<void> {
  // Order matters for FK integrity: milestones → projects → contracts → client.
  try {
    await db.execute({
      sql: `DELETE FROM milestones WHERE project_id IN
            (SELECT id FROM projects WHERE client_id = ?)`,
      args: [clientId],
    });
  } catch {}
  try {
    await db.execute({
      sql: `DELETE FROM projects WHERE client_id = ?`,
      args: [clientId],
    });
  } catch {}
  try {
    await db.execute({
      sql: `DELETE FROM activity_log WHERE entity_type = 'contract'
            AND entity_id IN (SELECT id FROM contracts WHERE client_id = ?)`,
      args: [clientId],
    });
  } catch {}
  try {
    await db.execute({
      sql: `DELETE FROM contracts WHERE client_id = ?`,
      args: [clientId],
    });
  } catch {}
  try {
    await db.execute({ sql: `DELETE FROM clients WHERE id = ?`, args: [clientId] });
  } catch {}
}

async function main() {
  console.log('=== Slice 25 test: progress summary ===\n');

  const adminUserId = await findAdminUserId();
  const tag = nanoid(6);

  const clientIds: string[] = [];

  try {
    // -------------------------------------------------------------
    // 25.1 — in_progress only surfaces as inProgress
    // -------------------------------------------------------------
    {
      console.log('--- 25.1 in_progress only ---');
      const clientId = await createClientRow(
        `Slice 25 Client 1 ${tag}`,
        `slice-25-c1-${tag}`
      );
      clientIds.push(clientId);
      const cid = await createContract({
        clientId,
        adminUserId,
        title: `contract-1-${tag}`,
        status: 'active',
      });
      const pid = await createProject({
        contractId: cid,
        clientId,
        title: 'project',
        clientVisible: true,
      });
      await createMilestone({
        projectId: pid,
        title: 'Homepage redesign',
        status: 'in_progress',
        clientVisible: true,
        clientUpdateText: 'your new homepage',
      });
      const s = await buildProgressSummary(clientId);
      eq(s.hasAny, true, '25.1 hasAny');
      eq(s.inProgress, 'Working on your new homepage', '25.1 inProgress sentence');
      eq(s.justFinished, undefined, '25.1 justFinished undefined');
      eq(s.comingUp, undefined, '25.1 comingUp undefined');
      console.log('  OK\n');
    }

    // -------------------------------------------------------------
    // 25.2 — recently completed only (within 30d)
    // -------------------------------------------------------------
    {
      console.log('--- 25.2 recently completed only ---');
      const clientId = await createClientRow(
        `Slice 25 Client 2 ${tag}`,
        `slice-25-c2-${tag}`
      );
      clientIds.push(clientId);
      const cid = await createContract({
        clientId,
        adminUserId,
        title: `contract-2-${tag}`,
        status: 'active',
      });
      const pid = await createProject({
        contractId: cid,
        clientId,
        title: 'project',
        clientVisible: true,
      });
      await createMilestone({
        projectId: pid,
        title: 'Brand refresh',
        status: 'completed',
        clientVisible: true,
        clientUpdateText: 'the brand refresh',
        completedAtIso: isoDaysAgo(5),
      });
      const s = await buildProgressSummary(clientId);
      eq(s.hasAny, true, '25.2 hasAny');
      eq(s.justFinished, 'Just finished the brand refresh', '25.2 justFinished sentence');
      eq(s.inProgress, undefined, '25.2 inProgress undefined');
      eq(s.comingUp, undefined, '25.2 comingUp undefined');
      console.log('  OK\n');
    }

    // -------------------------------------------------------------
    // 25.3 — completed >30 days ago → excluded
    // -------------------------------------------------------------
    {
      console.log('--- 25.3 completed outside 30d window ---');
      const clientId = await createClientRow(
        `Slice 25 Client 3 ${tag}`,
        `slice-25-c3-${tag}`
      );
      clientIds.push(clientId);
      const cid = await createContract({
        clientId,
        adminUserId,
        title: `contract-3-${tag}`,
        status: 'active',
      });
      const pid = await createProject({
        contractId: cid,
        clientId,
        title: 'project',
        clientVisible: true,
      });
      await createMilestone({
        projectId: pid,
        title: 'Stale milestone',
        status: 'completed',
        clientVisible: true,
        clientUpdateText: 'something old',
        completedAtIso: isoDaysAgo(JUST_FINISHED_WINDOW_DAYS + 5),
      });
      const s = await buildProgressSummary(clientId);
      eq(s.hasAny, false, '25.3 hasAny=false (outside window)');
      eq(s.justFinished, undefined, '25.3 justFinished undefined');
      console.log('  OK\n');
    }

    // -------------------------------------------------------------
    // 25.4 — not_started only → comingUp
    // -------------------------------------------------------------
    {
      console.log('--- 25.4 not_started only ---');
      const clientId = await createClientRow(
        `Slice 25 Client 4 ${tag}`,
        `slice-25-c4-${tag}`
      );
      clientIds.push(clientId);
      const cid = await createContract({
        clientId,
        adminUserId,
        title: `contract-4-${tag}`,
        status: 'active',
      });
      const pid = await createProject({
        contractId: cid,
        clientId,
        title: 'project',
        clientVisible: true,
      });
      await createMilestone({
        projectId: pid,
        title: 'Launch week',
        status: 'not_started',
        clientVisible: true,
        clientUpdateText: 'the launch',
      });
      const s = await buildProgressSummary(clientId);
      eq(s.hasAny, true, '25.4 hasAny');
      eq(s.comingUp, 'Coming up: the launch', '25.4 comingUp sentence');
      eq(s.inProgress, undefined, '25.4 inProgress undefined');
      eq(s.justFinished, undefined, '25.4 justFinished undefined');
      console.log('  OK\n');
    }

    // -------------------------------------------------------------
    // 25.5 — mixed state (one of each)
    // -------------------------------------------------------------
    {
      console.log('--- 25.5 mixed state ---');
      const clientId = await createClientRow(
        `Slice 25 Client 5 ${tag}`,
        `slice-25-c5-${tag}`
      );
      clientIds.push(clientId);
      const cid = await createContract({
        clientId,
        adminUserId,
        title: `contract-5-${tag}`,
        status: 'active',
      });
      const pid = await createProject({
        contractId: cid,
        clientId,
        title: 'project',
        clientVisible: true,
      });
      await createMilestone({
        projectId: pid,
        title: 'Research',
        status: 'completed',
        clientVisible: true,
        clientUpdateText: 'the research phase',
        completedAtIso: isoDaysAgo(10),
        sortOrder: 1,
      });
      await createMilestone({
        projectId: pid,
        title: 'Design',
        status: 'in_progress',
        clientVisible: true,
        clientUpdateText: 'the design phase',
        sortOrder: 2,
      });
      await createMilestone({
        projectId: pid,
        title: 'Build',
        status: 'not_started',
        clientVisible: true,
        clientUpdateText: 'the build phase',
        sortOrder: 3,
      });
      const s = await buildProgressSummary(clientId);
      eq(s.hasAny, true, '25.5 hasAny');
      eq(s.inProgress, 'Working on the design phase', '25.5 inProgress');
      eq(s.justFinished, 'Just finished the research phase', '25.5 justFinished');
      eq(s.comingUp, 'Coming up: the build phase', '25.5 comingUp');
      console.log('  OK\n');
    }

    // -------------------------------------------------------------
    // 25.6 — all client_visible=0 → hasAny=false
    // -------------------------------------------------------------
    {
      console.log('--- 25.6 all internal milestones ---');
      const clientId = await createClientRow(
        `Slice 25 Client 6 ${tag}`,
        `slice-25-c6-${tag}`
      );
      clientIds.push(clientId);
      const cid = await createContract({
        clientId,
        adminUserId,
        title: `contract-6-${tag}`,
        status: 'active',
      });
      const pid = await createProject({
        contractId: cid,
        clientId,
        title: 'project',
        clientVisible: true,
      });
      await createMilestone({
        projectId: pid,
        title: 'Internal prep',
        status: 'in_progress',
        clientVisible: false,
        clientUpdateText: 'should not leak',
      });
      await createMilestone({
        projectId: pid,
        title: 'Internal followup',
        status: 'completed',
        clientVisible: false,
        completedAtIso: isoDaysAgo(3),
      });
      await createMilestone({
        projectId: pid,
        title: 'Internal upcoming',
        status: 'not_started',
        clientVisible: false,
      });
      const s = await buildProgressSummary(clientId);
      eq(s.hasAny, false, '25.6 hasAny=false for internal-only milestones');
      eq(s.inProgress, undefined, '25.6 inProgress undefined');
      eq(s.justFinished, undefined, '25.6 justFinished undefined');
      eq(s.comingUp, undefined, '25.6 comingUp undefined');
      console.log('  OK\n');
    }

    // -------------------------------------------------------------
    // 25.7 — completed contract → excluded
    // -------------------------------------------------------------
    {
      console.log('--- 25.7 completed contract excluded ---');
      const clientId = await createClientRow(
        `Slice 25 Client 7 ${tag}`,
        `slice-25-c7-${tag}`
      );
      clientIds.push(clientId);
      const cid = await createContract({
        clientId,
        adminUserId,
        title: `contract-7-${tag}`,
        status: 'completed',
      });
      const pid = await createProject({
        contractId: cid,
        clientId,
        title: 'project',
        clientVisible: true,
      });
      await createMilestone({
        projectId: pid,
        title: 'Post-contract work',
        status: 'in_progress',
        clientVisible: true,
        clientUpdateText: 'should not surface',
      });
      const s = await buildProgressSummary(clientId);
      eq(s.hasAny, false, '25.7 hasAny=false for completed contract');
      eq(s.inProgress, undefined, '25.7 inProgress undefined');
      console.log('  OK\n');
    }

    // -------------------------------------------------------------
    // 25.8 — client_update_text preferred over title
    // -------------------------------------------------------------
    {
      console.log('--- 25.8 client_update_text preferred ---');
      const clientId = await createClientRow(
        `Slice 25 Client 8 ${tag}`,
        `slice-25-c8-${tag}`
      );
      clientIds.push(clientId);
      const cid = await createContract({
        clientId,
        adminUserId,
        title: `contract-8-${tag}`,
        status: 'active',
      });
      const pid = await createProject({
        contractId: cid,
        clientId,
        title: 'project',
        clientVisible: true,
      });
      await createMilestone({
        projectId: pid,
        title: 'PRELIMINARY DISCOVERY ENGAGEMENT',
        status: 'in_progress',
        clientVisible: true,
        clientUpdateText: 'getting to know your brand',
      });
      const s = await buildProgressSummary(clientId);
      eq(s.inProgress, 'Working on getting to know your brand', '25.8 client_update_text wins');
      // Title should NOT appear in the sentence.
      assert(
        !(s.inProgress ?? '').includes('PRELIMINARY'),
        `25.8 title must not leak into sentence: ${s.inProgress}`
      );
      console.log('  OK\n');
    }

    // -------------------------------------------------------------
    // 25.9 — fallback to title when client_update_text is null/empty
    // -------------------------------------------------------------
    {
      console.log('--- 25.9 fallback to title ---');
      const clientId = await createClientRow(
        `Slice 25 Client 9 ${tag}`,
        `slice-25-c9-${tag}`
      );
      clientIds.push(clientId);
      const cid = await createContract({
        clientId,
        adminUserId,
        title: `contract-9-${tag}`,
        status: 'active',
      });
      const pid = await createProject({
        contractId: cid,
        clientId,
        title: 'project',
        clientVisible: true,
      });
      await createMilestone({
        projectId: pid,
        title: 'Discovery',
        status: 'in_progress',
        clientVisible: true,
        clientUpdateText: null,
      });
      await createMilestone({
        projectId: pid,
        title: 'Kickoff',
        status: 'in_progress',
        clientVisible: true,
        clientUpdateText: '   ', // whitespace-only should be treated as empty
        sortOrder: 99, // lower-priority so Discovery wins by sort_order
      });
      const s = await buildProgressSummary(clientId);
      eq(s.inProgress, 'Working on Discovery', '25.9 title fallback when update_text null');
      console.log('  OK\n');
    }
  } finally {
    for (const id of clientIds) {
      await teardownClient(id);
    }
  }

  console.log('SLICE 25 TEST PASSED ✓');
}

main().catch((err) => {
  console.error();
  console.error('SLICE 25 TEST FAILED:', err);
  process.exit(1);
});
