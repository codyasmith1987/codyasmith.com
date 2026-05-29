// Performance Summary assembly: pure markdown builder.
//
// Takes already-read GA4 + GSC data and returns the full report markdown.
// It emits the DESCRIPTIVE substrate only: data tables, period-over-period
// deltas, and plain factual sentences that state the numbers. It NEVER
// writes judgment (a thesis, an interpretation, a recommendation); those
// are left as clearly-marked <!-- CODY --> placeholders so a rushed month
// still ships a clean factual report and a normal month Cody adds the read
// on top. No DB, no PDF, no Date.now() in the body: same input -> same
// bytes (the determinism that retires the manual validation pass).

import type { Ga4MonthData } from '../ga4-read';
import type { GscDailyRow, GscDimRow, GscTotals, GscFilter } from '../gsc-read';
import type { WindowSpec } from './windows';
import { aggregateWindow, weeklyBuckets } from './windows';
import { computeDelta, dualDelta, ctrDelta, positionDelta, shouldBold } from './deltas';

export interface ReportWindows {
  gscCurrent: WindowSpec;
  gscPrior?: WindowSpec;
  gscPreEngagement?: WindowSpec;
}

export interface SiteReportInput {
  siteName: string;
  periodLabel: string;        // e.g. "Month Two, May 2026"
  nextPeriodLabel: string;    // e.g. "next month"
  month: string;              // current cycle key
  ga4Current: Ga4MonthData | null;
  ga4Prior: Ga4MonthData | null;   // null => GA4 baseline mode
  gscChart: GscDailyRow[];
  gscTotals: GscTotals | null;
  gscQueries: GscDimRow[];
  gscPages: GscDimRow[];
  gscFilters: GscFilter[];
  windows: ReportWindows;
  hasCloudflare?: boolean;
}

// ---- formatters (display boundary; math stays in deltas/windows) ----

function fmtInt(n: number | null): string {
  if (n === null || n === undefined) return '';
  return Math.round(n).toLocaleString('en-US');
}
function fmtRate(frac: number | null): string {        // engagement rate stored 0..1
  if (frac === null || frac === undefined) return '';
  return `${(frac * 100).toFixed(1)}%`;
}
function fmtCtr(c: number | null): string {            // CTR stored 0..1, 2 decimals
  if (c === null || c === undefined) return '';
  return `${(c * 100).toFixed(2)}%`;
}
function fmtPos(p: number | null): string {
  if (p === null || p === undefined) return '';
  return p.toFixed(2);
}
function fmtSeconds(s: number | null): string {
  if (s === null || s === undefined) return '';
  return `${s.toFixed(1)}s`;
}
function fmtSignedPct(frac: number | null): string {
  if (frac === null || frac === undefined) return '';
  const sign = frac > 0 ? '+' : '';
  return `${sign}${(frac * 100).toFixed(1)}%`;
}

// A single-metric delta cell: "+12.3%", "new", "flat", or "" when no compare.
function deltaCell(prior: number | null, current: number | null): string {
  const d = computeDelta(prior, current, { metricKind: 'count' });
  if (d.direction === 'new') return 'new';
  if (d.direction === 'none') return '';
  if (d.direction === 'flat') return 'flat';
  if (d.percentChange !== null) return fmtSignedPct(d.percentChange);
  // prior 0, percent undefined: state the absolute move
  return d.absoluteChange !== null ? `${d.absoluteChange > 0 ? '+' : ''}${fmtInt(d.absoluteChange)}` : '';
}

// Dual delta cell for clicks/impressions: "+22.9% (+27.0% per day)", bolded
// when the per-day move is material. Baseline/no-prior -> "".
function dualCell(prior: { label: string; days: number; clicks: number | null; impressions: number | null }, current: { label: string; days: number; clicks: number | null; impressions: number | null }, metric: 'clicks' | 'impressions'): string {
  const dd = dualDelta(prior, current, metric);
  if (dd.absolute.direction === 'none') return '';
  const absStr = dd.absolute.direction === 'new' ? 'new'
    : dd.absolute.percentChange !== null ? fmtSignedPct(dd.absolute.percentChange)
    : (dd.absolute.absoluteChange !== null ? `${dd.absolute.absoluteChange > 0 ? '+' : ''}${fmtInt(dd.absolute.absoluteChange)}` : '');
  const perStr = dd.perDay.percentChange !== null ? `${fmtSignedPct(dd.perDay.percentChange)} per day` : '';
  const combined = perStr ? `${absStr} (${perStr})` : absStr;
  return shouldBold(dd.perDay.percentChange) ? `**${combined}**` : combined;
}

