// Phase 1 Step 5 — scheduled jobs runner.
//
// Single entry point for any code path that needs to advance scheduled
// work. Wakes pending-and-due jobs one at a time under an optimistic
// lease so multiple runners can't double-process the same row.
//
// Job handlers: add an entry to the `handlers` map. Each handler
// receives the scheduled_jobs row and returns a short result string
// that gets persisted in `last_result`.
//
// Re-enqueueing: recurring jobs (e.g. daily invoice generation) should
// call `enqueueJob` again with the next scheduled_for before returning.
// The runner doesn't infer schedules on its own.

import { nanoid } from 'nanoid';
import turso from '../turso';
import { logger } from '../logger';
import { generateRecurringInvoices, sendDueReminders } from '../billing';
import { getAllContracts, nextBillingRunIso } from '../contracts';

// --- Types ---

export type JobType = 'generate_invoices' | 'send_reminders' | 'cleanup_stale_imports';

interface JobRow {
  id: string;
  job_type: JobType;
  scheduled_for: string;
  lease_until: string | null;
  status: string;
  last_run_at: string | null;
  last_result: string | null;
  payload_json: string | null;
  created_at: string;
}

// --- Helpers ---

const LEASE_DURATION_MS = 5 * 60 * 1000; // 5 minutes

function nowIso(): string {
  return new Date().toISOString();
}
function plusMs(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

// --- Enqueue ---

export async function enqueueJob(
  jobType: JobType,
  scheduledFor: Date | string = new Date(),
  payload?: Record<string, unknown>
): Promise<string> {
  const id = nanoid();
  const iso = typeof scheduledFor === 'string' ? scheduledFor : scheduledFor.toISOString();
  await turso.execute({
    sql: `INSERT INTO scheduled_jobs
          (id, job_type, scheduled_for, status, payload_json)
          VALUES (?, ?, ?, 'pending', ?)`,
    args: [id, jobType, iso, payload ? JSON.stringify(payload) : null],
  });
  return id;
}

// --- Claim ---

// Attempts to claim the next pending-and-due job atomically.
// Returns the job row or null if nothing eligible exists.
async function claimNextJob(): Promise<JobRow | null> {
  const nowStr = nowIso();
  // Find a candidate that is pending OR whose lease has expired.
  const candidate = await turso.execute({
    sql: `SELECT id, job_type, scheduled_for, lease_until, status,
                 last_run_at, last_result, payload_json, created_at
          FROM scheduled_jobs
          WHERE scheduled_for <= ?
            AND (
              status = 'pending'
              OR (status = 'running' AND (lease_until IS NULL OR lease_until < ?))
            )
          ORDER BY scheduled_for ASC
          LIMIT 1`,
    args: [nowStr, nowStr],
  });
  if (candidate.rows.length === 0) return null;
  const r = candidate.rows[0];
  const row: JobRow = {
    id: r[0] as string,
    job_type: r[1] as JobType,
    scheduled_for: r[2] as string,
    lease_until: r[3] as string | null,
    status: r[4] as string,
    last_run_at: r[5] as string | null,
    last_result: r[6] as string | null,
    payload_json: r[7] as string | null,
    created_at: r[8] as string,
  };

  // Optimistic lease: UPDATE with a WHERE clause that matches the exact
  // prior state. If another runner grabbed it first, rowsAffected will be
  // 0 and we bail.
  const leaseUntil = plusMs(LEASE_DURATION_MS);
  const update = await turso.execute({
    sql: `UPDATE scheduled_jobs
          SET status = 'running', lease_until = ?
          WHERE id = ?
            AND (
              (status = 'pending')
              OR (status = 'running' AND (lease_until IS NULL OR lease_until < ?))
            )`,
    args: [leaseUntil, row.id, nowStr],
  });
  if (Number((update as any).rowsAffected ?? 0) === 0) return null;
  row.status = 'running';
  row.lease_until = leaseUntil;
  return row;
}

// --- Handlers ---

type Handler = (job: JobRow, runId: string) => Promise<string>;

// Ensures every active monthly contract has a pending generate_invoices
// job queued for its next billing cycle. Idempotent: a contract that
// already has a pending OR running job (other than the caller's own,
// via excludeJobId) is skipped.
//
// Called from the generate_invoices handler. Passing the caller's own
// job.id in excludeJobId is critical: without it, the currently-running
// job for contract X would match the idempotency query and block X from
// ever getting its next cycle queued — billing would halt after one run.
//
// Runs at the end of every generate_invoices handler invocation so
// billing automation is self-perpetuating — each successful run replenishes
// the next one.
async function ensureRecurringJobsQueued(
  createdBy: string,
  excludeJobId?: string
): Promise<number> {
  const contracts = await getAllContracts();
  let enqueued = 0;
  for (const contract of contracts) {
    if (
      contract.status !== 'active' ||
      contract.billing_cadence !== 'monthly' ||
      !contract.billing_day ||
      !contract.recurring_amount
    ) {
      continue;
    }
    // Is there already a pending/running generate_invoices job tied to
    // this contract OTHER than the one currently running this check?
    // We key on payload_json containing the contract_id — cheap LIKE match
    // against a short JSON blob written at enqueue time.
    const existing = await turso.execute({
      sql: `SELECT id FROM scheduled_jobs
            WHERE job_type = 'generate_invoices'
              AND status IN ('pending', 'running')
              AND payload_json LIKE ?
              AND id != ?
            LIMIT 1`,
      args: [`%"contract_id":"${contract.id}"%`, excludeJobId ?? ''],
    });
    if (existing.rows.length > 0) continue;

    const scheduledFor = nextBillingRunIso(contract.billing_day);
    const jobId = nanoid();
    await turso.execute({
      sql: `INSERT INTO scheduled_jobs
            (id, job_type, scheduled_for, status, payload_json)
            VALUES (?, 'generate_invoices', ?, 'pending', ?)`,
      args: [
        jobId,
        scheduledFor,
        JSON.stringify({ created_by: createdBy, contract_id: contract.id }),
      ],
    });
    enqueued++;
  }
  return enqueued;
}

// Idempotent re-enqueue for the stale-imports sweep. Runs once an hour.
// Excludes the currently-running job so self-replacement works.
async function ensureStaleSweepQueued(excludeJobId?: string): Promise<boolean> {
  const existing = await turso.execute({
    sql: `SELECT id FROM scheduled_jobs
          WHERE job_type = 'cleanup_stale_imports'
            AND status IN ('pending', 'running')
            AND id != ?
          LIMIT 1`,
    args: [excludeJobId ?? ''],
  });
  if (existing.rows.length > 0) return false;
  const next = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await turso.execute({
    sql: `INSERT INTO scheduled_jobs
          (id, job_type, scheduled_for, status, payload_json)
          VALUES (?, 'cleanup_stale_imports', ?, 'pending', '{}')`,
    args: [nanoid(), next],
  });
  return true;
}

const handlers: Record<JobType, Handler> = {
  async generate_invoices(job): Promise<string> {
    // payload: { created_by?: string, contract_id?: string }.
    const payload = job.payload_json ? JSON.parse(job.payload_json) : {};
    const createdBy = payload.created_by ?? 'system';
    const result = await generateRecurringInvoices(createdBy);
    // After generating, ensure every active monthly contract has a job
    // queued for its next cycle — including the one currently running,
    // which we exclude from the idempotency check via job.id.
    const reQueued = await ensureRecurringJobsQueued(createdBy, job.id);
    return `generated=${result.generated.length} skipped=${result.skipped.length} re_queued=${reQueued}`;
  },
  async send_reminders(): Promise<string> {
    const sent = await sendDueReminders();
    return `reminders_sent=${sent}`;
  },
  // Auto-recovery for crashed ingestions. A pending import row older
  // than 60 minutes means an earlier call to ingestCSVViaSnapshots
  // inserted the row with status='pending' but never reached the
  // transactional write that would mark it 'applied' or 'failed'.
  // The content_hash sits poisoned. This sweep marks those rows failed
  // with a clear error so Cody can re-upload the same file.
  async cleanup_stale_imports(job): Promise<string> {
    const result = await turso.execute({
      sql: `UPDATE imports
            SET status = 'failed',
                error = COALESCE(error, 'Timed out: ingestion never completed (auto-recovered by stale-imports sweep)'),
                finished_at = datetime('now')
            WHERE status = 'pending'
              AND started_at < datetime('now', '-60 minutes')`,
    });
    const swept = Number((result as any).rowsAffected ?? 0);
    const reQueued = await ensureStaleSweepQueued(job.id);
    return `swept=${swept} re_queued=${reQueued ? 1 : 0}`;
  },
};

// --- Run due jobs ---

export interface RunResult {
  ranJobIds: string[];
  failedJobIds: string[];
  noWork: boolean;
}

export async function runDueJobs(maxJobs = 10): Promise<RunResult> {
  const ranJobIds: string[] = [];
  const failedJobIds: string[] = [];

  for (let i = 0; i < maxJobs; i++) {
    const job = await claimNextJob();
    if (!job) {
      return { ranJobIds, failedJobIds, noWork: ranJobIds.length === 0 && failedJobIds.length === 0 };
    }
    const runId = nanoid(8);
    const handler = handlers[job.job_type];
    if (!handler) {
      await turso.execute({
        sql: `UPDATE scheduled_jobs
              SET status = 'failed', last_run_at = ?, last_result = ?, lease_until = NULL
              WHERE id = ?`,
        args: [nowIso(), `no handler for job_type=${job.job_type}`, job.id],
      });
      failedJobIds.push(job.id);
      continue;
    }
    try {
      const result = await handler(job, runId);
      await turso.execute({
        sql: `UPDATE scheduled_jobs
              SET status = 'done', last_run_at = ?, last_result = ?, lease_until = NULL
              WHERE id = ?`,
        args: [nowIso(), result, job.id],
      });
      ranJobIds.push(job.id);
      logger.info(`[jobs] ${job.job_type} ${job.id} done: ${result}`);
    } catch (err: any) {
      const msg = String(err?.message ?? err).slice(0, 500);
      await turso.execute({
        sql: `UPDATE scheduled_jobs
              SET status = 'failed', last_run_at = ?, last_result = ?, lease_until = NULL
              WHERE id = ?`,
        args: [nowIso(), `error: ${msg}`, job.id],
      });
      failedJobIds.push(job.id);
      logger.error(`[jobs] ${job.job_type} ${job.id} failed`, err);
    }
  }

  return { ranJobIds, failedJobIds, noWork: false };
}
