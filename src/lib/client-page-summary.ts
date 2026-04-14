// Plain-language client summaries for the four client-visible
// module pages (keywords, health, files, invoices).
//
// Each builder returns a ClientSummary — one headline sentence, up
// to three supporting bullet sentences, and an optional callout for
// anything that needs the client's direct attention. Every sentence
// is written at a 7th-grade reading level with the same voice rule
// the client-narrator follows: no jargon dump, no fake certainty,
// no invented recommendations. Words like "SEO", "GSC", "CTA" are
// off limits — the client sees "search traffic", "Google", "page
// titles" instead.
//
// This file does NOT introduce new storage or new API surface. It
// reads the same tables the existing pages already render from. The
// goal is to put honest plain-language framing at the top of each
// page without gutting the raw detail that still lives below.

import turso from './turso';
import { compareTraffic } from './traffic-metrics';

export interface ClientSummary {
  headline: string;
  bullets: string[];
  callout: string | null;
}

// ---------- Small plain-language helpers ----------

function plural(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : (plural ?? singular + 's')}`;
}

function friendlyMonthDay(iso: string): string {
  const [y, m, d] = iso.split('T')[0].split('-').map(Number);
  if (!y || !m || !d) return iso;
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  return `${months[m - 1]} ${d}`;
}

function daysAgoLabel(iso: string): string {
  const then = new Date(iso);
  if (isNaN(then.getTime())) return iso;
  const now = new Date();
  const ms = now.getTime() - then.getTime();
  const days = Math.floor(ms / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'a week ago';
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  return `over a month ago`;
}

// Turns an audit-tool issue name into plain English. Unknown
// patterns fall through to the original name so nothing gets
// dropped silently.
function plainIssueLabel(name: string, count: number): string {
  const lower = name.toLowerCase();
  const c = plural(count, 'page');
  if (lower.includes('broken link') || lower.includes('4xx')) {
    return plural(count, 'broken link');
  }
  if (lower.includes('missing meta description')) {
    return `${c} missing a short description`;
  }
  if (lower.includes('missing title') || lower.includes('missing page title')) {
    return `${c} without a page title`;
  }
  if (lower.includes('duplicate title')) {
    return `${c} with the same page title as another`;
  }
  if (lower.includes('duplicate meta')) {
    return `${c} with a repeated short description`;
  }
  if (lower.includes('low word count') || lower.includes('thin content')) {
    return `${c} with very little text on them`;
  }
  if (lower.includes('image') && lower.includes('alt')) {
    return `${c} with images that don't describe themselves to screen readers`;
  }
  if (lower.includes('large') && lower.includes('image')) {
    return `${c} with images that slow the page down`;
  }
  if (lower.includes('redirect')) {
    return `${c} that bounce through an extra redirect`;
  }
  if (lower.includes('slow') || lower.includes('speed')) {
    return `${c} that load slowly`;
  }
  // Fall through — keep the raw label but prefix with count.
  return `${c}: ${name}`;
}

// ---------- Period resolution ----------
// Returns the two most-recent period ids (current, prior) for a
// client. Either value can be null — the caller branches on that.

async function recentPeriods(
  clientId: string
): Promise<{ current: string | null; prior: string | null }> {
  const r = await turso.execute({
    sql: `SELECT id FROM periods
          WHERE client_id = ? AND period_type = 'month'
          ORDER BY period_start DESC LIMIT 2`,
    args: [clientId],
  });
  return {
    current: r.rows.length > 0 ? (r.rows[0][0] as string) : null,
    prior: r.rows.length > 1 ? (r.rows[1][0] as string) : null,
  };
}

// ---------- Keywords ----------

interface KeywordSlice {
  total: number;
  top3: number;
  page1: number;
}

async function loadKeywordSlice(
  clientId: string,
  periodId: string
): Promise<KeywordSlice> {
  const r = await turso.execute({
    sql: `SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN position >= 1 AND position <= 3 THEN 1 ELSE 0 END) AS top3,
            SUM(CASE WHEN position >= 1 AND position <= 10 THEN 1 ELSE 0 END) AS page1
          FROM keyword_snapshots
          WHERE client_id = ? AND period_id = ? AND source = 'position_tracking'`,
    args: [clientId, periodId],
  });
  if (r.rows.length === 0) return { total: 0, top3: 0, page1: 0 };
  const row = r.rows[0];
  return {
    total: Number(row[0] ?? 0),
    top3: Number(row[1] ?? 0),
    page1: Number(row[2] ?? 0),
  };
}

