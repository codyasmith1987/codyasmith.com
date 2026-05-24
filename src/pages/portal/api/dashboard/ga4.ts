// GA4 dashboard data endpoint.
//
// Aggregates the latest month of GA4 ingestion for one client into
// the shape /portal/traffic renders. Returns null fields when the
// matching CSV hasn't been uploaded yet so the UI can show "no data
// for this category" without erroring.
//
// "Latest month" is the latest distinct month that has at least one
// ga4_topline row. If multiple GA4 files were uploaded for that
// month, the most recent CSV row wins per category (the supersede
// logic in csv/index.ts clears prior rows so the table holds only
// the current cycle's data).

import type { APIRoute } from 'astro';
import turso from '../../../../lib/turso';
import { AI_REFERRAL_PATTERNS } from '../../../../lib/csv/parsers/ga4';

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

  // Find the most recent month with any GA4 data. Falls through to
  // null if no GA4 file has been uploaded — UI handles that with an
  // empty state.
  const monthResult = await turso.execute({
    sql: `SELECT month FROM (
            SELECT month FROM ga4_topline WHERE client_id = ?
            UNION SELECT month FROM ga4_channels WHERE client_id = ?
            UNION SELECT month FROM ga4_pages WHERE client_id = ?
            UNION SELECT month FROM ga4_geography WHERE client_id = ?
          ) ORDER BY month DESC LIMIT 1`,
    args: [clientId, clientId, clientId, clientId],
  });
  if (monthResult.rows.length === 0) {
    return json({ month: null, has_data: false });
  }
  const month = monthResult.rows[0][0] as string;

  // Topline — most recent upload's row.
  const toplineRes = await turso.execute({
    sql: `SELECT start_date, end_date, active_users, new_users, sessions, avg_engagement_time_per_active_user
          FROM ga4_topline WHERE client_id = ? AND month = ? ORDER BY created_at DESC LIMIT 1`,
    args: [clientId, month],
  });
  const tRow = toplineRes.rows[0];
  const topline = tRow ? {
    start_date: tRow[0] as string | null,
    end_date: tRow[1] as string | null,
    active_users: num(tRow[2]),
    new_users: num(tRow[3]),
    sessions: num(tRow[4]),
    avg_engagement_time_per_active_user: num(tRow[5]),
  } : null;

  // Channel mix.
  const channelsRes = await turso.execute({
    sql: `SELECT channel, sessions, engaged_sessions, engagement_rate,
                 avg_engagement_time_per_session, key_events, total_revenue
          FROM ga4_channels WHERE client_id = ? AND month = ?
          ORDER BY sessions DESC NULLS LAST`,
    args: [clientId, month],
  });
  const channels = channelsRes.rows.map(r => ({
    channel: r[0] as string,
    sessions: num(r[1]),
    engaged_sessions: num(r[2]),
    engagement_rate: num(r[3]),
    avg_engagement_time_per_session: num(r[4]),
    key_events: num(r[5]),
    total_revenue: num(r[6]),
  }));

  // Top landing pages — limit to top 25, the page can show 10 by
  // default and "expand" to all 25.
  const pagesRes = await turso.execute({
    sql: `SELECT page_path, views, active_users, avg_engagement_time_per_active_user, key_events
          FROM ga4_pages WHERE client_id = ? AND month = ?
          ORDER BY views DESC NULLS LAST LIMIT 25`,
    args: [clientId, month],
  });
  const pages = pagesRes.rows.map(r => ({
    page_path: r[0] as string,
    views: num(r[1]),
    active_users: num(r[2]),
    avg_engagement_time_per_active_user: num(r[3]),
    key_events: num(r[4]),
  }));

  // Source / medium — session kind only (the first_user kind is
  // available but not on the default dashboard; reserved for a
  // detail drill-down). Limit to top 25.
  const smRes = await turso.execute({
    sql: `SELECT source_medium, sessions, key_events, total_revenue
          FROM ga4_source_medium
          WHERE client_id = ? AND month = ? AND kind = 'session'
          ORDER BY sessions DESC NULLS LAST LIMIT 25`,
    args: [clientId, month],
  });
  const sources = smRes.rows.map(r => ({
    source_medium: r[0] as string,
    sessions: num(r[1]),
    key_events: num(r[2]),
    total_revenue: num(r[3]),
  }));

  // AI referrals — derived from source_medium with the canonical
  // pattern set. Same data, separately surfaced so the dashboard
  // can carry an "AI search traffic" card that names the bots
  // sending visitors.
  const aiReferrals = sources.filter(s =>
    AI_REFERRAL_PATTERNS.some(p => p.test(s.source_medium || ''))
  );

  // Device + OS — both come from ga4_tech, distinguished by kind.
  const techRes = await turso.execute({
    sql: `SELECT kind, label, active_users FROM ga4_tech
          WHERE client_id = ? AND month = ?
          ORDER BY active_users DESC NULLS LAST`,
    args: [clientId, month],
  });
  const tech = {
    platform: techRes.rows.filter(r => r[0] === 'platform')
      .map(r => ({ label: r[1] as string, active_users: num(r[2]) })),
    os: techRes.rows.filter(r => r[0] === 'os')
      .map(r => ({ label: r[1] as string, active_users: num(r[2]) })),
    device_category: techRes.rows.filter(r => r[0] === 'device_category')
      .map(r => ({ label: r[1] as string, active_users: num(r[2]) })),
  };

  // Geography — top 15 countries.
  const geoRes = await turso.execute({
    sql: `SELECT country, active_users, new_users, engaged_sessions, engagement_rate
          FROM ga4_geography WHERE client_id = ? AND month = ?
          ORDER BY active_users DESC NULLS LAST LIMIT 15`,
    args: [clientId, month],
  });
  const geography = geoRes.rows.map(r => ({
    country: r[0] as string,
    active_users: num(r[1]),
    new_users: num(r[2]),
    engaged_sessions: num(r[3]),
    engagement_rate: num(r[4]),
  }));

  // Google Ads campaigns.
  const campsRes = await turso.execute({
    sql: `SELECT campaign_name, sessions FROM ga4_campaigns
          WHERE client_id = ? AND month = ?
          ORDER BY sessions DESC NULLS LAST`,
    args: [clientId, month],
  });
  const campaigns = campsRes.rows.map(r => ({
    campaign_name: r[0] as string,
    sessions: num(r[1]),
  }));

  return json({
    month,
    has_data: true,
    topline,
    channels,
    pages,
    sources,
    ai_referrals: aiReferrals,
    tech,
    geography,
    campaigns,
  });
};
