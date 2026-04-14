// Phase 1 follow-up — end-to-end recurring billing test.
//
// Proves the claim "billing automation is self-perpetuating":
//
//   1. Provision a throwaway monthly contract. provisionContract
//      enqueues the first generate_invoices job.
//   2. Backdate that job's scheduled_for to 1 minute ago so the runner
//      will claim it right now.
//   3. Run runDueJobs(). Expect:
//        - The backdated job runs to 'done'.
//        - Exactly one NEW pending generate_invoices job exists for the
//          same contract, scheduled for the next billing cycle.
//   4. Run runDueJobs() AGAIN while the new job is still in the future.
//      Expect: no new jobs enqueued (idempotent).
//   5. Cleanup removes all test rows.
//
// The happy path through runDueJobs will also actually call
// generateInvoiceForContract against the test contract, which means an
// invoice + line item get created. Both are cleaned up by deleteContract
// at the end.
//
// Run: npx tsx scripts/phase1-test-billing-recurrence.ts

import 'dotenv/config';
import { createClient } from '@libsql/client';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) {
  console.error('TURSO_DATABASE_URL is not set');
  process.exit(1);
}
const db = createClient({ url, authToken });

const { provisionContract, deleteContract } = await import('../src/lib/contracts');
const { runDueJobs } = await import('../src/lib/jobs/runner');

const CLIENT_ID = 'oYLqVOgsutCEPNwb7hizm';

