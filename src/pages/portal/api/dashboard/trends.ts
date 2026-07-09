import type { APIRoute } from 'astro';
import turso from '../../../../lib/turso';
import { getSiteTrendSeries, attachTrendDeltas } from '../../../../lib/trends';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals, url }) => {
  if (!locals.user) return json({ error: 'Unauthorized' }, 401);

  const clientId = locals.user.role === 'admin'
    ? (url.searchParams.get('client_id') || null)
    : locals.user.client_id;

  if (!clientId) return json({ error: 'No client specified' }, 400);

  const category = url.searchParams.get('category') || 'traffic';
  // Clamp months to [1, 36] so the multiplier below (months * 20) never
  // explodes into an unbounded SQL LIMIT. See SEC2-004.
  const rawMonths = parseInt(url.searchParams.get('months') || '6', 10);
  const months = Number.isFinite(rawMonths) ? Math.min(Math.max(rawMonths, 1), 36) : 6;

  // ?series=site: the month-over-month site-data series (GSC, GA4, health,
  // crawl, keywords) aggregated live from the month-keyed upload tables, with
  // report-grade deltas attached. The legacy metrics-table path below stays
  // untouched for its existing consumers.
  //
  // Multi-site clients are scoped per site (?site=<domain>, default primary)
  // so two sites' numbers never blend; single-site clients are unscoped and
  // unchanged. The response carries the site list so the UI can draw chips.
  if (url.searchParams.get('series') === 'site') {
    const { listManagedSites } = await import('../../../../lib/client-sites');
    const sites = await listManagedSites(clientId);
    let scope: { id: string; domain: string; isPrimary: boolean } | undefined;
    let siteMeta: { sites: Array<{ domain: string; is_primary: boolean }>; site: string } | {} = {};
    if (sites.length > 1) {
      const wanted = (url.searchParams.get('site') || '').trim().toLowerCase();
      const match = wanted
        ? sites.find(s => s.domain.toLowerCase() === wanted)
        : (sites.find(s => s.is_primary) || sites[0]);
      if (!match) return json({ error: 'Unknown site for this client' }, 400);
      scope = { id: match.id, domain: match.domain, isPrimary: !!match.is_primary };
      siteMeta = { sites: sites.map(s => ({ domain: s.domain, is_primary: !!s.is_primary })), site: match.domain };
    }
    const series = await getSiteTrendSeries(clientId, months, scope);
    return json({ months: attachTrendDeltas(series), ...siteMeta });
  }

  const result = await turso.execute({
    sql: `SELECT month, metric_key, metric_value
          FROM metrics
          WHERE client_id = ? AND category = ?
          ORDER BY month DESC
          LIMIT ?`,
    args: [clientId, category, months * 20], // generous limit for multiple metrics per month
  });

  // Group by month
  const byMonth = new Map<string, Record<string, number>>();
  for (const row of result.rows) {
    const month = row[0] as string;
    if (!byMonth.has(month)) byMonth.set(month, {});
    byMonth.get(month)![row[1] as string] = row[2] as number;
  }

  const data = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, metrics]) => ({ month, ...metrics }));

  return json({ category, data });
};
