// Slice 16 — period locking end-to-end tests.
//
// Nine cases across the helper, ingest-guard, API, and admin-queue
// layers. Every synthetic write targets a far-future period
// ('2099-01' / '2099-02') under the ZipKit test client, with a hard
// preflight that aborts if any prior rows already exist for the
// target (client, period_start, source) tuple. The Slice 9 incident
// rule is applied in full: no real or current-month period is ever
// touched by this test.
//
// Run:
//   npx tsx scripts/phase1-test-period-locking.ts

import 'dotenv/config';
import { createClient } from '@libsql/client';
import { nanoid } from 'nanoid';
import {
  getPeriodById,
  isPeriodLocked,
  lockPeriod,
  unlockPeriod,
  getLockedPeriods,
  PeriodLockConflictError,
} from '../src/lib/periods';
import { ingestCSVViaSnapshots } from '../src/lib/csv/ingest-v2';
import { loadAdminQueue } from '../src/lib/admin-queue';
import { POST as lockEndpoint } from '../src/pages/portal/api/admin/periods/[id]/lock';
import { POST as unlockEndpoint } from '../src/pages/portal/api/admin/periods/[id]/unlock';

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

// Minimal position_tracking CSV that passes detector.ts.
const MIN_CSV = [
  'Position,Keyword,Search Volume,URL,Location',
  '1,slice 16 test keyword,100,https://example.com/a,United States',
  '2,slice 16 test alt,50,https://example.com/b,United States',
].join('\n');

async function findTestClient(): Promise<{ id: string; adminUserId: string; adminName: string }> {
  const c = await db.execute({
    sql: 'SELECT id FROM clients WHERE slug = ? OR name LIKE ? LIMIT 1',
    args: ['zipkit-homes', '%ZipKit%'],
  });
  assert(c.rows.length > 0, 'ZipKit test client missing');
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

// Creates a fresh synthetic period row under the test client at the
// given far-future month. Asserts emptiness of the target (client,
// period_start, source) tuple so no real ingestion state can be
// clobbered. Returns the period id.
async function createSyntheticPeriod(
  clientId: string,
  month: string
): Promise<string> {
  const [y, m] = month.split('-').map(Number);
  if (!y || !m || y < 2050) throw new Error('test must use a far-future year');
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const end = `${y}-${String(m).padStart(2, '0')}-28`;

  // Preflight — assert no real rows exist for this month under this client.
  const preflight = await db.execute({
    sql: `SELECT COUNT(*) FROM periods WHERE client_id = ? AND period_start = ?`,
    args: [clientId, start],
  });
  if (Number(preflight.rows[0][0]) !== 0) {
    throw new Error(
      `preflight: period already exists for ${clientId} ${start}. Refusing to run destructive test.`
    );
  }

  const id = nanoid();
  await db.execute({
    sql: `INSERT INTO periods (id, client_id, period_type, period_start, period_end)
          VALUES (?, ?, 'month', ?, ?)`,
    args: [id, clientId, start, end],
  });
  return id;
}

async function cleanupPeriod(periodId: string) {
  // Remove any imports, snapshots, and the period itself.
  await db.execute({ sql: `DELETE FROM keyword_snapshots WHERE period_id = ?`, args: [periodId] });
  await db.execute({ sql: `DELETE FROM issue_snapshots WHERE period_id = ?`, args: [periodId] });
  await db.execute({ sql: `DELETE FROM metric_snapshots WHERE period_id = ?`, args: [periodId] });
  await db.execute({ sql: `DELETE FROM imports WHERE period_id = ?`, args: [periodId] });
  await db.execute({
    sql: `DELETE FROM activity_log WHERE entity_type = ? AND entity_id = ?`,
    args: ['period', periodId],
  });
  await db.execute({ sql: `DELETE FROM periods WHERE id = ?`, args: [periodId] });
}

function mkAdminCtx(admin: { id: string; name: string }, periodId: string) {
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
    params: { id: periodId },
  };
}
function mkClientCtx(periodId: string) {
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
    params: { id: periodId },
  };
}