async function getAdminId(): Promise<string> {
  const r = await db.execute("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  return r.rows[0][0] as string;
}

async function pendingJobsForContract(contractId: string) {
  const r = await db.execute({
    sql: `SELECT id, status, scheduled_for, last_result
          FROM scheduled_jobs
          WHERE job_type = 'generate_invoices'
            AND payload_json LIKE ?
          ORDER BY scheduled_for`,
    args: [`%"contract_id":"${contractId}"%`],
  });
  return r.rows.map((row) => ({
    id: row[0] as string,
    status: row[1] as string,
    scheduled_for: row[2] as string,
    last_result: row[3] as string | null,
  }));
}

async function cleanupOrphans() {
  // Delete any previous test contracts and their downstream rows.
  const orphans = await db.execute("SELECT id FROM contracts WHERE title LIKE 'Recurrence Test%'");
  for (const r of orphans.rows) {
    const cid = r[0] as string;
    await db.execute({ sql: 'DELETE FROM pending_charges WHERE contract_id = ?', args: [cid] });
    await db.execute({
      sql: `DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE contract_id = ?)`,
      args: [cid],
    });
    await db.execute({ sql: 'DELETE FROM invoices WHERE contract_id = ?', args: [cid] });
    await db.execute({ sql: 'DELETE FROM projects WHERE contract_id = ?', args: [cid] });
    await db.execute({
      sql: 'DELETE FROM scheduled_jobs WHERE payload_json LIKE ?',
      args: [`%"contract_id":"${cid}"%`],
    });
    await db.execute({
      sql: "DELETE FROM activity_log WHERE entity_type = 'contract' AND entity_id = ?",
      args: [cid],
    });
    await db.execute({ sql: 'DELETE FROM contracts WHERE id = ?', args: [cid] });
  }
}

let failures = 0;
const fail = (label: string, msg: string) => {
  console.error(`  FAIL [${label}]: ${msg}`);
  failures++;
};

async function main() {
  console.log('=== Phase 1 follow-up: recurring billing test ===\n');

  await cleanupOrphans();

  // Record baseline row ids so the post-check can precisely detect
  // which rows are ours to delete, rather than just counting.
  const baselineJobIds = new Set<string>(
    (await db.execute('SELECT id FROM scheduled_jobs')).rows.map((r) => r[0] as string)
  );
  const baseline = {
    contracts: Number((await db.execute('SELECT COUNT(*) FROM contracts')).rows[0][0]),
    scheduled: baselineJobIds.size,
    invoices: Number((await db.execute('SELECT COUNT(*) FROM invoices')).rows[0][0]),
  };
  console.log('baseline:', baseline, '\n');

  const adminId = await getAdminId();
  const result = await provisionContract({
    client_id: CLIENT_ID,
    title: `Recurrence Test ${Date.now()}`,
    type: 'retainer',
    billing_cadence: 'monthly',
    billing_day: 1,
    recurring_amount: 300,
    created_by: adminId,
  });
  const contractId = result.contract_id;
  console.log(`provisioned contract: ${contractId}`);
  console.log(`initial scheduled_job_id: ${result.scheduled_job_id}\n`);

  try {
    // Activate the contract so generateInvoiceForContract will proceed.
    await db.execute({
      sql: "UPDATE contracts SET status = 'active' WHERE id = ?",
      args: [contractId],
    });

    // Step 1: verify exactly one pending job right after provisioning.
    let jobs = await pendingJobsForContract(contractId);
    console.log(`after provisioning: ${jobs.length} job(s)`);
    if (jobs.length !== 1) fail('provision', `expected 1 pending, got ${jobs.length}`);
    if (jobs[0]?.status !== 'pending') fail('provision', `job status=${jobs[0]?.status}`);

    // Step 2: backdate the initial job so runDueJobs picks it up now.
    await db.execute({
      sql: "UPDATE scheduled_jobs SET scheduled_for = datetime('now', '-1 minute') WHERE id = ?",
      args: [jobs[0].id],
    });
    const firstJobId = jobs[0].id;

    // Step 3: run the runner. The backdated job should fire, generate an
    // invoice, transition to 'done', AND enqueue the next cycle.
    console.log('\n--- runDueJobs() pass 1 ---');
    const run1 = await runDueJobs(10);
    console.log(`ran=${run1.ranJobIds.length} failed=${run1.failedJobIds.length}`);

    jobs = await pendingJobsForContract(contractId);
    console.log(`after pass 1: ${jobs.length} job(s) total`);
    for (const j of jobs) {
      console.log(`  ${j.id}  status=${j.status}  for=${j.scheduled_for}  last=${j.last_result ?? '-'}`);
    }

    const firstJob = jobs.find((j) => j.id === firstJobId);
    if (firstJob?.status !== 'done') fail('run1', `first job status=${firstJob?.status}`);
    if (!firstJob?.last_result?.includes('re_queued=')) {
      fail('run1', `last_result missing re_queued: ${firstJob?.last_result}`);
    }

    const pending = jobs.filter((j) => j.status === 'pending');
    if (pending.length !== 1) fail('run1', `expected 1 new pending job, got ${pending.length}`);
    if (pending[0]?.id === firstJobId) fail('run1', `new pending job reused old id`);

    // The re-enqueued job should be scheduled for the next UTC billing_day=1,
    // which is the first of the following month from now. Since today is
    // after the 1st (day 13+ in April 2026 based on our test data), the
    // next run is May 1.
    const nextRun = new Date(pending[0].scheduled_for);
    const now = new Date();
    if (nextRun.getTime() <= now.getTime()) {
      fail('run1', `re-enqueued job not in the future: ${pending[0].scheduled_for}`);
    }
    console.log(`re-enqueued for: ${pending[0].scheduled_for}`);

    // Step 4: run runDueJobs() again. The new job is in the future so
    // nothing should happen, and no duplicate should be created.
    console.log('\n--- runDueJobs() pass 2 (idempotency check) ---');
    const run2 = await runDueJobs(10);
    console.log(`ran=${run2.ranJobIds.length} failed=${run2.failedJobIds.length}`);

    jobs = await pendingJobsForContract(contractId);
    const stillPending = jobs.filter((j) => j.status === 'pending');
    if (stillPending.length !== 1) fail('run2', `pending count changed: ${stillPending.length}`);
    if (run2.ranJobIds.length !== 0) fail('run2', `unexpected runs: ${run2.ranJobIds.length}`);
    console.log(`pending jobs unchanged: ${stillPending.length}  ✓`);

    // Verify an invoice was actually generated.
    const inv = await db.execute({
      sql: 'SELECT COUNT(*), SUM(total) FROM invoices WHERE contract_id = ?',
      args: [contractId],
    });
    const invCount = Number(inv.rows[0][0]);
    const invTotal = Number(inv.rows[0][1] ?? 0);
    console.log(`\ninvoices for test contract: count=${invCount} total=${invTotal}`);
    if (invCount !== 1) fail('invoice', `expected 1 invoice, got ${invCount}`);
    if (invTotal !== 300) fail('invoice', `expected total=300, got ${invTotal}`);
  } finally {
    console.log('\n--- cleanup ---');
    try {
      await deleteContract(contractId);
    } catch (err: any) {
      console.error(`  deleteContract failed: ${err?.message ?? err}`);
    }
    // scheduled_jobs not cascaded by deleteContract. Delete every job
    // id that is NOT in the baseline set — this catches both the test
    // contract's jobs and any side-effect jobs (e.g., KipKit's newly
    // seeded job, which we DO want to remove so the test leaves no
    // trace in prod scheduled_jobs).
    const allJobs = (await db.execute('SELECT id FROM scheduled_jobs')).rows.map((r) => r[0] as string);
    const newIds = allJobs.filter((id) => !baselineJobIds.has(id));
    for (const id of newIds) {
      await db.execute({ sql: 'DELETE FROM scheduled_jobs WHERE id = ?', args: [id] });
    }
    console.log(`  deleted ${newIds.length} new scheduled_jobs rows`);

    await db.execute({
      sql: "DELETE FROM activity_log WHERE entity_type = 'contract' AND entity_id = ?",
      args: [contractId],
    });

    const post = {
      contracts: Number((await db.execute('SELECT COUNT(*) FROM contracts')).rows[0][0]),
      scheduled: Number((await db.execute('SELECT COUNT(*) FROM scheduled_jobs')).rows[0][0]),
      invoices: Number((await db.execute('SELECT COUNT(*) FROM invoices')).rows[0][0]),
    };
    for (const k of ['contracts', 'scheduled', 'invoices'] as const) {
      const delta = post[k] - baseline[k];
      const mark = delta === 0 ? '✓' : `DRIFT ${delta > 0 ? '+' : ''}${delta}`;
      console.log(`  ${k.padEnd(12)} ${post[k]}  ${mark}`);
      if (delta !== 0) failures++;
    }
  }

  console.log();
  if (failures > 0) {
    console.error(`FAILED — ${failures} assertion(s)`);
    process.exit(1);
  }
  console.log('RECURRING BILLING TEST PASSED ✓');
}

main().catch((err) => {
  console.error('Harness error:', err);
  process.exit(1);
});
