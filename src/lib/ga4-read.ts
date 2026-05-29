// Canonical Google Analytics 4 read layer.
//
// Single source for reading ingested GA4 data. The /portal/traffic
// dashboard and the monthly report both call these. Extracted from the
// dashboard's previously-inline SQL (response shape unchanged), and
// parameterized by month so the report can read both the current cycle and
// the prior one for period-over-period deltas (the dashboard only ever read
// the latest month).

import turso from './turso';
import { AI_REFERRAL_PATTERNS } from './csv/parsers/ga4';

export interface Ga4Topline {
  start_date: string | null;
  end_date: string | null;
  active_users: number | null;
  new_users: number | null;
  sessions: number | null;
  avg_engagement_time_per_active_user: number | null;
}
export interface Ga4Channel {
  channel: string; sessions: number | null; engaged_sessions: number | null;
  engagement_rate: number | null; avg_engagement_time_per_session: number | null;
  key_events: number | null; total_revenue: number | null;
}
export interface Ga4Page {
  page_path: string; views: number | null; active_users: number | null;
  avg_engagement_time_per_active_user: number | null; key_events: number | null;
}
export interface Ga4Source { source_medium: string; sessions: number | null; key_events: number | null; total_revenue: number | null; }
export interface Ga4TechRow { label: string; active_users: number | null; }
export interface Ga4Geo { country: string; active_users: number | null; new_users: number | null; engaged_sessions: number | null; engagement_rate: number | null; }
export interface Ga4Campaign { campaign_name: string; sessions: number | null; }

export interface Ga4MonthData {
  month: string | null;
  has_data: boolean;
  topline: Ga4Topline | null;
  channels: Ga4Channel[];
  pages: Ga4Page[];
  sources: Ga4Source[];
  ai_referrals: Ga4Source[];
  tech: { platform: Ga4TechRow[]; os: Ga4TechRow[]; device_category: Ga4TechRow[] };
  geography: Ga4Geo[];
  campaigns: Ga4Campaign[];
}

function num(v: any): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function getGa4LatestMonth(clientId: string): Promise<string | null> {
  const r = await turso.execute({
    sql: `SELECT month FROM (
            SELECT month FROM ga4_topline WHERE client_id = ?
            UNION SELECT month FROM ga4_channels WHERE client_id = ?
            UNION SELECT month FROM ga4_pages WHERE client_id = ?
            UNION SELECT month FROM ga4_geography WHERE client_id = ?
          ) ORDER BY month DESC LIMIT 1`,
    args: [clientId, clientId, clientId, clientId],
  });
  return r.rows.length ? (r.rows[0][0] as string) : null;
}

// Latest month strictly before currentMonth (the prior reporting cycle).
export async function getGa4PriorMonth(clientId: string, currentMonth: string): Promise<string | null> {
  const r = await turso.execute({
    sql: `SELECT month FROM (
            SELECT month FROM ga4_topline WHERE client_id = ?
            UNION SELECT month FROM ga4_channels WHERE client_id = ?
            UNION SELECT month FROM ga4_pages WHERE client_id = ?
            UNION SELECT month FROM ga4_geography WHERE client_id = ?
          ) WHERE month < ? ORDER BY month DESC LIMIT 1`,
    args: [clientId, clientId, clientId, clientId, currentMonth],
  });
  return r.rows.length ? (r.rows[0][0] as string) : null;
}

