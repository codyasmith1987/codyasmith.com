// Slice 18e — Google sync job orchestration.
//
// Owns the glue between scheduled_jobs and the production sync
// functions (syncGscForBinding / syncGa4ForBinding). The runner
// hands this module a scheduled_jobs row; we parse the payload,
// call the right sync function, and — on success — enqueue the
// next month's job so the chain is self-perpetuating.
//
// Invariant: at most ONE pending-or-running sync job per
// (binding, sync type) at any time. Enforced by ensureSyncJobQueued
// via a payload_json LIKE check keyed on binding_id. This mirrors
// the existing ensureRecurringJobsQueued pattern in runner.ts.
//
// On failure (any kind — locked period, missing config, token
// refresh fail, API error), the chain HALTS. No re-enqueue. Cody
// investigates last_result and either re-binds (which re-seeds via
// seedInitialSyncJob) or hits /sync manually.

import { nanoid } from 'nanoid';
import turso from '../turso';
import { getBindingById } from '../data-sources';
import {
  syncGscForBinding,
  syncGa4ForBinding,
  type GscSyncResult,
  type Ga4SyncResult,
} from '../google/sync';
import { realGscClient, type GscClient } from '../google/gsc';
import { realGa4Client, type Ga4Client } from '../google/ga4';

// --- Types ---

export type SyncJobType = 'sync_gsc' | 'sync_ga4';

export interface SyncJobPayload {
  binding_id: string;
  month: string;
  created_by: string;
}

interface JobLike {
  id: string;
  payload_json: string | null;
}

// --- Test seam ---
//
// Tests override these so the runner can be exercised end-to-end
// without real HTTP calls to Google. Production leaves them at
// realGscClient / realGa4Client.

let gscClientForJobs: GscClient = realGscClient;
let ga4ClientForJobs: Ga4Client = realGa4Client;

export function __setGoogleClientsForJobs(overrides: {
  gsc?: GscClient | null;
  ga4?: Ga4Client | null;
}): void {
  if (overrides.gsc !== undefined) {
    gscClientForJobs = overrides.gsc ?? realGscClient;
  }
  if (overrides.ga4 !== undefined) {
    ga4ClientForJobs = overrides.ga4 ?? realGa4Client;
  }
}

// --- Month arithmetic ---
//
// Inputs are "YYYY-MM" strings. Outputs are "YYYY-MM" strings.
// UTC-safe: we never construct a Date and extract month, because
// host timezone would corrupt the value at year boundaries.