interface BiggestMover {
  keyword: string;
  prior_position: number;
  current_position: number;
  delta: number; // positive = improvement (position decreased)
}

async function biggestMover(
  clientId: string,
  currentPeriodId: string,
  priorPeriodId: string
): Promise<BiggestMover | null> {
  // A keyword's "improvement" is prior_position - current_position.
  // Positive delta = rank went up (better). Negative = rank dropped.
  const r = await turso.execute({
    sql: `SELECT cur.keyword, prev.position AS prior_pos, cur.position AS cur_pos
          FROM keyword_snapshots cur
          JOIN keyword_snapshots prev
            ON prev.client_id = cur.client_id
            AND prev.keyword = cur.keyword
            AND prev.source = cur.source
          WHERE cur.client_id = ?
            AND cur.period_id = ?
            AND prev.period_id = ?
            AND cur.source = 'position_tracking'
            AND cur.position IS NOT NULL
            AND prev.position IS NOT NULL
          ORDER BY (prev.position - cur.position) DESC
          LIMIT 1`,
    args: [clientId, currentPeriodId, priorPeriodId],
  });
  if (r.rows.length === 0) return null;
  const prior = Number(r.rows[0][1]);
  const current = Number(r.rows[0][2]);
  return {
    keyword: r.rows[0][0] as string,
    prior_position: prior,
    current_position: current,
    delta: prior - current,
  };
}

export async function buildKeywordsSummary(clientId: string): Promise<ClientSummary> {
  const { current, prior } = await recentPeriods(clientId);
  if (!current) {
    return {
      headline: "We don't have any ranking data for you yet.",
      bullets: [],
      callout: "When your first report comes in we'll show what's working and what's slipping.",
    };
  }
  const curSlice = await loadKeywordSlice(clientId, current);
  if (curSlice.total === 0) {
    return {
      headline: "We're still setting up your ranking tracking.",
      bullets: [],
      callout: null,
    };
  }
  if (!prior) {
    return {
      headline: `This is the first month we're tracking your rankings.`,
      bullets: [
        `${plural(curSlice.total, 'keyword')} in the tracker`,
        `${curSlice.top3} in the top 3 results`,
        `${curSlice.page1} showing on page 1`,
      ],
      callout: "Next month we'll show what moved up and what dropped.",
    };
  }
  const priSlice = await loadKeywordSlice(clientId, prior);
  const top3Delta = curSlice.top3 - priSlice.top3;
  const page1Delta = curSlice.page1 - priSlice.page1;
  const totalDelta = curSlice.total - priSlice.total;

  let headline: string;
  if (top3Delta > 0 && page1Delta >= 0) {
    headline = 'Your rankings got better this month.';
  } else if (top3Delta < 0 || page1Delta < 0) {
    headline = 'Your rankings slipped this month.';
  } else {
    headline = 'Your rankings held steady this month.';
  }

  const bullets: string[] = [];
  if (top3Delta !== 0) {
    bullets.push(
      top3Delta > 0
        ? `${plural(top3Delta, 'more keyword')} in the top 3 results`
        : `${plural(-top3Delta, 'keyword')} dropped out of the top 3`
    );
  }
  if (page1Delta !== 0) {
    bullets.push(
      page1Delta > 0
        ? `${plural(page1Delta, 'more keyword')} showing on page 1`
        : `${plural(-page1Delta, 'keyword')} fell off page 1`
    );
  }
  if (totalDelta !== 0 && bullets.length < 3) {
    bullets.push(
      totalDelta > 0
        ? `${plural(totalDelta, 'new keyword')} added to the tracker`
        : `${plural(-totalDelta, 'keyword')} removed from the tracker`
    );
  }
  const mover = await biggestMover(clientId, current, prior);
  if (mover && Math.abs(mover.delta) >= 3 && bullets.length < 3) {
    if (mover.delta > 0) {
      bullets.push(
        `Biggest jump: "${mover.keyword}" moved from #${mover.prior_position} to #${mover.current_position}`
      );
    } else {
      bullets.push(
        `Biggest drop: "${mover.keyword}" fell from #${mover.prior_position} to #${mover.current_position}`
      );
    }
  }

  return { headline, bullets, callout: null };
}

// ---------- Health ----------

interface IssueRow {
  issue_name: string;
  priority: string | null;
  affected_urls: number | null;
}

