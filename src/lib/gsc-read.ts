// Canonical Google Search Console read layer.
//
// Single source for reading ingested GSC data. The /portal/search
// dashboard endpoint and the monthly report generator both call these,
// so they can never drift. Extracted verbatim from the dashboard's
// previously-inline SQL (response shape unchanged). The report adds one
// read the dashboard does not need: getGscChartAll, the full daily series
// for cross-window slicing (the report compares date-range windows that do
// not align with the upload month partition).

import turso from './turso';

export interface GscDailyRow {
  date: string;
  clicks: number | null;
  impressions: number | null;
  ctr: number | null;
  position: number | null;
}

export interface GscDimRow {
  value: string;
  clicks: number | null;
  impressions: number | null;
  ctr: number | null;
  position: number | null;
}

export interface GscTotals {
  clicks: number | null;
  impressions: number | null;
  ctr: number | null;
  avg_position: number | null;
  first_date: string | null;
  last_date: string | null;
  days_covered: number;
}

export interface GscFilter {
  key: string;
  value: string | null;
}

function num(v: any): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Most recent month with any GSC data across chart or dimensions.
export async function getGscLatestMonth(clientId: string): Promise<string | null> {
  const r = await turso.execute({
    sql: `SELECT month FROM (
            SELECT month FROM gsc_chart WHERE client_id = ?
            UNION SELECT month FROM gsc_dimensions WHERE client_id = ?
          ) ORDER BY month DESC LIMIT 1`,
    args: [clientId, clientId],
  });
  return r.rows.length ? (r.rows[0][0] as string) : null;
}

// Latest month strictly before currentMonth (the prior reporting cycle), for
// the live page's "vs last month" comparison.
export async function getGscPriorMonth(clientId: string, currentMonth: string): Promise<string | null> {
  const r = await turso.execute({
    sql: `SELECT month FROM (
            SELECT month FROM gsc_chart WHERE client_id = ?
            UNION SELECT month FROM gsc_dimensions WHERE client_id = ?
          ) WHERE month < ? ORDER BY month DESC LIMIT 1`,
    args: [clientId, clientId, currentMonth],
  });
  return r.rows.length ? (r.rows[0][0] as string) : null;
}

// Totals from the chart time-series, plus the date range it covers. CTR is
// total clicks / total impressions, not the mean of daily CTRs (averaging
// percentages overweights low-volume days). Position is the mean of daily
// positions (matches the dashboard; the report uses impression-weighting
// per window via windows.ts).
export async function getGscTotals(clientId: string, month: string): Promise<GscTotals> {
  const res = await turso.execute({
    sql: `SELECT SUM(clicks) AS clicks, SUM(impressions) AS impressions,
                 AVG(position) AS avg_position, MIN(date) AS first_date,
                 MAX(date) AS last_date, COUNT(*) AS days
          FROM gsc_chart WHERE client_id = ? AND month = ?`,
    args: [clientId, month],
  });
  const row = res.rows[0];
  const clicks = num(row?.[0]);
  const impressions = num(row?.[1]);
  const ctr = clicks !== null && impressions !== null && impressions > 0 ? clicks / impressions : null;
  return {
    clicks,
    impressions,
    ctr,
    avg_position: num(row?.[2]),
    first_date: (row?.[3] as string | null) || null,
    last_date: (row?.[4] as string | null) || null,
    days_covered: num(row?.[5]) || 0,
  };
}

export async function getGscChart(clientId: string, month: string): Promise<GscDailyRow[]> {
  const res = await turso.execute({
    sql: `SELECT date, clicks, impressions, ctr, position
          FROM gsc_chart WHERE client_id = ? AND month = ? ORDER BY date ASC`,
    args: [clientId, month],
  });
  return res.rows.map(r => ({
    date: r[0] as string,
    clicks: num(r[1]),
    impressions: num(r[2]),
    ctr: num(r[3]),
    position: num(r[4]),
  }));
}

// Report-only: the full daily series across all months, for window slicing.
// Deliberately no month filter; the report window is a date range, not a
// month bucket. gsc_chart has no unique (client_id, date) constraint and
// the supersede sweep keys on month, so two exports under different month
// buckets can hold overlapping dates. Dedup to one row per date here, with
// the most recent month winning, so window aggregation never double-counts.
export async function getGscChartAll(clientId: string): Promise<GscDailyRow[]> {
  const res = await turso.execute({
    sql: `SELECT date, clicks, impressions, ctr, position
          FROM gsc_chart WHERE client_id = ? ORDER BY date ASC, month ASC`,
    args: [clientId],
  });
  // month ASC means a later month's row overwrites an earlier one's for the
  // same date, so the most recent upload wins per date.
  const byDate = new Map<string, GscDailyRow>();
  for (const r of res.rows) {
    const date = r[0] as string;
    byDate.set(date, { date, clicks: num(r[1]), impressions: num(r[2]), ctr: num(r[3]), position: num(r[4]) });
  }
  return Array.from(byDate.values()).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export async function getGscDimension(clientId: string, month: string, dimType: string, limit: number): Promise<GscDimRow[]> {
  const r = await turso.execute({
    sql: `SELECT dimension_value, clicks, impressions, ctr, position
          FROM gsc_dimensions
          WHERE client_id = ? AND month = ? AND dimension_type = ?
          ORDER BY clicks DESC NULLS LAST LIMIT ?`,
    args: [clientId, month, dimType, limit],
  });
  return r.rows.map(row => ({
    value: row[0] as string,
    clicks: num(row[1]),
    impressions: num(row[2]),
    ctr: num(row[3]),
    position: num(row[4]),
  }));
}

export async function getGscFilters(clientId: string, month: string): Promise<GscFilter[]> {
  const res = await turso.execute({
    sql: `SELECT filter_key, filter_value FROM gsc_filters WHERE client_id = ? AND month = ?`,
    args: [clientId, month],
  });
  return res.rows.map(r => ({ key: r[0] as string, value: r[1] as string | null }));
}