// ---- markdown helpers ----

function table(headers: string[], rows: string[][]): string {
  // Sanitize cells: a literal pipe or newline inside a value (a GSC query,
  // a page URL, a source/medium) would otherwise add a phantom column and
  // corrupt the row. Pipes are not meaningful in these values, so map them
  // to a slash; collapse newlines to spaces. (Bold ** markers survive.)
  const esc = (s: string) => String(s).replace(/\|/g, '/').replace(/\r?\n/g, ' ');
  const head = `| ${headers.map(esc).join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map(r => `| ${r.map(esc).join(' | ')} |`).join('\n');
  return `${head}\n${sep}\n${body}`;
}

// ---- GA4 date helpers (tokens like "20260412") ----

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function validGa4Token(tok: string | null): boolean {
  if (!tok || !/^\d{8}$/.test(tok)) return false;
  const m = Number(tok.slice(4, 6));
  const d = Number(tok.slice(6, 8));
  return m >= 1 && m <= 12 && d >= 1 && d <= 31;
}
function ga4FmtDate(tok: string | null): string {
  if (!validGa4Token(tok)) return tok || '';
  const m = Number(tok!.slice(4, 6));
  const d = Number(tok!.slice(6, 8));
  return `${MONTHS[m - 1]} ${d}`;
}
function ga4DaysBetween(start: string | null, end: string | null): number | null {
  if (!validGa4Token(start) || !validGa4Token(end)) return null;
  const s = Date.UTC(+start!.slice(0, 4), +start!.slice(4, 6) - 1, +start!.slice(6, 8));
  const e = Date.UTC(+end!.slice(0, 4), +end!.slice(4, 6) - 1, +end!.slice(6, 8));
  const days = Math.round((e - s) / 86400000) + 1; // inclusive
  return days > 0 ? days : null;
}

function share(n: number | null, total: number): string {
  if (n === null || total <= 0) return '';
  return `${((n / total) * 100).toFixed(1)}%`;
}

// ---- section builders (exported for unit tests via __test) ----

function buildTitle(input: SiteReportInput): string {
  return `Performance Summary, ${input.siteName}, ${input.periodLabel}`;
}

function buildThesisPlaceholder(): string {
  return [
    '<!-- CODY: thesis lede is yours. The factual substrate is below; interpret it here, do not restate the numbers. -->',
    '## [Thesis - Cody to write]',
    '',
  ].join('\n');
}

function buildWorkDeliveredPlaceholder(periodLabel: string): string {
  return [
    `## Work delivered in ${periodLabel}`,
    '<!-- CODY: operational log. Not derivable from analytics data. -->',
    '### Infrastructure and hosting maintenance',
    '<!-- CODY -->',
    '### Security and incident response',
    '<!-- CODY -->',
    '### Access and configuration',
    '<!-- CODY -->',
    '### Marketing Consulting deliverables filed with this package',
    '<!-- CODY -->',
    '### Hours delivered',
    '<!-- CODY: hours split, billable vs non-billable. -->',
    '',
  ].join('\n');
}