async function loadPriorityIssues(
  clientId: string,
  periodId: string
): Promise<IssueRow[]> {
  const r = await turso.execute({
    sql: `SELECT issue_name, priority, affected_urls
          FROM issue_snapshots
          WHERE client_id = ? AND period_id = ?
          ORDER BY
            CASE LOWER(COALESCE(priority, ''))
              WHEN 'high' THEN 0
              WHEN 'medium' THEN 1
              WHEN 'low' THEN 2
              ELSE 3
            END,
            COALESCE(affected_urls, 0) DESC`,
    args: [clientId, periodId],
  });
  return r.rows.map((row) => ({
    issue_name: row[0] as string,
    priority: (row[1] as string | null) ?? null,
    affected_urls: row[2] == null ? null : Number(row[2]),
  }));
}

export async function buildHealthSummary(clientId: string): Promise<ClientSummary> {
  const { current } = await recentPeriods(clientId);
  if (!current) {
    return {
      headline: "We haven't checked your site health yet.",
      bullets: [],
      callout: null,
    };
  }
  const issues = await loadPriorityIssues(clientId, current);
  if (issues.length === 0) {
    return {
      headline: 'No site problems right now.',
      bullets: [],
      callout: null,
    };
  }
  const highCount = issues.filter((i) => i.priority?.toLowerCase() === 'high').length;
  const mediumCount = issues.filter((i) => i.priority?.toLowerCase() === 'medium').length;
  const top = issues[0];
  const topAffected = top.affected_urls ?? 1;

  const totalLabel = plural(issues.length, 'thing');
  const headline = `We found ${totalLabel} to look at on your site.`;
  const bullets: string[] = [];
  bullets.push(`Biggest one: ${plainIssueLabel(top.issue_name, topAffected)}`);
  if (highCount > 0) {
    bullets.push(`${plural(highCount, 'high-priority issue')} in the list`);
  } else if (mediumCount > 0) {
    bullets.push(`${plural(mediumCount, 'medium-priority issue')} in the list`);
  }

  const callout =
    highCount > 0
      ? "The high-priority items are where we'll focus first."
      : null;

  return { headline, bullets, callout };
}

// ---------- Files ----------

interface FileRow {
  filename: string;
  original_name: string;
  category: string;
  size_bytes: number;
  created_at: string;
}

async function recentFilesForClient(
  clientId: string,
  days: number
): Promise<FileRow[]> {
  const r = await turso.execute({
    sql: `SELECT filename, original_name, category, size_bytes, created_at
          FROM files
          WHERE client_id = ?
            AND created_at >= datetime('now', '-' || ? || ' days')
          ORDER BY created_at DESC`,
    args: [clientId, days],
  });
  return r.rows.map((row) => ({
    filename: row[0] as string,
    original_name: row[1] as string,
    category: (row[2] as string | null) ?? 'general',
    size_bytes: Number(row[3] ?? 0),
    created_at: row[4] as string,
  }));
}

export async function buildFilesSummary(clientId: string): Promise<ClientSummary> {
  const recent = await recentFilesForClient(clientId, 30);
  if (recent.length === 0) {
    return {
      headline: 'No new files in the past month.',
      bullets: [],
      callout: null,
    };
  }
  const headline = `${plural(recent.length, 'file')} added in the past month.`;
  const bullets: string[] = [];
  for (const f of recent.slice(0, 3)) {
    bullets.push(`${f.original_name} (${daysAgoLabel(f.created_at)})`);
  }
  if (recent.length > 3) {
    bullets.push(`and ${recent.length - 3} more`);
  }
  return { headline, bullets, callout: null };
}

// ---------- Invoices ----------

interface InvoiceRow {
  id: string;
  invoice_number: string;
  status: string;
  due_date: string | null;
  total: number;
  amount_paid: number;
}

async function loadClientVisibleInvoices(clientId: string): Promise<InvoiceRow[]> {
  const r = await turso.execute({
    sql: `SELECT id, invoice_number, status, due_date, total, amount_paid
          FROM invoices
          WHERE client_id = ?
            AND client_visible = 1
            AND status IN ('sent', 'paid', 'partial', 'overdue')
          ORDER BY due_date ASC NULLS LAST`,
    args: [clientId],
  });
  return r.rows.map((row) => ({
    id: row[0] as string,
    invoice_number: row[1] as string,
    status: row[2] as string,
    due_date: (row[3] as string | null) ?? null,
    total: Number(row[4] ?? 0),
    amount_paid: Number(row[5] ?? 0),
  }));
}

// ---------- Traffic (Slice 18c) ----------
// Reads metric_snapshots where category='traffic' for up to two
// periods and produces a plain-language ClientSummary answering
// "is traffic up, flat, or down this month and what changed?".
//
// No-data and first-month branches return honest fallback copy
// instead of pretending to have compare data.

