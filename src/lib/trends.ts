// Month-over-month trend series for a client's site data (Cody's 2026-06-02
// ask: see how the data MOVES, not just the latest snapshot). Reads the
// month-keyed upload tables the portal already maintains -- nothing new is
// stored -- and reuses the report pipeline's delta math so "improved/worsened"
// here always agrees with the monthly reports.
//
// Sparse-tolerant by design: a month appears when ANY source has data for it,
// and each metric group is null for months that source skipped. Deltas only
// compare against the nearest PRIOR month that actually has that group, so a
// skipped month never fabricates a zero.
//
// All upload joins filter csv_uploads.error IS NULL (superseded/failed uploads
// hold an error and their child rows are gone; live rows only).

import turso from './turso';
import { computeDelta, type Delta } from './reports/deltas';
import { realUserPageRowFilters, realUserPageUrlExclusions } from './csv/page-count-sql';
import { isAdvisoryIssue } from './crawl-read';

export interface TrendMonth {
  month: string; // YYYY-MM
  gsc: { clicks: number; impressions: number; avg_position: number | null } | null;
  ga4: { sessions: number | null; active_users: number | null } | null;
  health: { scored_issues: number; high: number; medium: number; low: number } | null;
  crawl: { pages: number; broken: number } | null;
  keywords: { tracked: number; avg_position: number | null; top10: number } | null;
}

// Keys we compute month-over-month deltas for, with the metric kind that
// drives direction semantics (position: lower is better).
const DELTA_KEYS: Array<{ key: string; pick: (m: TrendMonth) => number | null; kind: 'count' | 'position' }> = [
  { key: 'gsc.clicks', pick: m => m.gsc?.clicks ?? null, kind: 'count' },
  { key: 'gsc.impressions', pick: m => m.gsc?.impressions ?? null, kind: 'count' },
  { key: 'gsc.avg_position', pick: m => m.gsc?.avg_position ?? null, kind: 'position' },
  { key: 'ga4.sessions', pick: m => m.ga4?.sessions ?? null, kind: 'count' },
  { key: 'ga4.active_users', pick: m => m.ga4?.active_users ?? null, kind: 'count' },
  { key: 'health.scored_issues', pick: m => m.health?.scored_issues ?? null, kind: 'position' }, // fewer issues = improved
  { key: 'crawl.pages', pick: m => m.crawl?.pages ?? null, kind: 'count' },
  { key: 'crawl.broken', pick: m => m.crawl?.broken ?? null, kind: 'position' }, // fewer broken = improved
  { key: 'keywords.avg_position', pick: m => m.keywords?.avg_position ?? null, kind: 'position' },
  { key: 'keywords.top10', pick: m => m.keywords?.top10 ?? null, kind: 'count' },
];

export interface TrendMonthWithDeltas extends TrendMonth {
  deltas: Record<string, Delta>;
}

// Pure (unit-tested): attach month-over-month deltas to an ASCENDING series.
// Each metric compares to the nearest prior month where that metric group
// exists, so a month with no GA4 upload does not zero the GA4 trend.
export function attachTrendDeltas(series: TrendMonth[]): TrendMonthWithDeltas[] {
  return series.map((m, idx) => {
    const deltas: Record<string, Delta> = {};
    for (const { key, pick, kind } of DELTA_KEYS) {
      const current = pick(m);
      if (current == null) continue;
      let prior: number | null = null;
      for (let j = idx - 1; j >= 0; j--) {
        const p = pick(series[j]);
        if (p != null) { prior = p; break; }
      }
      if (prior == null) continue;
      deltas[key] = computeDelta(prior, current, { metricKind: kind });
    }
    return { ...m, deltas };
  });
}

const qAll = async (sql: string, args: any[]): Promise<any[]> => {
  const res = await turso.execute({ sql, args });
  return res.rows as any[];
};

