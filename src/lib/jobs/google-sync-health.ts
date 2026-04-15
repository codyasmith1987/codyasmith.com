// Slice 18f — Google data-source health detector.
//
// Computes one admin-queue section that surfaces every enabled
// gsc/ga4 data_source_bindings row that needs attention. Reads
// real binding + scheduled_jobs state — no heuristics, no fake
// health scoring. A binding either has a live chain (pending or
// running sync job) or it doesn't; if it doesn't, this module
// asks why and classifies the reason into one of four states.
//
// Priority order (highest-priority match wins; one row per binding):
//
//   1. misconfigured   — config_json missing or missing keys
//   2. failed_halted   — a prior sync attempted and failed, no retry queued
//   3. never_synced    — bound but no job history at all, no retry queued
//   4. stale           — last_seen_at older than threshold, no retry queued
//
// A binding with ANY pending/running sync_gsc or sync_ga4 job in
// scheduled_jobs is considered healthy — the chain is alive — and
// does not surface regardless of last_seen_at. Disabled bindings
// (enabled = 0) never surface: admin is explicitly opting out.

import turso from '../turso';
import type { QueueSection, QueueRow } from '../admin-queue';

// Cadence is monthly; the chain's natural gap between last_seen_at
// stamps is ~30-31 days. 45 gives a 14-day cushion — enough to
// absorb one late runner tick, not enough to hide a full missed
// month. Dial in one place.
export const GOOGLE_STALE_THRESHOLD_DAYS = 45;

export type BindingHealthReason =
  | 'misconfigured'
  | 'failed_halted'
  | 'never_synced'
  | 'stale';

interface BindingRow {
  id: string;
  client_id: string;
  contract_id: string;
  source: 'gsc' | 'ga4';
  config_json: string | null;
  last_seen_at: string | null;
  client_name: string;
  contract_title: string;
}

interface LatestFailedJob {
  last_result: string | null;
}

function parseConfig(
  configJson: string | null
): { connection_id: string; property: string } | null {
  if (!configJson) return null;
  try {
    const p = JSON.parse(configJson);
    if (!p || typeof p !== 'object') return null;
    const cid = p.connection_id;
    const prop = p.property;
    if (typeof cid !== 'string' || !cid) return null;
    if (typeof prop !== 'string' || !prop) return null;
    return { connection_id: cid, property: prop };
  } catch {
    return null;
  }
}

async function hasActiveSyncJob(bindingId: string): Promise<boolean> {
  const r = await turso.execute({
    sql: `SELECT id FROM scheduled_jobs
          WHERE (job_type = 'sync_gsc' OR job_type = 'sync_ga4')
            AND status IN ('pending', 'running')
            AND payload_json LIKE ?
          LIMIT 1`,
    args: [`%"binding_id":"${bindingId}"%`],
  });
  return r.rows.length > 0;
}

// Returns the most recent done/failed sync job for this binding
// whose last_result has the honest-failure shape written by
// handleSyncResult in google-sync-jobs.ts. If no such row exists,
// returns null.
async function latestFailedSyncJob(
  bindingId: string
): Promise<LatestFailedJob | null> {
  const r = await turso.execute({
    sql: `SELECT last_result FROM scheduled_jobs
          WHERE (job_type = 'sync_gsc' OR job_type = 'sync_ga4')
            AND status IN ('done', 'failed')
            AND payload_json LIKE ?
            AND last_result LIKE '% failed:%'
          ORDER BY COALESCE(last_run_at, scheduled_for) DESC
          LIMIT 1`,
    args: [`%"binding_id":"${bindingId}"%`],
  });
  if (r.rows.length === 0) return null;
  return { last_result: r.rows[0][0] as string | null };
}