interface TrafficPeriod {
  id: string;
  period_start: string;
}

async function recentTrafficPeriods(
  clientId: string,
  limit: number
): Promise<TrafficPeriod[]> {
  const r = await turso.execute({
    sql: `SELECT DISTINCT p.id, p.period_start
          FROM periods p
          JOIN metric_snapshots m ON m.period_id = p.id
          WHERE p.client_id = ?
            AND m.category = 'traffic'
          ORDER BY p.period_start DESC
          LIMIT ?`,
    args: [clientId, limit],
  });
  return r.rows.map((row) => ({
    id: row[0] as string,
    period_start: row[1] as string,
  }));
}

interface TrafficRow {
  sessions: number;
  users: number;
  page_views: number;
  engaged_sessions: number;
  engagement_rate: number;
}

async function loadTrafficRow(
  clientId: string,
  periodId: string
): Promise<TrafficRow | null> {
  const r = await turso.execute({
    sql: `SELECT metric_key, metric_value
          FROM metric_snapshots
          WHERE client_id = ? AND period_id = ? AND category = 'traffic'`,
    args: [clientId, periodId],
  });
  if (r.rows.length === 0) return null;
  const map = new Map<string, number>();
  for (const row of r.rows) map.set(row[0] as string, Number(row[1] ?? 0));
  // Require the full set — partial rows are treated as "no data"
  // so the caller never renders half-a-summary.
  const required = ['sessions', 'users', 'page_views', 'engaged_sessions', 'engagement_rate'];
  for (const k of required) if (!map.has(k)) return null;
  return {
    sessions: map.get('sessions')!,
    users: map.get('users')!,
    page_views: map.get('page_views')!,
    engaged_sessions: map.get('engaged_sessions')!,
    engagement_rate: map.get('engagement_rate')!,
  };
}

// Thousand-separated integer formatting for plain-language counts.
function fmtCount(n: number): string {
  return Math.round(n).toLocaleString();
}

export async function buildTrafficSummary(clientId: string): Promise<ClientSummary> {
  const periods = await recentTrafficPeriods(clientId, 2);

  // No-data branch — honest absence.
  if (periods.length === 0) {
    return {
      headline: "We don't have traffic data for you yet.",
      bullets: [],
      callout: "Connect Google Analytics to see how people find and use your site.",
    };
  }

  const current = await loadTrafficRow(clientId, periods[0].id);
  if (!current) {
    return {
      headline: "We don't have traffic data for you yet.",
      bullets: [],
      callout: "Connect Google Analytics to see how people find and use your site.",
    };
  }

  // First-month branch — one period, no compare possible.
  if (periods.length === 1) {
    const engagementPct = Math.round(current.engagement_rate * 100);
    return {
      headline: "This is the first month we're tracking your site traffic.",
      bullets: [
        `${fmtCount(current.sessions)} visits from ${fmtCount(current.users)} people`,
        `${fmtCount(current.page_views)} page views`,
        `${engagementPct}% of visits were engaged`,
      ],
      callout: "Next month we'll show what changed.",
    };
  }

  // Two-period compare branch.
  const prior = await loadTrafficRow(clientId, periods[1].id);
  if (!prior) {
    // Prior period exists in the listing but has incomplete rows.
    // Degrade to first-month phrasing rather than lie about compare.
    const engagementPct = Math.round(current.engagement_rate * 100);
    return {
      headline: "This is the first full month we're tracking your site traffic.",
      bullets: [
        `${fmtCount(current.sessions)} visits from ${fmtCount(current.users)} people`,
        `${fmtCount(current.page_views)} page views`,
        `${engagementPct}% of visits were engaged`,
      ],
      callout: "Next month we'll show what changed.",
    };
  }

  // Slice 18d — compare logic is now shared with the narrator via
  // traffic-metrics.compareTraffic. Same 5% threshold, same driver
  // selection order, same flat detection. Behavior identical to the
  // inline version this replaced.
  const cmp = compareTraffic(current, prior);
  const engagementDelta = current.engagement_rate - prior.engagement_rate;

  let headline: string;
  switch (cmp.direction) {
    case 'up':
      headline = 'More people visited your site this month.';
      break;
    case 'down':
      headline = 'Fewer people visited your site this month.';
      break;
    case 'flat':
    default:
      headline = 'Site traffic held steady this month.';
      break;
  }

  const bullets: string[] = [];
  if (!cmp.sessions_flat && cmp.sessions_pct !== null) {
    const abs = Math.abs(cmp.sessions_delta);
    const label = cmp.sessions_delta > 0 ? 'more' : 'fewer';
    const dir = cmp.sessions_delta > 0 ? 'up' : 'down';
    bullets.push(
      `${fmtCount(abs)} ${label} visits than last month (${dir} ${Math.abs(Math.round(cmp.sessions_pct))}%)`
    );
  }
  if (!cmp.users_flat && cmp.users_pct !== null && bullets.length < 3) {
    const abs = Math.abs(cmp.users_delta);
    const label = cmp.users_delta > 0 ? 'more' : 'fewer';
    bullets.push(`${fmtCount(abs)} ${label} people`);
  }
  if (!cmp.page_views_flat && cmp.page_views_pct !== null && bullets.length < 3) {
    const abs = Math.abs(cmp.page_views_delta);
    const label = cmp.page_views_delta > 0 ? 'more' : 'fewer';
    bullets.push(`${fmtCount(abs)} ${label} page views`);
  }
  // When everything is flat, put one bullet with the steady totals
  // so the client sees the current numbers in plain view.
  if (bullets.length === 0) {
    bullets.push(
      `${fmtCount(current.sessions)} visits · ${fmtCount(current.users)} people · ${fmtCount(current.page_views)} page views`
    );
  }

  // Engagement callout — only if the move is ≥5 absolute percentage
  // points. Avoids firing on tiny jitter.
  let callout: string | null = null;
  if (prior.engagement_rate > 0 && Math.abs(engagementDelta) >= 0.05) {
    const curPct = Math.round(current.engagement_rate * 100);
    const priPct = Math.round(prior.engagement_rate * 100);
    if (engagementDelta > 0) {
      callout = `Visits were more engaged this month (${curPct}% vs ${priPct}% last month).`;
    } else {
      callout = `Visits were less engaged this month (${curPct}% vs ${priPct}% last month).`;
    }
  }

  return { headline, bullets, callout };
}