// The trend series for one client, last `monthCount` months ascending.
export async function getSiteTrendSeries(clientId: string, monthCount = 6): Promise<TrendMonth[]> {
  const n = Math.min(Math.max(monthCount, 2), 36);

  // GSC: daily rows summed per month. CTR/position aggregate correctly only
  // from the raw sums (SUM/SUM, not AVG of daily CTRs).
  const gsc = await qAll(
    `SELECT cu.month,
            SUM(gc.clicks) AS clicks,
            SUM(gc.impressions) AS impressions,
            ROUND(AVG(gc.position), 1) AS avg_position
       FROM csv_uploads cu JOIN gsc_chart gc ON gc.csv_upload_id = cu.id
      WHERE cu.client_id = ? AND cu.error IS NULL
      GROUP BY cu.month`, [clientId]);

  // GA4: topline is one pre-aggregated row per upload (source of truth for
  // sessions; channel sums de-dupe differently).
  const ga4 = await qAll(
    `SELECT cu.month, gt.sessions, gt.active_users
       FROM csv_uploads cu JOIN ga4_topline gt ON gt.csv_upload_id = cu.id
      WHERE cu.client_id = ? AND cu.error IS NULL`, [clientId]);

  // Health: scored problems only -- advisories (Warning/Opportunity/audit) are
  // filtered in JS via the same isAdvisoryIssue the health page/score uses, so
  // the trend can never disagree with the score's definition of a problem.
  const issueRows = await qAll(
    `SELECT cu.month, si.issue_name, si.issue_type, si.priority, MAX(si.affected_urls) AS affected
       FROM csv_uploads cu JOIN site_issues si ON si.csv_upload_id = cu.id
      WHERE cu.client_id = ? AND cu.error IS NULL
      GROUP BY cu.month, si.issue_name, si.issue_type, si.priority`, [clientId]);

  // Crawl: real-user page count via the ONE shared SQL definition (pricing,
  // dashboard, and reports all key on it), plus broken (4xx/5xx) URLs. The
  // shared helpers emit "AND ..." fragments meant for a WHERE tail, so the
  // CASE condition starts from a 1=1 anchor.
  const crawl = await qAll(
    `SELECT cu.month,
            COUNT(DISTINCT CASE WHEN 1=1 ${realUserPageRowFilters('cr')} ${realUserPageUrlExclusions('cr.url')} THEN cr.url END) AS pages,
            COUNT(DISTINCT CASE WHEN cr.status_code >= 400 THEN cr.url END) AS broken
       FROM csv_uploads cu JOIN crawl_urls cr ON cr.csv_upload_id = cu.id
      WHERE cu.client_id = ? AND cu.error IS NULL
      GROUP BY cu.month`, [clientId]);

  // Keywords: tracked count, average position, and top-10 share.
  const kw = await qAll(
    `SELECT cu.month,
            COUNT(DISTINCT kr.keyword) AS tracked,
            ROUND(AVG(kr.position), 1) AS avg_position,
            COUNT(DISTINCT CASE WHEN kr.position <= 10 THEN kr.keyword END) AS top10
       FROM csv_uploads cu JOIN keyword_rankings kr ON kr.csv_upload_id = cu.id
      WHERE cu.client_id = ? AND cu.error IS NULL
      GROUP BY cu.month`, [clientId]);

  const byMonth = new Map<string, TrendMonth>();
  const monthOf = (m: string): TrendMonth => {
    let row = byMonth.get(m);
    if (!row) { row = { month: m, gsc: null, ga4: null, health: null, crawl: null, keywords: null }; byMonth.set(m, row); }
    return row;
  };

  for (const r of gsc) monthOf(r.month).gsc = { clicks: r.clicks ?? 0, impressions: r.impressions ?? 0, avg_position: r.avg_position ?? null };
  for (const r of ga4) monthOf(r.month).ga4 = { sessions: r.sessions ?? null, active_users: r.active_users ?? null };
  for (const r of crawl) monthOf(r.month).crawl = { pages: r.pages ?? 0, broken: r.broken ?? 0 };
  for (const r of kw) monthOf(r.month).keywords = { tracked: r.tracked ?? 0, avg_position: r.avg_position ?? null, top10: r.top10 ?? 0 };

  // Roll the per-issue rows into scored-problem counts by priority.
  const healthAgg = new Map<string, { scored_issues: number; high: number; medium: number; low: number }>();
  for (const r of issueRows) {
    if (isAdvisoryIssue({ issue_type: r.issue_type })) continue;
    let h = healthAgg.get(r.month);
    if (!h) { h = { scored_issues: 0, high: 0, medium: 0, low: 0 }; healthAgg.set(r.month, h); }
    h.scored_issues++;
    const p = String(r.priority || '').toLowerCase();
    if (p === 'critical' || p === 'high') h.high++;
    else if (p === 'medium') h.medium++;
    else h.low++;
  }
  for (const [m, h] of healthAgg) monthOf(m).health = h;

  return [...byMonth.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-n);
}
