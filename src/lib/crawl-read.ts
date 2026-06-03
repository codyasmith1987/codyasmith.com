// Canonical Screaming Frog crawl / site-health read layer.
//
// Single source for reading ingested crawl data for the Site Health Report.
// Mirrors gsc-read.ts / ga4-read.ts: data-source-prefixed, parameterized by
// month so the report can read the current and prior crawl cycles for
// month-over-month deltas. The report anchors every read on ONE cycle month
// (the latest site_issues month) so the document is internally consistent,
// unlike the dashboard which resolves each table's month independently.

import turso from './turso';
import { realUserPageRowFilters, realUserPageUrlExclusions } from './csv/page-count-sql';

export interface SiteIssueRow {
  issue_name: string;
  issue_type: string | null;
  priority: string | null;
  affected_urls: number | null;
  pct_of_total: number | null;
  description: string | null;
  how_to_fix: string | null;
}

export interface HealthMonthData {
  month: string;
  issues: SiteIssueRow[];                 // SCORED problems, deduped by name, ORDER BY affected_urls DESC
  advisories: SiteIssueRow[];             // optional/benign (Warning/Opportunity + site_audit) — NOT scored
  totalIssues: number;                    // distinct SCORED issue categories
  totalAffected: number;                  // SUM(affected_urls) across SCORED categories
  byPriority: { high: number; medium: number; low: number };  // SCORED only
}

export interface ResponseCodeCount {
  code: string;          // '2xx' | '3xx' | '4xx' | '5xx'
  count: number | null;
}

// Canonical priority bucketing, matching score.ts: critical|high -> high,
// medium -> medium, everything else (including null) -> low. Pure.
export function bucketPriority(p: string | null): 'high' | 'medium' | 'low' {
  const v = String(p || '').toLowerCase();
  if (v === 'critical' || v === 'high') return 'high';
  if (v === 'medium') return 'medium';
  return 'low';
}

// An ADVISORY is a benign/optional finding that must NOT count toward the
// health score or read as a "problem": Screaming Frog's own "Warning" and
// "Opportunity" issue types (e.g. the Low-priority "Missing security header"
// categories), plus site_audit rows (issue_type='audit') which carry a
// hardcoded 'medium' priority rather than a real assessed severity. Splitting
// these out is the M2 + M3 fix from the classification audit; done here once so
// the score, the health page, and the report all stay consistent.
export function isAdvisoryIssue(issue: { issue_type: string | null }): boolean {
  const t = String(issue.issue_type || '').toLowerCase();
  return t === 'warning' || t === 'opportunity' || t === 'audit';
}

// Pure rollup of issue rows into a priority histogram (one count per
// category, matching how score.ts counts issue categories).
export function rollupByPriority(issues: SiteIssueRow[]): { high: number; medium: number; low: number } {
  const out = { high: 0, medium: 0, low: 0 };
  for (const i of issues) out[bucketPriority(i.priority)] += 1;
  return out;
}

export async function getHealthLatestMonth(clientId: string): Promise<string | null> {
  const r = await turso.execute({
    sql: 'SELECT DISTINCT month FROM site_issues WHERE client_id = ? ORDER BY month DESC LIMIT 1',
    args: [clientId],
  });
  return r.rows.length ? (r.rows[0][0] as string) : null;
}

export async function getHealthPriorMonth(clientId: string, currentMonth: string): Promise<string | null> {
  const r = await turso.execute({
    sql: 'SELECT DISTINCT month FROM site_issues WHERE client_id = ? AND month < ? ORDER BY month DESC LIMIT 1',
    args: [clientId, currentMonth],
  });
  return r.rows.length ? (r.rows[0][0] as string) : null;
}

// The issue rollup for one month. Deduped by name (MAX affected_urls wins
// when multiple tools report the same issue), matching dashboard/issues.ts.
export async function getHealthMonthData(clientId: string, month: string): Promise<HealthMonthData> {
  const res = await turso.execute({
    sql: `SELECT issue_name, issue_type, priority, MAX(affected_urls) AS affected_urls,
                 MAX(pct_of_total) AS pct_of_total, description, how_to_fix
          FROM site_issues
          WHERE client_id = ? AND month = ?
          GROUP BY issue_name
          ORDER BY affected_urls DESC`,
    args: [clientId, month],
  });
  const allRows: SiteIssueRow[] = res.rows.map(row => ({
    issue_name: row[0] as string,
    issue_type: row[1] as string | null,
    priority: row[2] as string | null,
    affected_urls: row[3] as number | null,
    pct_of_total: row[4] as number | null,
    description: row[5] as string | null,
    how_to_fix: row[6] as string | null,
  }));
  // Scored problems vs optional advisories (M2 + M3). The score, the health
  // page chips, and the report all read from this split, so they agree.
  // - scored: everything that is not advisory (excludes Warning/Opportunity
  //   AND the site_audit 'audit' rows) — feeds byPriority + the score.
  // - advisories (DISPLAYED): genuine SF recommendations only
  //   (Warning/Opportunity). site_audit 'audit' rows are derived-filename
  //   whole-crawl noise (e.g. "Response codes all") — excluded from the score
  //   AND from the displayed list, so they neither penalize nor clutter.
  const issues = allRows.filter(i => !isAdvisoryIssue(i));
  const advisories = allRows.filter(i => {
    const t = String(i.issue_type || '').toLowerCase();
    return t === 'warning' || t === 'opportunity';
  });
  const totalAffected = issues.reduce((s, i) => s + (i.affected_urls ?? 0), 0);
  return {
    month,
    issues,
    advisories,
    totalIssues: issues.length,
    totalAffected,
    byPriority: rollupByPriority(issues),
  };
}

// Navigable page count, matching the dashboard's "friendly" definition.
// Optionally scoped to one crawl month so the report is month-correct (the
// dashboard counts across all of a client's crawl_urls).
export async function getNavigablePageCount(clientId: string, month?: string): Promise<number> {
  const monthClause = month ? 'AND month = ?' : '';
  const args = month ? [clientId, month] : [clientId];
  const res = await turso.execute({
    sql: `SELECT COUNT(DISTINCT url) AS n
          FROM crawl_urls
          WHERE client_id = ?
          ${monthClause}
          ${realUserPageRowFilters()}
          ${realUserPageUrlExclusions('url')}`,
    args,
  });
  return (res.rows[0]?.[0] as number) || 0;
}

// Response-code bands derived directly from crawl_urls.status_code. Avoids
// depending on an unverified metrics-table slug; the band math is the same
// derivation the issue layer uses.
export async function getResponseCodeCounts(clientId: string, month: string): Promise<ResponseCodeCount[]> {
  // Restrict to real HTTP status ranges (100-599). This intentionally
  // excludes status 0 (no response / DNS or connection failure) and any
  // out-of-range value; the report's bands are 2xx-5xx and a no-response
  // URL is not a response code. Consistent with the navigable-page count,
  // which also only counts 200s.
  const res = await turso.execute({
    sql: `SELECT (status_code / 100) AS band, COUNT(DISTINCT url) AS n
          FROM crawl_urls
          WHERE client_id = ? AND month = ? AND status_code BETWEEN 100 AND 599
          GROUP BY band`,
    args: [clientId, month],
  });
  const byBand = new Map<number, number>();
  for (const r of res.rows) byBand.set(Number(r[0]), Number(r[1]));
  return [2, 3, 4, 5].map(b => ({ code: `${b}xx`, count: byBand.has(b) ? byBand.get(b)! : 0 }));
}

export const __test = { bucketPriority, rollupByPriority, isAdvisoryIssue };
