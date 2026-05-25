// Composite site score endpoint.
//
// Replaces the old arbitrary "base 50 + page1*30 + top3*20 - high*10"
// formula in dashboard.astro. The new score is the weighted average
// of four 0-100 component sub-scores, with any component lacking
// upload data EXCLUDED from the average rather than zeroed. Each
// component carries its own basis text so the dashboard can show
// the client exactly what's contributing.
//
// Components:
//
//   1. Search Visibility (keywords)
//      Source: keyword_rankings table.
//      Each positioned keyword contributes a position-tier score:
//        - Top 3 (1-3):  100 points
//        - Page 1 (4-10): 75 points
//        - Page 2 (11-20): 40 points
//        - Beyond (21+):  10 points
//      Component sub-score = average across positioned keywords.
//      Skipped when no keywords have positions.
//
//   2. Technical Health (site_issues)
//      Source: site_issues table.
//      Starts at 100. Subtracts (high*8 + medium*3 + low*1). Floor 0.
//      Skipped when no issues data uploaded.
//
//   3. Traffic Engagement (GA4)
//      Source: ga4_channels table (latest month).
//      Weighted average engagement_rate across channels, weighted by
//      sessions. Multiplied by 100 to express as 0-100.
//      Skipped when no GA4 channel data uploaded.
//
//   4. Search Performance (GSC)
//      Source: gsc_chart table (latest month, aggregated).
//      CTR-weighted: min(100, total_ctr * 2000). 0% CTR → 0;
//      5% CTR → 100. CTR is the cleanest single signal for "how
//      well does the site convert search impressions into clicks."
//      Skipped when no GSC data uploaded.
//
// Overall = arithmetic mean of available components. When zero
// components are available, returns null + a clear "no data"
// message so the dashboard can show an empty state.

import type { APIRoute } from 'astro';
import turso from '../../../../lib/turso';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

interface Component {
  key: string;
  label: string;
  score: number | null;
  available: boolean;
  basis: string;
}

function num(v: any): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ===== Component 1: Search Visibility =====
async function computeVisibility(clientId: string): Promise<Component> {
  // Pull latest-month keywords with positions.
  const monthRow = await turso.execute({
    sql: `SELECT DISTINCT month FROM keyword_rankings
          WHERE client_id = ? AND position IS NOT NULL
          ORDER BY month DESC LIMIT 1`,
    args: [clientId],
  });
  if (monthRow.rows.length === 0) {
    return {
      key: 'visibility', label: 'Search Visibility',
      score: null, available: false,
      basis: 'No keyword position data uploaded.',
    };
  }
  const month = monthRow.rows[0][0] as string;
  const positionsRes = await turso.execute({
    sql: `SELECT position FROM keyword_rankings
          WHERE client_id = ? AND month = ? AND position IS NOT NULL`,
    args: [clientId, month],
  });
  const positions = positionsRes.rows
    .map(r => num(r[0]))
    .filter((p): p is number => p !== null && p > 0);
  if (positions.length === 0) {
    return {
      key: 'visibility', label: 'Search Visibility',
      score: null, available: false,
      basis: 'No keyword position data uploaded.',
    };
  }
  let pointsSum = 0;
  let top3 = 0, page1 = 0, page2 = 0, beyond = 0;
  for (const pos of positions) {
    if (pos <= 3)       { pointsSum += 100; top3++; }
    else if (pos <= 10) { pointsSum += 75;  page1++; }
    else if (pos <= 20) { pointsSum += 40;  page2++; }
    else                { pointsSum += 10;  beyond++; }
  }
  const score = Math.round(pointsSum / positions.length);
  const totalPage1 = top3 + page1;
  const basis = `${totalPage1} of ${positions.length} keyword${positions.length !== 1 ? 's' : ''} on page 1 (${top3} in top 3).`;
  return { key: 'visibility', label: 'Search Visibility', score, available: true, basis };
}

// ===== Component 2: Technical Health =====
async function computeHealth(clientId: string): Promise<Component> {
  const monthRow = await turso.execute({
    sql: `SELECT DISTINCT month FROM site_issues
          WHERE client_id = ? ORDER BY month DESC LIMIT 1`,
    args: [clientId],
  });
  if (monthRow.rows.length === 0) {
    return {
      key: 'health', label: 'Technical Health',
      score: null, available: false,
      basis: 'No site audit uploaded.',
    };
  }
  const month = monthRow.rows[0][0] as string;
  const issuesRes = await turso.execute({
    sql: `SELECT priority FROM site_issues WHERE client_id = ? AND month = ?`,
    args: [clientId, month],
  });
  let high = 0, medium = 0, low = 0;
  for (const r of issuesRes.rows) {
    const p = String(r[0] || '').toLowerCase();
    if (p === 'critical' || p === 'high') high++;
    else if (p === 'medium') medium++;
    else low++;
  }
  const total = high + medium + low;
  const raw = 100 - (high * 8 + medium * 3 + low * 1);
  const score = Math.max(0, Math.min(100, raw));
  const basis = total === 0
    ? 'No issues found in your latest audit.'
    : `${high} high, ${medium} medium, ${low} low.`;
  return { key: 'health', label: 'Technical Health', score, available: true, basis };
}

