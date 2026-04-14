// Traffic metric naming convention + typed read helper.
//
// This file is the single source of truth for what "traffic" rows
// look like in metric_snapshots. Any writer (GA4 sync today, GA/GSC
// hybrid tomorrow) MUST use these constants, and any reader MUST
// hit getTrafficMetricsForPeriod. That way the convention stays
// discoverable from one place and can't silently drift.
//
// Convention rules (permanent):
//   - category values are lowercase English nouns scoped to the
//     domain: 'traffic', 'crawl', 'content', 'performance', ...
//   - metric_key values are lowercase snake_case plain English,
//     never raw API names. 'screenPageViews' becomes 'page_views'.
//   - source identifies the origin ('ga4', 'gsc',
//     'position_tracking', 'crawl_overview', ...). Because the
//     metric_snapshots UNIQUE doesn't include source, one source
//     must own each (category, metric_key) pair. 'traffic.sessions'
//     is owned by 'ga4' and nothing else writes it.

import turso from './turso';

export type TrafficMetricKey =
  | 'sessions'
  | 'users'
  | 'page_views'
  | 'engaged_sessions'
  | 'engagement_rate';

export const TRAFFIC_METRIC_KEYS: readonly TrafficMetricKey[] = [
  'sessions',
  'users',
  'page_views',
  'engaged_sessions',
  'engagement_rate',
] as const;

export const TRAFFIC_CATEGORY = 'traffic';
export const TRAFFIC_SOURCE_GA4 = 'ga4';

export interface TrafficMetrics {
  sessions: number;
  users: number;
  page_views: number;
  engaged_sessions: number;
  engagement_rate: number;
}

// Returns the traffic metrics for a single (client, period) pair,
// pulled from metric_snapshots where category='traffic' regardless
// of source (in practice only 'ga4' writes this category today).
// Returns null if no rows exist — the absence is the signal that
// GA4 isn't connected or hasn't been synced for this period.
export async function getTrafficMetricsForPeriod(
  clientId: string,
  periodId: string
): Promise<TrafficMetrics | null> {
  const r = await turso.execute({
    sql: `SELECT metric_key, metric_value
          FROM metric_snapshots
          WHERE client_id = ? AND period_id = ? AND category = ?`,
    args: [clientId, periodId, TRAFFIC_CATEGORY],
  });
  if (r.rows.length === 0) return null;
  const map = new Map<string, number>();
  for (const row of r.rows) {
    map.set(row[0] as string, Number(row[1] ?? 0));
  }
  // If at least one expected key is missing, treat as incomplete
  // data and return null so the UI can render the "no data" path
  // rather than a partial strip with zeros.
  for (const k of TRAFFIC_METRIC_KEYS) {
    if (!map.has(k)) return null;
  }
  return {
    sessions: map.get('sessions')!,
    users: map.get('users')!,
    page_views: map.get('page_views')!,
    engaged_sessions: map.get('engaged_sessions')!,
    engagement_rate: map.get('engagement_rate')!,
  };
}

// Resolves the most recent period for a client that actually has
// traffic metrics. Used by the dashboard when Cody hasn't pinned a
// specific period — we render the latest available.
export async function getLatestTrafficPeriodId(
  clientId: string
): Promise<string | null> {
  const r = await turso.execute({
    sql: `SELECT DISTINCT period_id FROM metric_snapshots
          WHERE client_id = ? AND category = ?
          ORDER BY period_id DESC
          LIMIT 1`,
    args: [clientId, TRAFFIC_CATEGORY],
  });
  if (r.rows.length === 0) return null;
  return r.rows[0][0] as string;
}

// Shared two-period compare. Used by both buildTrafficSummary
// (Slice 18c) and the narrator's traffic fact builder (Slice 18d)
// so the 5% threshold, the driver-selection order, and the divide-
// by-zero guards live in exactly one place.
//
// Driver selection order:
//   sessions first → users → page_views.
// The driver's count delta is what Slice 18d feeds into the
// narrator's Fact.magnitude so raw-count comparison across kinds
// stays honest (visits are a raw-count signal the same way top3
// keyword changes are).

export const TRAFFIC_MEANINGFUL_PCT = 5;

export type TrafficDirection = 'up' | 'down' | 'flat';
export type TrafficDriver = 'sessions' | 'users' | 'page_views';

export interface TrafficCompare {
  current: TrafficMetrics;
  prior: TrafficMetrics;
  sessions_delta: number;
  users_delta: number;
  page_views_delta: number;
  sessions_pct: number | null;
  users_pct: number | null;
  page_views_pct: number | null;
  sessions_flat: boolean;
  users_flat: boolean;
  page_views_flat: boolean;
  direction: TrafficDirection;
  // Null when no metric moved meaningfully. Otherwise the metric
  // that chose the direction, and its signed count delta.
  driver: TrafficDriver | null;
  driver_delta: number; // 0 when driver is null
  driver_pct: number | null;
}

function pctOf(delta: number, priorValue: number): number | null {
  if (priorValue <= 0) return null;
  return (delta / priorValue) * 100;
}

function isFlat(pct: number | null): boolean {
  return pct === null || Math.abs(pct) < TRAFFIC_MEANINGFUL_PCT;
}

export function compareTraffic(
  current: TrafficMetrics,
  prior: TrafficMetrics
): TrafficCompare {
  const sessions_delta = current.sessions - prior.sessions;
  const users_delta = current.users - prior.users;
  const page_views_delta = current.page_views - prior.page_views;

  const sessions_pct = pctOf(sessions_delta, prior.sessions);
  const users_pct = pctOf(users_delta, prior.users);
  const page_views_pct = pctOf(page_views_delta, prior.page_views);

  const sessions_flat = isFlat(sessions_pct);
  const users_flat = isFlat(users_pct);
  const page_views_flat = isFlat(page_views_pct);

  let direction: TrafficDirection;
  let driver: TrafficDriver | null;
  let driver_delta = 0;
  let driver_pct: number | null = null;

  if (sessions_flat && users_flat && page_views_flat) {
    direction = 'flat';
    driver = null;
  } else if (!sessions_flat) {
    direction = sessions_delta > 0 ? 'up' : 'down';
    driver = 'sessions';
    driver_delta = sessions_delta;
    driver_pct = sessions_pct;
  } else if (!users_flat) {
    direction = users_delta > 0 ? 'up' : 'down';
    driver = 'users';
    driver_delta = users_delta;
    driver_pct = users_pct;
  } else {
    // page_views is meaningful; the other two are flat
    direction = page_views_delta > 0 ? 'up' : 'down';
    driver = 'page_views';
    driver_delta = page_views_delta;
    driver_pct = page_views_pct;
  }

  return {
    current,
    prior,
    sessions_delta,
    users_delta,
    page_views_delta,
    sessions_pct,
    users_pct,
    page_views_pct,
    sessions_flat,
    users_flat,
    page_views_flat,
    direction,
    driver,
    driver_delta,
    driver_pct,
  };
}