function parseMonth(yyyymm: string): { year: number; month: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(yyyymm);
  if (!m) throw new Error(`invalid month '${yyyymm}' — expected YYYY-MM`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(`invalid month '${yyyymm}'`);
  return { year, month };
}

function formatMonth(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function nextMonth(yyyymm: string): string {
  const { year, month } = parseMonth(yyyymm);
  return month === 12 ? formatMonth(year + 1, 1) : formatMonth(year, month + 1);
}

export function previousMonth(yyyymm: string): string {
  const { year, month } = parseMonth(yyyymm);
  return month === 1 ? formatMonth(year - 1, 12) : formatMonth(year, month - 1);
}

export function currentUtcMonth(now: Date = new Date()): string {
  return formatMonth(now.getUTCFullYear(), now.getUTCMonth() + 1);
}

// Given a month you want to sync, returns the scheduled_for string:
// day 2 of the month AFTER monthToSync, at 08:00 UTC. Example:
// syncRunDateFor('2099-06') → '2099-07-02T08:00:00.000Z'. The day-2
// delay gives Google Search Console / GA4 time to finalize the
// previous month's data before we ask for it.
export function syncRunDateFor(monthToSync: string): string {
  const runMonth = nextMonth(monthToSync);
  const { year, month } = parseMonth(runMonth);
  const d = new Date(Date.UTC(year, month - 1, 2, 8, 0, 0, 0));
  return d.toISOString();
}

// --- Idempotent enqueue ---
//
// One pending/running row per (job_type, binding_id) at all times.
// Used by both the initial seed (from bind.ts) and the handler's
// re-enqueue. excludeJobId lets the handler's own currently-running
// row not block its own re-enqueue — identical trick to how
// ensureRecurringJobsQueued self-excludes in runner.ts.
export async function ensureSyncJobQueued(
  jobType: SyncJobType,
  bindingId: string,
  month: string,
  scheduledFor: string,
  createdBy: string,
  excludeJobId?: string
): Promise<boolean> {
  const existing = await turso.execute({
    sql: `SELECT id FROM scheduled_jobs
          WHERE job_type = ?
            AND status IN ('pending', 'running')
            AND payload_json LIKE ?
            AND id != ?
          LIMIT 1`,
    args: [jobType, `%"binding_id":"${bindingId}"%`, excludeJobId ?? ''],
  });
  if (existing.rows.length > 0) return false;

  const id = nanoid();
  const payload: SyncJobPayload = {
    binding_id: bindingId,
    month,
    created_by: createdBy,
  };
  await turso.execute({
    sql: `INSERT INTO scheduled_jobs
          (id, job_type, scheduled_for, status, payload_json)
          VALUES (?, ?, ?, 'pending', ?)`,
    args: [id, jobType, scheduledFor, JSON.stringify(payload)],
  });
  return true;
}

// Called by bind.ts after a binding is configured + enabled. Seeds
// the FIRST sync job for the most recently completed month so the
// admin gets immediate feedback on the next runner tick. Returns
// true if a new row was inserted, false if the binding already had
// a pending sync job.
export async function seedInitialSyncJob(
  bindingId: string,
  source: 'gsc' | 'ga4',
  createdBy: string,
  now: Date = new Date()
): Promise<boolean> {
  const jobType: SyncJobType = source === 'gsc' ? 'sync_gsc' : 'sync_ga4';
  const firstMonth = previousMonth(currentUtcMonth(now));
  const scheduledFor = now.toISOString();
  return ensureSyncJobQueued(
    jobType,
    bindingId,
    firstMonth,
    scheduledFor,
    createdBy
  );
}

// --- Payload parsing ---

function parsePayload(job: JobLike): SyncJobPayload {
  if (!job.payload_json) {
    throw new Error('payload_json is null');
  }
  const parsed = JSON.parse(job.payload_json);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('payload_json is not an object');
  }
  const bindingId = parsed.binding_id;
  const month = parsed.month;
  const createdBy = parsed.created_by ?? 'system';
  if (typeof bindingId !== 'string' || !bindingId) {
    throw new Error('payload.binding_id missing');
  }
  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) {
    throw new Error('payload.month must be YYYY-MM');
  }
  return { binding_id: bindingId, month, created_by: String(createdBy) };
}

// --- Handler bodies called from runner.ts ---

export async function runGscSyncJob(job: JobLike): Promise<string> {
  const payload = parsePayload(job);
  const result: GscSyncResult = await syncGscForBinding(
    payload.binding_id,
    payload.month,
    payload.created_by,
    gscClientForJobs
  );
  return handleSyncResult('sync_gsc', payload, result, job.id);
}

export async function runGa4SyncJob(job: JobLike): Promise<string> {
  const payload = parsePayload(job);
  const result: Ga4SyncResult = await syncGa4ForBinding(
    payload.binding_id,
    payload.month,
    payload.created_by,
    ga4ClientForJobs
  );
  return handleSyncResult('sync_ga4', payload, result, job.id);
}

async function handleSyncResult(
  jobType: SyncJobType,
  payload: SyncJobPayload,
  result: GscSyncResult | Ga4SyncResult,
  currentJobId: string
): Promise<string> {
  const label = `${jobType} binding=${payload.binding_id} month=${payload.month}`;
  if (result.status === 'applied') {
    const nextSyncMonth = nextMonth(payload.month);
    const nextScheduledFor = syncRunDateFor(nextSyncMonth);
    // Verify the binding still exists before re-enqueueing — an
    // admin could have deleted the contract between this handler
    // claiming the job and finishing it. No binding = no chain.
    const binding = await getBindingById(payload.binding_id);
    if (!binding) {
      return `${label} applied rows=${result.row_count} re_queued=0 (binding gone)`;
    }
    const reQueued = await ensureSyncJobQueued(
      jobType,
      payload.binding_id,
      nextSyncMonth,
      nextScheduledFor,
      payload.created_by,
      currentJobId
    );
    return `${label} applied rows=${result.row_count} re_queued=${reQueued ? 1 : 0}`;
  }
  const errorMsg = result.error ?? 'unknown error';
  // Failure: honest record in last_result, NO re-enqueue. Chain
  // halts until an admin re-binds (re-seeds) or hits /sync manually.
  return `${label} failed: ${errorMsg}`.slice(0, 500);
}