export async function buildInvoicesSummary(clientId: string): Promise<ClientSummary> {
  const invs = await loadClientVisibleInvoices(clientId);
  if (invs.length === 0) {
    return {
      headline: 'No invoices waiting right now.',
      bullets: [],
      callout: null,
    };
  }

  const todayIso = new Date().toISOString().split('T')[0];
  const overdue: InvoiceRow[] = [];
  const dueSoon: InvoiceRow[] = [];
  let unpaidCount = 0;

  for (const inv of invs) {
    const outstanding = inv.total - inv.amount_paid;
    if (outstanding <= 0) continue;
    unpaidCount += 1;
    if (inv.due_date && inv.due_date < todayIso) {
      overdue.push(inv);
    } else if (inv.due_date) {
      const dueMs = new Date(inv.due_date).getTime();
      const nowMs = new Date(todayIso).getTime();
      const days = Math.round((dueMs - nowMs) / 86400000);
      if (days <= 14) dueSoon.push(inv);
    }
  }

  if (unpaidCount === 0) {
    return {
      headline: `Everything's paid up.`,
      bullets: [`${plural(invs.length, 'invoice')} on file, all settled`],
      callout: null,
    };
  }

  let headline: string;
  if (overdue.length > 0 && dueSoon.length > 0) {
    headline = `You have ${plural(overdue.length, 'invoice')} past due and ${plural(
      dueSoon.length,
      'invoice'
    )} due soon.`;
  } else if (overdue.length > 0) {
    headline = `You have ${plural(overdue.length, 'invoice')} past due.`;
  } else if (dueSoon.length > 0) {
    headline = `You have ${plural(dueSoon.length, 'invoice')} due soon.`;
  } else {
    headline = `You have ${plural(unpaidCount, 'unpaid invoice')}.`;
  }

  const bullets: string[] = [];
  for (const inv of overdue.slice(0, 2)) {
    const outstanding = inv.total - inv.amount_paid;
    bullets.push(
      `$${outstanding.toFixed(0)} past due from ${friendlyMonthDay(inv.due_date!)}`
    );
  }
  for (const inv of dueSoon.slice(0, 2)) {
    if (bullets.length >= 3) break;
    const outstanding = inv.total - inv.amount_paid;
    bullets.push(
      `$${outstanding.toFixed(0)} due by ${friendlyMonthDay(inv.due_date!)}`
    );
  }

  const callout =
    overdue.length > 0
      ? 'Paying the overdue invoice is the fastest way to keep everything running smoothly.'
      : null;

  return { headline, bullets, callout };
}
