// Cloudflare dashboard data endpoint for /portal/security.
//
// Aggregates the latest synced window of CF data into the shape
// the page renders. Returns one set per managed site so the page
// can show ZKH and MVP side by side if both have CF configured,
// or just one site for single-site clients.

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

  // All client_sites with any CF data, or with a CF zone configured
  // but never synced. The page can show "configured but not yet
  // synced" for the latter.
  const sitesRes = await turso.execute({
    sql: `SELECT id, domain, cloudflare_zone_id, cloudflare_last_synced_at
          FROM client_sites
          WHERE client_id = ?
            AND (cloudflare_zone_id IS NOT NULL OR id IN (
              SELECT DISTINCT site_id FROM cloudflare_traffic_daily WHERE client_id = ?
            ))
          ORDER BY is_primary DESC, sort_order ASC`,
    args: [clientId, clientId],
  });

  if (sitesRes.rows.length === 0) {
    return json({ has_data: false, sites: [] });
  }

  const sites = [];
  for (const row of sitesRes.rows) {
    const siteId = row[0] as string;
    const domain = row[1] as string;
    const zoneConfigured = row[2] !== null && row[2] !== '';
    const lastSynced = row[3] as string | null;

    // Determine the window: use the latest 30 days of data we have.
    const windowRes = await turso.execute({
      sql: `SELECT MIN(date), MAX(date), COUNT(*) FROM cloudflare_traffic_daily
            WHERE client_id = ? AND site_id = ?
              AND date >= date('now', '-31 days')`,
      args: [clientId, siteId],
    });
    const since = windowRes.rows[0]?.[0] as string | null;
    const until = windowRes.rows[0]?.[1] as string | null;
    const daysCovered = num(windowRes.rows[0]?.[2]) || 0;

    if (daysCovered === 0) {
      sites.push({
        site_id: siteId,
        domain,
        zone_configured: zoneConfigured,
        last_synced_at: lastSynced,
        has_data: false,
        traffic: null,
        security: null,
      });
      continue;
    }

    // Traffic aggregates + daily series for the chart.
    const trafficSumRes = await turso.execute({
      sql: `SELECT
              SUM(requests), SUM(cached_requests),
              SUM(bytes), SUM(cached_bytes),
              SUM(threats), SUM(page_views)
            FROM cloudflare_traffic_daily
            WHERE client_id = ? AND site_id = ?
              AND date >= ? AND date <= ?`,
      args: [clientId, siteId, since, until],
    });
    const t = trafficSumRes.rows[0];
    const totalRequests = num(t?.[0]) || 0;
    const cachedRequests = num(t?.[1]) || 0;
    const totalBytes = num(t?.[2]) || 0;
    const cachedBytes = num(t?.[3]) || 0;
    const totalThreats = num(t?.[4]) || 0;
    const totalPageViews = num(t?.[5]) || 0;

    const trafficSeriesRes = await turso.execute({
      sql: `SELECT date, requests, cached_requests, bytes, threats
            FROM cloudflare_traffic_daily
            WHERE client_id = ? AND site_id = ?
              AND date >= ? AND date <= ?
            ORDER BY date ASC`,
      args: [clientId, siteId, since, until],
    });
    const trafficSeries = trafficSeriesRes.rows.map(r => ({
      date: r[0] as string,
      requests: num(r[1]),
      cached_requests: num(r[2]),
      bytes: num(r[3]),
      threats: num(r[4]),
    }));

    // Security aggregates + daily series.
    const securitySumRes = await turso.execute({
      sql: `SELECT
              SUM(total_events), SUM(block_events),
              SUM(challenge_events), SUM(managed_challenge_events),
              SUM(js_challenge_events), SUM(log_events),
              SUM(rate_limit_events)
            FROM cloudflare_security_daily
            WHERE client_id = ? AND site_id = ?
              AND date >= ? AND date <= ?`,
      args: [clientId, siteId, since, until],
    });
    const s = securitySumRes.rows[0];

    const securitySeriesRes = await turso.execute({
      sql: `SELECT date, total_events, block_events, rate_limit_events
            FROM cloudflare_security_daily
            WHERE client_id = ? AND site_id = ?
              AND date >= ? AND date <= ?
            ORDER BY date ASC`,
      args: [clientId, siteId, since, until],
    });
    const securitySeries = securitySeriesRes.rows.map(r => ({
      date: r[0] as string,
      total_events: num(r[1]),
      block_events: num(r[2]),
      rate_limit_events: num(r[3]),
    }));

    sites.push({
      site_id: siteId,
      domain,
      zone_configured: zoneConfigured,
      last_synced_at: lastSynced,
      has_data: true,
      window: { since, until, days_covered: daysCovered },
      traffic: {
        total_requests: totalRequests,
        cached_requests: cachedRequests,
        cache_hit_rate: totalRequests > 0 ? cachedRequests / totalRequests : 0,
        total_bytes: totalBytes,
        cached_bytes: cachedBytes,
        total_threats: totalThreats,
        total_page_views: totalPageViews,
        series: trafficSeries,
      },
      security: {
        total_events: num(s?.[0]) || 0,
        block_events: num(s?.[1]) || 0,
        challenge_events: num(s?.[2]) || 0,
        managed_challenge_events: num(s?.[3]) || 0,
        js_challenge_events: num(s?.[4]) || 0,
        log_events: num(s?.[5]) || 0,
        rate_limit_events: num(s?.[6]) || 0,
        series: securitySeries,
      },
    });
  }

  return json({
    has_data: sites.some(s => s.has_data),
    sites,
  });
};