// ===== Component 3: Traffic Engagement =====
async function computeEngagement(clientId: string): Promise<Component> {
  const monthRow = await turso.execute({
    sql: `SELECT DISTINCT month FROM ga4_channels
          WHERE client_id = ? ORDER BY month DESC LIMIT 1`,
    args: [clientId],
  });
  if (monthRow.rows.length === 0) {
    return {
      key: 'engagement', label: 'Traffic Engagement',
      score: null, available: false,
      basis: 'No GA4 traffic data uploaded.',
    };
  }
  const month = monthRow.rows[0][0] as string;
  const res = await turso.execute({
    sql: `SELECT sessions, engagement_rate FROM ga4_channels
          WHERE client_id = ? AND month = ?
            AND sessions IS NOT NULL AND engagement_rate IS NOT NULL`,
    args: [clientId, month],
  });
  if (res.rows.length === 0) {
    return {
      key: 'engagement', label: 'Traffic Engagement',
      score: null, available: false,
      basis: 'GA4 channels table has no rows with engagement data.',
    };
  }
  let weightedSum = 0;
  let totalSessions = 0;
  for (const row of res.rows) {
    const sessions = num(row[0]) || 0;
    const rate = num(row[1]) || 0;
    weightedSum += sessions * rate;
    totalSessions += sessions;
  }
  const avgRate = totalSessions > 0 ? weightedSum / totalSessions : 0;
  const score = Math.round(Math.max(0, Math.min(100, avgRate * 100)));
  const basis = `${(avgRate * 100).toFixed(1)}% session engagement rate across ${totalSessions.toLocaleString()} sessions.`;
  return { key: 'engagement', label: 'Traffic Engagement', score, available: true, basis };
}

// ===== Component 4: Search Performance =====
async function computeSearchPerf(clientId: string): Promise<Component> {
  const monthRow = await turso.execute({
    sql: `SELECT DISTINCT month FROM gsc_chart
          WHERE client_id = ? ORDER BY month DESC LIMIT 1`,
    args: [clientId],
  });
  if (monthRow.rows.length === 0) {
    return {
      key: 'search', label: 'Search Performance',
      score: null, available: false,
      basis: 'No Google Search Console data uploaded.',
    };
  }
  const month = monthRow.rows[0][0] as string;
  const totalsRes = await turso.execute({
    sql: `SELECT SUM(clicks), SUM(impressions), AVG(position)
          FROM gsc_chart WHERE client_id = ? AND month = ?`,
    args: [clientId, month],
  });
  const tRow = totalsRes.rows[0];
  const clicks = num(tRow?.[0]) || 0;
  const impressions = num(tRow?.[1]) || 0;
  const avgPos = num(tRow?.[2]) || 0;
  if (impressions === 0) {
    return {
      key: 'search', label: 'Search Performance',
      score: null, available: false,
      basis: 'GSC data uploaded but zero impressions reported.',
    };
  }
  const ctr = clicks / impressions;
  // 5% CTR → 100, 0% → 0. CTR is the cleanest signal for how well
  // the site converts impressions to clicks at whatever positions
  // it ranks.
  const score = Math.round(Math.max(0, Math.min(100, ctr * 2000)));
  const basis = `${(ctr * 100).toFixed(2)}% click-through rate on ${impressions.toLocaleString()} impressions, avg position ${avgPos.toFixed(1)}.`;
  return { key: 'search', label: 'Search Performance', score, available: true, basis };
}

export const GET: APIRoute = async ({ locals, url }) => {
  if (!locals.user) return json({ error: 'Unauthorized' }, 401);

  const clientId = locals.user.role === 'admin'
    ? (url.searchParams.get('client_id') || null)
    : locals.user.client_id;
  if (!clientId) return json({ error: 'No client specified' }, 400);

  // Compute all four components in parallel. They're independent
  // queries against different tables; no reason to serialize.
  const [visibility, health, engagement, search] = await Promise.all([
    computeVisibility(clientId),
    computeHealth(clientId),
    computeEngagement(clientId),
    computeSearchPerf(clientId),
  ]);

  const components: Component[] = [visibility, health, engagement, search];
  const available = components.filter(c => c.available && c.score !== null);
  const overall = available.length > 0
    ? Math.round(available.reduce((s, c) => s + (c.score || 0), 0) / available.length)
    : null;

  return json({
    overall,
    components,
    components_used: available.length,
    components_total: components.length,
    has_data: available.length > 0,
  });
};
