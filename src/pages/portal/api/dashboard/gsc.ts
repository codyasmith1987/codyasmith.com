// Google Search Console dashboard data endpoint.
//
// Aggregates the latest month's GSC data into the shape /portal/search
// renders. Returns null sections when the matching CSV hasn't been
// uploaded yet so the UI can show "no data for this category" without
// erroring.
//
// "Latest month" is the most recent month with any GSC row across any
// of the three GSC tables. Totals come from gsc_chart (which is the
// time-series ground truth — gsc_dimensions has per-page or per-query
// rows, and summing those would double-count if a query appears on
// multiple pages).

import type { APIRoute } from 'astro';
import turso from '../../../../lib/turso';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

function num(v: any): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export const GET: APIRoute = async ({ locals, url }) => {
  if (!locals.user) return json({ error: 'Unauthorized' }, 401);

  const clientId = locals.user.role === 'admin'
    ? (url.searchParams.get('client_id') || null)
    : locals.user.client_id;
  if (!clientId) return json({ error: 'No client specified' }, 400);

  // Most recent month with any GSC data.
  const monthResult = await turso.execute({
    sql: `SELECT month FROM (
            SELECT month FROM gsc_chart WHERE client_id = ?
            UNION SELECT month FROM gsc_dimensions WHERE client_id = ?
          ) ORDER BY month DESC LIMIT 1`,
    args: [clientId, clientId],
  });
  if (monthResult.rows.length === 0) {
    return json({ month: null, has_data: false });
  }
  const month = monthResult.rows[0][0] as string;

  // Totals from the chart time-series, plus the date range it covers.
  // Position is averaged (mean of daily positions); the others sum.
  // SQLite returns NULL for empty sets so num() collapses gracefully.
  const totalsRes = await turso.execute({
    sql: `SELECT
            SUM(clicks)       AS clicks,
            SUM(impressions)  AS impressions,
            AVG(position)     AS avg_position,
            MIN(date)         AS first_date,
            MAX(date)         AS last_date,
            COUNT(*)          AS days
          FROM gsc_chart
          WHERE client_id = ? AND month = ?`,
    args: [clientId, month],
  });
  const tRow = totalsRes.rows[0];
  const totalClicks = num(tRow?.[0]);
  const totalImpressions = num(tRow?.[1]);
  const avgPosition = num(tRow?.[2]);
  const firstDate = (tRow?.[3] as string | null) || null;
  const lastDate = (tRow?.[4] as string | null) || null;
  const daysCovered = num(tRow?.[5]) || 0;
  // CTR is total_clicks / total_impressions, not the average of
  // daily CTRs (averaging percentages overweights low-volume days).
  const overallCtr = (totalClicks !== null && totalImpressions !== null && totalImpressions > 0)
    ? totalClicks / totalImpressions
    : null;

  // Chart series for the trend graph. Returns one row per day.
  const chartRes = await turso.execute({
    sql: `SELECT date, clicks, impressions, ctr, position
          FROM gsc_chart
          WHERE client_id = ? AND month = ?
          ORDER BY date ASC`,
    args: [clientId, month],
  });
  const chart = chartRes.rows.map(r => ({
    date: r[0] as string,
    clicks: num(r[1]),
    impressions: num(r[2]),
    ctr: num(r[3]),
    position: num(r[4]),
  }));

  // Helper for fetching one dimension breakdown.
  async function dimensionRows(dimType: string, limit: number) {
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

  const [queries, pages, countries, devices, searchAppearance] = await Promise.all([
    dimensionRows('query', 25),
    dimensionRows('page', 25),
    dimensionRows('country', 15),
    dimensionRows('device', 10),
    dimensionRows('search_appearance', 10),
  ]);

  // Filters metadata (Search type, Date range) for the dashboard
  // subtitle: "Last 6 months, web search."
  const filtersRes = await turso.execute({
    sql: `SELECT filter_key, filter_value FROM gsc_filters
          WHERE client_id = ? AND month = ?`,
    args: [clientId, month],
  });
  const filters = filtersRes.rows.map(r => ({
    key: r[0] as string,
    value: r[1] as string | null,
  }));

  return json({
    month,
    has_data: true,
    totals: {
      clicks: totalClicks,
      impressions: totalImpressions,
      ctr: overallCtr,
      avg_position: avgPosition,
      first_date: firstDate,
      last_date: lastDate,
      days_covered: daysCovered,
    },
    chart,
    queries,
    pages,
    countries,
    devices,
    search_appearance: searchAppearance,
    filters,
  });
};
