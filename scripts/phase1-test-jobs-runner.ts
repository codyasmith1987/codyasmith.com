// Phase 1 Step 5 — scheduled jobs runner test.
//
// Uses send_reminders as the test workload: it's read-only (queries
// invoices WHERE status='sent' AND due within N days AND not paid) and
// prod has no invoices in status='sent', so it will find nothing to do
// and complete without side effects. The assertion is not about what
// the handler does — it's about the runner's lifecycle: claim, lease,
// run, transition, release.
//
// Tests:
//   1. Future scheduled_for is not claimed
//   2. Pending + due is claimed and transitions to 'done'
//   3. Parallel calls to runDueJobs() don't double-process
//   4. A job with no handler transitions to 'failed'
//
// Cleanup removes the test rows afterward.
//
// Run: npx tsx scripts/phase1-test-jobs-runner.ts

import 'dotenv/config';
import { createClient } from '@libsql/client';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) {
  console.error('TURSO_DATABASE_URL is not set');
  process.exit(1);
}
const db = createClient({ url, authToken });

const { enqueueJob, runDueJobs } = await import('../src/lib/jobs/runner');

const TEST_MARKER = 'phase1-runner-test';

async function cleanup() {
  await db.execute({
    sql: "DELETE FROM scheduled_jobs WHERE payload_json LIKE ?",
    args: [`%${TEST_MARKER}%`],
  });
}

async function getJob(id: string) {
  const r = await db.execute({
    sql: 'SELECT id, status, last_result, lease_until FROM scheduled_jobs WHERE id = ?',
    args: [id],
  });
  if (r.rows.length === 0) return null;
  return {
    id: r.rows[0][0] as string,
    status: r.rows[0][1] as string,
    last_result: r.rows[0][2] as string | null,
    lease_until: r.rows[0][3] as string | null,
  };
}

let failures = 0;
const fail = (label: string, msg: string) => {
  console.error(`  FAIL [${label}]: ${msg}`);
  failures++;
};

async function testFutureNotClaimed() {
  console.log('--- test: future job is not claimed ---');
  // Enqueue one scheduled for one hour from now.
  const future = new Date(Date.now() + 60 * 60 * 1000);
  const id = await enqueueJob('send_reminders', future, { marker: TEST_MARKER });
  const before = await getJob(id);
  if (before?.status !== 'pending') fail('future', `pre status=${before?.status}`);

  const result = await runDueJobs(10);
  console.log(`  ran=${result.ranJobIds.length} failed=${result.failedJobIds.length}`);

  const after = await getJob(id);
  if (after?.status !== 'pending') fail('future', `expected still pending, got ${after?.status}`);
  console.log(`  status after run: ${after?.status}  ✓`);
}

async function testDueJobRuns() {
  console.log('--- test: due job runs and transitions to done ---');
  const id = await enqueueJob('send_reminders', new Date(Date.now() - 60 * 1000), { marker: TEST_MARKER });
  const result = await runDueJobs(10);
  console.log(`  ran=${result.ranJobIds.length} failed=${result.failedJobIds.length}`);
  const after = await getJob(id);
  if (after?.status !== 'done') fail('due', `expected status=done, got ${after?.status}`);
  if (!after?.last_result?.startsWith('reminders_sent=')) {
    fail('due', `unexpected last_result: ${after?.last_result}`);
  }
  if (after?.lease_until !== null) fail('due', `lease should be cleared, got ${after?.lease_until}`);
  console.log(`  status=${after?.status} last_result=${after?.last_result}  ✓`);
}

async function testParallelNoDouble() {
  console.log('--- test: parallel runDueJobs calls do not double-process ---');
  const id = await enqueueJob('send_reminders', new Date(Date.now() - 60 * 1000), { marker: TEST_MARKER });
  // Fire three runs at once. Only one should claim the job; the rest report noWork.
  const results = await Promise.all([runDueJobs(10), runDueJobs(10), runDueJobs(10)]);
  const totalRan = results.reduce((acc, r) => acc + r.ranJobIds.filter((x) => x === id).length, 0);
  console.log(`  runs that claimed this job: ${totalRan}`);
  if (totalRan !== 1) fail('parallel', `expected exactly 1 claim, got ${totalRan}`);

  const after = await getJob(id);
  if (after?.status !== 'done') fail('parallel', `expected done, got ${after?.status}`);
  console.log(`  final status: ${after?.status}  ✓`);
}

async function testUnknownHandler() {
  console.log('--- test: unknown handler transitions to failed ---');
  // Enqueue with a bogus job_type by direct insert (enqueueJob has a typed param).
  const id = 'phase1-unknown-' + Math.random().toString(36).slice(2, 8);
  await db.execute({
    sql: `INSERT INTO scheduled_jobs (id, job_type, scheduled_for, status, payload_json)
          VALUES (?, 'nonexistent_handler', ?, 'pending', ?)`,
    args: [id, new Date(Date.now() - 60 * 1000).toISOString(), `{"marker":"${TEST_MARKER}"}`],
  });
  const result = await runDueJobs(10);
  console.log(`  ran=${result.ranJobIds.length} failed=${result.failedJobIds.length}`);
  const after = await getJob(id);
  if (after?.status !== 'failed') fail('unknown', `expected failed, got ${after?.status}`);
  if (!after?.last_result?.includes('no handler')) fail('unknown', `unexpected msg: ${after?.last_result}`);
  console.log(`  status=${after?.status} msg=${after?.last_result}  ✓`);
}

async function main() {
  console.log('=== Phase 1 Step 5: jobs runner test ===\n');
  await cleanup();

  try {
    await testFutureNotClaimed();
    console.log();
    await testDueJobRuns();
    console.log();
    await testParallelNoDouble();
    console.log();
    await testUnknownHandler();
  } finally {
    console.log('\n--- cleanup ---');
    await cleanup();
    const leftover = await db.execute(
      "SELECT COUNT(*) FROM scheduled_jobs WHERE payload_json LIKE ?",
      // one-arg overload with no args array
    );
    void leftover;
    const recheck = await db.execute({
      sql: "SELECT COUNT(*) FROM scheduled_jobs WHERE payload_json LIKE ?",
      args: [`%${TEST_MARKER}%`],
    });
    console.log(`  leftover test rows: ${recheck.rows[0][0]}`);
  }

  console.log();
  if (failures > 0) {
    console.error(`FAILED — ${failures} assertion(s)`);
    process.exit(1);
  }
  console.log('RUNNER TEST PASSED ✓');
}

main().catch((err) => {
  console.error('Harness error:', err);
  process.exit(1);
});