async function main() {
  console.log('=== Slice 16 test: period locking ===');
  console.log();

  const testClient = await findTestClient();
  const admin = { id: testClient.adminUserId, name: testClient.adminName };

  // ---- Cases 1-2: isPeriodLocked baseline ----
  {
    console.log('--- case 1-2: isPeriodLocked baseline ---');
    const periodId = await createSyntheticPeriod(testClient.id, '2099-01');
    try {
      eq(await isPeriodLocked(periodId), false, 'fresh period unlocked');
      eq(await isPeriodLocked('does-not-exist'), false, 'missing period → false');
      console.log('  OK');
    } finally {
      await cleanupPeriod(periodId);
    }
  }
  console.log();

  // ---- Case 3: lockPeriod helper + idempotency ----
  {
    console.log('--- case 3: lockPeriod helper + 409 on double-lock ---');
    const periodId = await createSyntheticPeriod(testClient.id, '2099-01');
    try {
      const r = await lockPeriod(periodId);
      assert(r.locked_at.length > 0, 'lock returned timestamp');
      eq(await isPeriodLocked(periodId), true, 'period now locked');
      let threw = false;
      try {
        await lockPeriod(periodId);
      } catch (err) {
        if (err instanceof PeriodLockConflictError) threw = true;
      }
      assert(threw, 'double lock throws PeriodLockConflictError');
      console.log('  OK');
    } finally {
      await cleanupPeriod(periodId);
    }
  }
  console.log();

  // ---- Case 4: unlockPeriod helper + 409 on double-unlock ----
  {
    console.log('--- case 4: unlockPeriod helper + 409 on double-unlock ---');
    const periodId = await createSyntheticPeriod(testClient.id, '2099-01');
    try {
      await lockPeriod(periodId);
      const r = await unlockPeriod(periodId);
      assert(r.was_locked_at.length > 0, 'unlock returned prior timestamp');
      eq(await isPeriodLocked(periodId), false, 'period now unlocked');
      let threw = false;
      try {
        await unlockPeriod(periodId);
      } catch (err) {
        if (err instanceof PeriodLockConflictError) threw = true;
      }
      assert(threw, 'double unlock throws PeriodLockConflictError');
      console.log('  OK');
    } finally {
      await cleanupPeriod(periodId);
    }
  }
  console.log();

  // ---- Case 5: ingest guard against a locked period ----
  {
    console.log('--- case 5: ingest blocked on locked period ---');
    // ensurePeriod will resolve to the existing row since we
    // pre-created it. Lock it, then ingest.
    const periodId = await createSyntheticPeriod(testClient.id, '2099-01');
    try {
      await lockPeriod(periodId);

      const salted = MIN_CSV.replace(',United States', ',United States,' + nanoid(5));
      const result = await ingestCSVViaSnapshots(
        salted,
        testClient.id,
        '2099-01',
        'slice16-locked.csv',
        testClient.adminUserId
      );
      eq(result.status, 'failed', 'ingest status failed');
      assert(
        /period.*locked/.test(result.error ?? ''),
        `error mentions period+locked, got: ${result.error}`
      );
      // No snapshot rows were written.
      const snap = await db.execute({
        sql: `SELECT COUNT(*) FROM keyword_snapshots WHERE period_id = ?`,
        args: [periodId],
      });
      eq(Number(snap.rows[0][0]), 0, 'no keyword_snapshots for locked period');
      // Failed import row exists as audit trail.
      const imp = await db.execute({
        sql: `SELECT status, error FROM imports WHERE period_id = ? AND source = 'position_tracking'`,
        args: [periodId],
      });
      eq(imp.rows.length, 1, '1 import row recorded');
      eq(String(imp.rows[0][0]), 'failed', 'import status failed');
      assert(/locked/.test(String(imp.rows[0][1])), 'import error mentions locked');
      console.log('  OK');
    } finally {
      await cleanupPeriod(periodId);
    }
  }
  console.log();

  // ---- Case 6: ingest after unlock succeeds ----
  {
    console.log('--- case 6: ingest succeeds after unlock ---');
    const periodId = await createSyntheticPeriod(testClient.id, '2099-02');
    try {
      await lockPeriod(periodId);
      // First attempt: should fail.
      const r1 = await ingestCSVViaSnapshots(
        MIN_CSV.replace(',United States', ',United States,' + nanoid(5)),
        testClient.id,
        '2099-02',
        'slice16-before-unlock.csv',
        testClient.adminUserId
      );
      eq(r1.status, 'failed', 'first ingest failed (locked)');

      // Unlock and re-attempt with a fresh salt so content_hash differs.
      await unlockPeriod(periodId);
      const r2 = await ingestCSVViaSnapshots(
        MIN_CSV.replace(',United States', ',United States,' + nanoid(5)),
        testClient.id,
        '2099-02',
        'slice16-after-unlock.csv',
        testClient.adminUserId
      );
      eq(r2.status, 'applied', 'second ingest applied (unlocked)');
      assert(r2.rowCount > 0, 'ingest wrote rows');

      const snap = await db.execute({
        sql: `SELECT COUNT(*) FROM keyword_snapshots WHERE period_id = ?`,
        args: [periodId],
      });
      assert(Number(snap.rows[0][0]) >= 2, 'snapshots written after unlock');
      console.log('  OK');
    } finally {
      await cleanupPeriod(periodId);
    }
  }
  console.log();

  // ---- Case 7: lock endpoint (admin + non-admin + missing + 409) ----
  {
    console.log('--- case 7: lock endpoint ---');
    const periodId = await createSyntheticPeriod(testClient.id, '2099-01');
    try {
      // Happy path
      const r1 = await lockEndpoint(mkAdminCtx(admin, periodId) as any);
      eq(r1.status, 200, 'lock 200');
      const body1 = await r1.json();
      eq(body1.ok, true, 'lock ok');
      assert(typeof body1.locked_at === 'string' && body1.locked_at.length > 0, 'lock returns timestamp');

      // Non-admin forbidden
      const r2 = await lockEndpoint(mkClientCtx(periodId) as any);
      eq(r2.status, 403, 'non-admin 403');

      // Already locked → 409
      const r3 = await lockEndpoint(mkAdminCtx(admin, periodId) as any);
      eq(r3.status, 409, 'already-locked 409');

      // Missing period → 404
      const r4 = await lockEndpoint(mkAdminCtx(admin, 'nope-does-not-exist') as any);
      eq(r4.status, 404, 'missing 404');

      // Activity log row recorded
      const act = await db.execute({
        sql: `SELECT summary FROM activity_log WHERE entity_type = 'period' AND entity_id = ? AND action = 'locked'`,
        args: [periodId],
      });
      eq(act.rows.length, 1, 'activity log row for lock');
      assert(/locked period/.test(String(act.rows[0][0])), 'activity summary mentions lock');
      console.log('  OK');
    } finally {
      await cleanupPeriod(periodId);
    }
  }
  console.log();

  // ---- Case 8: unlock endpoint ----
  {
    console.log('--- case 8: unlock endpoint ---');
    const periodId = await createSyntheticPeriod(testClient.id, '2099-01');
    try {
      await lockPeriod(periodId);

      const r1 = await unlockEndpoint(mkAdminCtx(admin, periodId) as any);
      eq(r1.status, 200, 'unlock 200');
      const body1 = await r1.json();
      eq(body1.ok, true, 'unlock ok');

      // Non-admin forbidden
      const r2 = await unlockEndpoint(mkClientCtx(periodId) as any);
      eq(r2.status, 403, 'non-admin 403');

      // Already unlocked → 409
      const r3 = await unlockEndpoint(mkAdminCtx(admin, periodId) as any);
      eq(r3.status, 409, 'already-unlocked 409');

      // Missing period → 404
      const r4 = await unlockEndpoint(mkAdminCtx(admin, 'nope-does-not-exist') as any);
      eq(r4.status, 404, 'missing 404');

      // Activity log row recorded
      const act = await db.execute({
        sql: `SELECT summary FROM activity_log WHERE entity_type = 'period' AND entity_id = ? AND action = 'unlocked'`,
        args: [periodId],
      });
      eq(act.rows.length, 1, 'activity log row for unlock');
      console.log('  OK');
    } finally {
      await cleanupPeriod(periodId);
    }
  }
  console.log();

  // ---- Case 9: admin queue surfaces locked period ----
  {
    console.log('--- case 9: admin queue locked_periods section ---');
    const periodId = await createSyntheticPeriod(testClient.id, '2099-01');
    try {
      await lockPeriod(periodId);

      const queue = await loadAdminQueue();
      const section = queue.sections.find((s) => s.key === 'locked_periods');
      assert(section, 'locked_periods section present');
      assert(section!.count > 0, 'locked_periods count > 0');

      const ourRow = section!.rows.find((r) => r.id === periodId);
      assert(ourRow, 'our locked period in section');
      assert(/frozen at/.test(ourRow!.why), 'why text mentions frozen');
      assert(ourRow!.quickActions && ourRow!.quickActions.length > 0, 'row has quickActions');
      const unlockAction = ourRow!.quickActions!.find((a) => a.label === 'unlock');
      assert(unlockAction, 'unlock action present');
      assert(
        unlockAction!.url.includes(`/periods/${periodId}/unlock`),
        'quickAction url matches period id'
      );
      console.log('  OK');
    } finally {
      await cleanupPeriod(periodId);
    }
  }
  console.log();

  console.log('SLICE 16 TEST PASSED ✓');
}

main().catch((err) => {
  console.error();
  console.error('SLICE 16 TEST FAILED:', err);
  process.exit(1);
});