function buildGa4Section(input: SiteReportInput): string {
  const cur = input.ga4Current;
  if (!cur || !cur.has_data) {
    return ['## Analytics', 'No Google Analytics data was ingested for this period.', ''].join('\n');
  }
  const prior = input.ga4Prior;
  const trend = !!prior && !!prior.has_data;
  const parts: string[] = [];
  parts.push(`## Analytics, ${input.siteName}`);

  // Source line + window-length disclosure.
  const t = cur.topline;
  const curDays = t ? ga4DaysBetween(t.start_date, t.end_date) : null;
  const winLine = t
    ? `Source: Google Analytics. Coverage window: ${ga4FmtDate(t.start_date)} to ${ga4FmtDate(t.end_date)}${curDays ? ` (${curDays} days)` : ''}.`
    : 'Source: Google Analytics.';
  parts.push(winLine);
  if (trend && prior!.topline) {
    parts.push(`Prior period: ${ga4FmtDate(prior!.topline.start_date)} to ${ga4FmtDate(prior!.topline.end_date)}. Where the two windows differ in length, treat the change as approximate.`);
  } else {
    parts.push('This is the first reporting cycle for analytics, so the figures below establish a baseline. Period-over-period comparison begins next cycle.');
  }
  parts.push('');

  // Topline
  parts.push('### Topline');
  if (trend && prior!.topline && t) {
    const rows = [
      ['Active users', fmtInt(t.active_users), fmtInt(prior!.topline.active_users), deltaCell(prior!.topline.active_users, t.active_users)],
      ['New users', fmtInt(t.new_users), fmtInt(prior!.topline.new_users), deltaCell(prior!.topline.new_users, t.new_users)],
      ['Sessions', fmtInt(t.sessions), fmtInt(prior!.topline.sessions), deltaCell(prior!.topline.sessions, t.sessions)],
      ['Avg engagement time per active user', fmtSeconds(t.avg_engagement_time_per_active_user), fmtSeconds(prior!.topline.avg_engagement_time_per_active_user), deltaCell(prior!.topline.avg_engagement_time_per_active_user, t.avg_engagement_time_per_active_user)],
    ];
    parts.push(table(['Metric', input.periodLabel, 'Prior period', 'Change'], rows));
    const sd = computeDelta(prior!.topline.sessions, t.sessions);
    if (sd.direction !== 'none') {
      const chg = sd.percentChange !== null ? fmtSignedPct(sd.percentChange) : (sd.direction === 'new' ? 'new' : '');
      parts.push('');
      parts.push(`Sessions were ${fmtInt(t.sessions)} versus ${fmtInt(prior!.topline.sessions)}, a change of ${chg}.`);
    }
  } else if (t) {
    parts.push(table(['Metric', input.periodLabel], [
      ['Active users', fmtInt(t.active_users)],
      ['New users', fmtInt(t.new_users)],
      ['Sessions', fmtInt(t.sessions)],
      ['Avg engagement time per active user', fmtSeconds(t.avg_engagement_time_per_active_user)],
    ]));
  }
  parts.push('');

  // Channels
  if (cur.channels.length > 0) {
    parts.push('### Traffic by channel');
    const totalSessions = cur.channels.reduce((s, c) => s + (c.sessions ?? 0), 0);
    if (trend) {
      const priorByChannel = new Map(prior!.channels.map(c => [c.channel, c.sessions]));
      const rows = cur.channels.map(c => [c.channel, fmtInt(c.sessions), fmtInt(priorByChannel.get(c.channel) ?? null), deltaCell(priorByChannel.has(c.channel) ? priorByChannel.get(c.channel)! : null, c.sessions)]);
      parts.push(table(['Channel', `${input.periodLabel} sessions`, 'Prior sessions', 'Change'], rows));
    } else {
      const rows = cur.channels.map(c => [c.channel, fmtInt(c.sessions), share(c.sessions, totalSessions), fmtRate(c.engagement_rate)]);
      parts.push(table(['Channel', 'Sessions', 'Share', 'Engagement rate'], rows));
    }
    const top = cur.channels[0];
    if (top && top.sessions !== null && totalSessions > 0) {
      parts.push('');
      parts.push(`${top.channel} drove ${fmtInt(top.sessions)} of ${fmtInt(totalSessions)} sessions, which is ${share(top.sessions, totalSessions)}.`);
    }
    parts.push('');
  }

  // Source / medium
  if (cur.sources.length > 0) {
    parts.push('### Source and medium');
    const rows = cur.sources.slice(0, 15).map(s => [s.source_medium, fmtInt(s.sessions)]);
    parts.push(table(['Source / medium', 'Sessions'], rows));
    parts.push('');
  }

  // AI referrals
  if (cur.ai_referrals.length > 0) {
    parts.push('### AI interface referrals');
    const total = cur.ai_referrals.reduce((s, r) => s + (r.sessions ?? 0), 0);
    const rows = cur.ai_referrals.map(r => [r.source_medium, fmtInt(r.sessions)]);
    rows.push(['Total', fmtInt(total)]);
    parts.push(table(['Source', 'Sessions'], rows));
    parts.push('');
  }

  // Top pages
  if (cur.pages.length > 0) {
    parts.push('### Top pages');
    const rows = cur.pages.slice(0, 15).map(p => [p.page_path, fmtInt(p.views), fmtInt(p.active_users), fmtSeconds(p.avg_engagement_time_per_active_user)]);
    parts.push(table(['Page', 'Views', 'Active users', 'Avg engagement time/user'], rows));
    parts.push('');
  }

  // Device + geography
  if (cur.tech.device_category.length > 0) {
    parts.push('### Device category');
    const total = cur.tech.device_category.reduce((s, d) => s + (d.active_users ?? 0), 0);
    parts.push(table(['Device', 'Active users', 'Share'], cur.tech.device_category.map(d => [d.label, fmtInt(d.active_users), share(d.active_users, total)])));
    parts.push('');
  }
  if (cur.geography.length > 0) {
    parts.push('### Top geographies');
    const total = cur.geography.reduce((s, g) => s + (g.active_users ?? 0), 0);
    parts.push(table(['Country', 'Active users', 'Share'], cur.geography.slice(0, 10).map(g => [g.country, fmtInt(g.active_users), share(g.active_users, total)])));
    parts.push('');
  }

  parts.push('Interpretation:');
  parts.push('<!-- CODY: what the analytics numbers mean. Causal reads, watch-items, directives. -->');
  parts.push('');
  return parts.join('\n');
}