// All GA4 sections for one month, assembled into the dashboard shape.
export async function getGa4MonthData(clientId: string, month: string): Promise<Ga4MonthData> {
  const toplineRes = await turso.execute({
    sql: `SELECT start_date, end_date, active_users, new_users, sessions, avg_engagement_time_per_active_user
          FROM ga4_topline WHERE client_id = ? AND month = ? ORDER BY created_at DESC LIMIT 1`,
    args: [clientId, month],
  });
  const tRow = toplineRes.rows[0];
  const topline: Ga4Topline | null = tRow ? {
    start_date: tRow[0] as string | null,
    end_date: tRow[1] as string | null,
    active_users: num(tRow[2]),
    new_users: num(tRow[3]),
    sessions: num(tRow[4]),
    avg_engagement_time_per_active_user: num(tRow[5]),
  } : null;

  const channelsRes = await turso.execute({
    sql: `SELECT channel, sessions, engaged_sessions, engagement_rate,
                 avg_engagement_time_per_session, key_events, total_revenue
          FROM ga4_channels WHERE client_id = ? AND month = ? ORDER BY sessions DESC NULLS LAST`,
    args: [clientId, month],
  });
  const channels: Ga4Channel[] = channelsRes.rows.map(r => ({
    channel: r[0] as string, sessions: num(r[1]), engaged_sessions: num(r[2]),
    engagement_rate: num(r[3]), avg_engagement_time_per_session: num(r[4]),
    key_events: num(r[5]), total_revenue: num(r[6]),
  }));

  const pagesRes = await turso.execute({
    sql: `SELECT page_path, views, active_users, avg_engagement_time_per_active_user, key_events
          FROM ga4_pages WHERE client_id = ? AND month = ? ORDER BY views DESC NULLS LAST LIMIT 25`,
    args: [clientId, month],
  });
  const pages: Ga4Page[] = pagesRes.rows.map(r => ({
    page_path: r[0] as string, views: num(r[1]), active_users: num(r[2]),
    avg_engagement_time_per_active_user: num(r[3]), key_events: num(r[4]),
  }));

  const smRes = await turso.execute({
    sql: `SELECT source_medium, sessions, key_events, total_revenue
          FROM ga4_source_medium WHERE client_id = ? AND month = ? AND kind = 'session'
          ORDER BY sessions DESC NULLS LAST LIMIT 25`,
    args: [clientId, month],
  });
  const sources: Ga4Source[] = smRes.rows.map(r => ({
    source_medium: r[0] as string, sessions: num(r[1]), key_events: num(r[2]), total_revenue: num(r[3]),
  }));
  const ai_referrals = sources.filter(s => AI_REFERRAL_PATTERNS.some(p => p.test(s.source_medium || '')));

  const techRes = await turso.execute({
    sql: `SELECT kind, label, active_users FROM ga4_tech
          WHERE client_id = ? AND month = ? ORDER BY active_users DESC NULLS LAST`,
    args: [clientId, month],
  });
  const tech = {
    platform: techRes.rows.filter(r => r[0] === 'platform').map(r => ({ label: r[1] as string, active_users: num(r[2]) })),
    os: techRes.rows.filter(r => r[0] === 'os').map(r => ({ label: r[1] as string, active_users: num(r[2]) })),
    device_category: techRes.rows.filter(r => r[0] === 'device_category').map(r => ({ label: r[1] as string, active_users: num(r[2]) })),
  };

  const geoRes = await turso.execute({
    sql: `SELECT country, active_users, new_users, engaged_sessions, engagement_rate
          FROM ga4_geography WHERE client_id = ? AND month = ? ORDER BY active_users DESC NULLS LAST LIMIT 15`,
    args: [clientId, month],
  });
  const geography: Ga4Geo[] = geoRes.rows.map(r => ({
    country: r[0] as string, active_users: num(r[1]), new_users: num(r[2]),
    engaged_sessions: num(r[3]), engagement_rate: num(r[4]),
  }));

  const campsRes = await turso.execute({
    sql: `SELECT campaign_name, sessions FROM ga4_campaigns
          WHERE client_id = ? AND month = ? ORDER BY sessions DESC NULLS LAST`,
    args: [clientId, month],
  });
  const campaigns: Ga4Campaign[] = campsRes.rows.map(r => ({ campaign_name: r[0] as string, sessions: num(r[1]) }));

  const has_data = topline !== null || channels.length > 0 || pages.length > 0 || geography.length > 0;
  return { month, has_data, topline, channels, pages, sources, ai_referrals, tech, geography, campaigns };
}

// Latest-month dashboard payload (the shape /portal/traffic renders).
export async function getGa4Dashboard(clientId: string): Promise<Ga4MonthData | { month: null; has_data: false }> {
  const month = await getGa4LatestMonth(clientId);
  if (!month) return { month: null, has_data: false };
  return getGa4MonthData(clientId, month);
}