function daysBetween(now: number, iso: string): number {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return Number.POSITIVE_INFINITY;
  return Math.floor((now - then) / 86400000);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

// Extracts the "failed: <msg>" tail from a handleSyncResult string
// of the form "sync_gsc binding=X month=Y failed: <real error>".
function extractFailureTail(lastResult: string | null): string {
  if (!lastResult) return 'unknown error';
  const idx = lastResult.indexOf(' failed:');
  if (idx < 0) return lastResult;
  return lastResult.slice(idx + 1); // keep "failed: ..." intact
}

// Classifies one binding. Returns null if the binding is healthy
// (either has an active sync job, or is within the freshness window
// and has no failure-shape history). Returns a QueueRow otherwise.
async function classifyBinding(
  b: BindingRow,
  now: number
): Promise<QueueRow | null> {
  const config = parseConfig(b.config_json);

  // 1. misconfigured — highest priority. Can't even decide the
  // other states without valid config.
  if (!config) {
    return {
      id: b.id,
      what: `${b.source} binding is not configured`,
      where: `${b.client_name} · ${b.contract_title}`,
      why:
        'enabled but has no connection_id + property — the bind step was never completed',
      action: 'bind the connection + property on /portal/admin/google',
      link: '/portal/admin/google',
      meta: 'last sync: never',
    };
  }

  // Healthy check: a live pending/running sync job means the chain
  // is alive regardless of last_seen_at.
  if (await hasActiveSyncJob(b.id)) return null;

  // 2. failed_halted — a prior attempt failed AND no retry is queued.
  const failed = await latestFailedSyncJob(b.id);
  if (failed) {
    const tail = truncate(extractFailureTail(failed.last_result), 140);
    return {
      id: b.id,
      what: `${b.source} chain halted after a sync failure`,
      where: `${b.client_name} · ${b.contract_title}`,
      why: `last attempt ${tail} — nothing queued to retry`,
      action: "hit 'sync now' on /portal/admin/google to restart the chain",
      link: '/portal/admin/google',
      meta: `last sync: ${b.last_seen_at ?? 'never'}`,
    };
  }

  // 3. never_synced — bound, no job history, nothing queued.
  if (!b.last_seen_at) {
    return {
      id: b.id,
      what: `${b.source} binding has never synced`,
      where: `${b.client_name} · ${b.contract_title}`,
      why:
        'bound but no scheduled sync job exists — seedInitialSyncJob may not have fired',
      action:
        "wait for the next runner tick, or hit 'sync now' on /portal/admin/google",
      link: '/portal/admin/google',
      meta: 'last sync: never',
    };
  }

  // 4. stale — last_seen_at old, no retry queued.
  const days = daysBetween(now, b.last_seen_at);
  if (days >= GOOGLE_STALE_THRESHOLD_DAYS) {
    return {
      id: b.id,
      what: `${b.source} binding is stale`,
      where: `${b.client_name} · ${b.contract_title}`,
      why: `last sync was ${days} days ago and nothing is queued to advance the chain`,
      action: "hit 'sync now' on /portal/admin/google to restart the chain",
      link: '/portal/admin/google',
      meta: `last sync: ${b.last_seen_at}`,
    };
  }

  // Healthy: within window, no failure, no gap.
  return null;
}

export async function loadGoogleSyncAttentionSection(): Promise<QueueSection> {
  const now = Date.now();
  const rowsRaw = await turso.execute({
    sql: `SELECT dsb.id, dsb.client_id, dsb.contract_id, dsb.source,
                 dsb.config_json, dsb.last_seen_at,
                 c.name AS client_name, co.title AS contract_title
          FROM data_source_bindings dsb
          JOIN clients c ON c.id = dsb.client_id
          JOIN contracts co ON co.id = dsb.contract_id
          WHERE dsb.source IN ('gsc', 'ga4')
            AND dsb.enabled = 1
          ORDER BY c.name, co.title, dsb.source`,
  });
  const bindings: BindingRow[] = rowsRaw.rows.map((r) => ({
    id: r[0] as string,
    client_id: r[1] as string,
    contract_id: r[2] as string,
    source: r[3] as 'gsc' | 'ga4',
    config_json: (r[4] as string | null) ?? null,
    last_seen_at: (r[5] as string | null) ?? null,
    client_name: r[6] as string,
    contract_title: r[7] as string,
  }));

  const rows: QueueRow[] = [];
  for (const b of bindings) {
    const row = await classifyBinding(b, now);
    if (row) rows.push(row);
  }

  return {
    key: 'google_sync_attention',
    label: 'Google data sources needing attention',
    count: rows.length,
    rows,
  };
}