function buildGoogleAdsSection(input: SiteReportInput): string {
  const cur = input.ga4Current;
  if (!cur || cur.campaigns.length === 0) return '';
  const parts: string[] = [];
  parts.push(`## Paid search, ${input.siteName}`);
  parts.push('Source: Google Analytics campaign data.');
  const priorByName = new Map((input.ga4Prior?.campaigns ?? []).map(c => [c.campaign_name, c.sessions]));
  for (const c of cur.campaigns) {
    const priorSessions = priorByName.has(c.campaign_name) ? priorByName.get(c.campaign_name)! : null;
    const chg = deltaCell(priorSessions, c.sessions);
    const tail = chg && chg !== 'new' ? `, a change of ${chg}` : (chg === 'new' ? ', new this period' : '');
    const priorClause = priorSessions !== null ? ` versus ${fmtInt(priorSessions)} sessions` : '';
    parts.push(`The "${c.campaign_name}" campaign drove ${fmtInt(c.sessions)} sessions${priorClause}${tail}.`);
  }
  parts.push('Interpretation:');
  parts.push('<!-- CODY: account-access status, engagement read, strategic implication. -->');
  parts.push('');
  return parts.join('\n');
}

function buildGscSection(input: SiteReportInput): string {
  const chart = input.gscChart;
  if (chart.length === 0) {
    return ['## Search performance', 'No Google Search Console data was ingested for this period.', ''].join('\n');
  }
  const w = input.windows;
  const gscTrend = !!w.gscPrior;
  const parts: string[] = [];
  parts.push(`## Search performance, ${input.siteName}`);
  const filterSummary = input.gscFilters.length
    ? input.gscFilters.map(f => f.value ? `${f.key}: ${f.value}` : f.key).join('. ')
    : 'Google Search Console.';
  parts.push(`Source: Google Search Console. ${filterSummary}.`);
  parts.push('');

  // Arc topline (one row per window)
  parts.push('### Search totals by window');
  const windowSpecs: WindowSpec[] = [];
  if (w.gscPreEngagement) windowSpecs.push(w.gscPreEngagement);
  if (w.gscPrior) windowSpecs.push(w.gscPrior);
  windowSpecs.push(w.gscCurrent);
  const aggs = windowSpecs.map(spec => aggregateWindow(chart, spec));
  const arcRows = aggs.map(a => {
    const cpd = a.days > 0 && a.clicks !== null ? a.clicks / a.days : null;
    const ipd = a.days > 0 && a.impressions !== null ? a.impressions / a.days : null;
    const isCurrent = a.label === w.gscCurrent.label;
    const label = isCurrent ? `**${a.label}**` : a.label;
    return [label, String(a.days), fmtInt(a.clicks), cpd !== null ? fmtInt(cpd) : '', fmtInt(a.impressions), ipd !== null ? fmtInt(ipd) : '', fmtCtr(a.ctr), fmtPos(a.weightedPosition)];
  });
  parts.push(table(['Window', 'Days', 'Clicks', 'Clicks/day', 'Impressions', 'Impr/day', 'CTR', 'Avg position'], arcRows));
  parts.push('');

  // Current vs prior delta (trend only)
  if (gscTrend) {
    const priorAgg = aggregateWindow(chart, w.gscPrior!);
    const curAgg = aggregateWindow(chart, w.gscCurrent);
    const cd = ctrDelta(priorAgg.ctr, curAgg.ctr);
    const pd = positionDelta(priorAgg.weightedPosition, curAgg.weightedPosition);
    // Neutral, descriptive move only. Lower position is better, but naming
    // that ("improved"/"worsened") is a judgment and belongs in Cody's
    // interpretation block below, not in the auto-generated cell.
    const posStr = pd.absoluteChange === null ? ''
      : pd.direction === 'flat' ? 'no material change'
      : `${pd.absoluteChange < 0 ? '-' : '+'}${Math.abs(pd.absoluteChange).toFixed(2)} positions`;
    parts.push('### Current versus prior period');
    parts.push(table(['Metric', 'Change'], [
      ['Clicks', dualCell(priorAgg, curAgg, 'clicks') || ''],
      ['Impressions', dualCell(priorAgg, curAgg, 'impressions') || ''],
      ['CTR', cd.pointDelta !== null ? `${cd.pointDelta > 0 ? '+' : ''}${cd.pointDelta.toFixed(2)} percentage points (${fmtSignedPct(cd.relativePercent)} relative)` : ''],
      ['Avg position', posStr],
    ]));
    parts.push('');
  }

  // Weekly trajectory
  const weekly = weeklyBuckets(chart, 8);
  if (weekly.length > 0) {
    parts.push('### Weekly trajectory');
    const maxClicks = Math.max(...weekly.map(b => b.clicks ?? 0));
    const rows = weekly.map(b => {
      const wk = b.label.replace('Week of ', '');
      const c = b.clicks ?? 0;
      const clickStr = c === maxClicks && maxClicks > 0 ? `**${fmtInt(b.clicks)}**` : fmtInt(b.clicks);
      return [wk, clickStr, fmtInt(b.impressions)];
    });
    parts.push(table(['Week of', 'Clicks', 'Impressions'], rows));
    parts.push('');
  }

  // Top queries
  if (input.gscQueries.length > 0) {
    parts.push('### Top queries');
    parts.push(table(['Query', 'Clicks', 'Impressions', 'CTR', 'Position'],
      input.gscQueries.slice(0, 15).map(q => [q.value, fmtInt(q.clicks), fmtInt(q.impressions), fmtCtr(q.ctr), fmtPos(q.position)])));
    parts.push('');
  }
  // Top landing pages
  if (input.gscPages.length > 0) {
    parts.push('### Top landing pages');
    parts.push(table(['Page', 'Clicks', 'Impressions', 'CTR', 'Position'],
      input.gscPages.slice(0, 10).map(p => [p.value, fmtInt(p.clicks), fmtInt(p.impressions), fmtCtr(p.ctr), fmtPos(p.position)])));
    parts.push('');
  }

  parts.push('Interpretation:');
  parts.push('<!-- CODY: the arc read, the position reframe, the numbered findings for next month. -->');
  parts.push('');
  return parts.join('\n');
}

function buildWhatNextPlaceholder(nextPeriodLabel: string): string {
  return [
    `## What the ${nextPeriodLabel} report will add`,
    '<!-- CODY: forward commitments contingent on strategic input. -->',
    '',
  ].join('\n');
}

export function buildPerformanceSummaryMarkdown(input: SiteReportInput): string {
  const blocks = [
    buildTitle(input),
    '',
    buildThesisPlaceholder(),
    buildWorkDeliveredPlaceholder(input.periodLabel),
    buildGa4Section(input),
    buildGoogleAdsSection(input),
    buildGscSection(input),
    buildWhatNextPlaceholder(input.nextPeriodLabel),
  ];
  return blocks.filter(b => b !== '').join('\n');
}

export const __test = {
  buildTitle,
  buildThesisPlaceholder,
  buildWorkDeliveredPlaceholder,
  buildGa4Section,
  buildGoogleAdsSection,
  buildGscSection,
  buildWhatNextPlaceholder,
  ga4FmtDate,
  ga4DaysBetween,
};
