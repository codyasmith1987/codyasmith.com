// Client overview narrator — slice 1 of the client translation layer.
//
// One responsibility: produce a single plain-English sentence that
// answers "what is getting better?" for a specific client, honestly.
//
// Three branches:
//   - 'no_data'      → no snapshots exist for this client yet
//   - 'first_month'  → exactly one period has data; nothing to compare to
//   - 'comparative'  → two or more periods; pick the most honest delta
//
// Honesty rules (not polish rules):
//   1. If a signal's magnitude is below a documented threshold, it is
//      noise and does not qualify as "strong". Noise never wins.
//   2. If any strong signal is negative, lead with the biggest negative.
//      The product must not spin when the data is mixed.
//   3. If all signals are weak, say so plainly. "Steady" is not a
//      failure state; it is the truthful answer.
//   4. Health-issue changes count equally with ranking changes. If the
//      ranking story is flat and the cleaner truth is site health,
//      the cleaner truth wins.
//
// No SEO jargon, no tool labels, no "traffic/SERP/impressions/CTR".
// Reading level is enforced by the sentence templates themselves, not
// calculated at runtime.

import turso from './turso';
import { getContactsByRole } from './clients';
import {
  compareTraffic,
  type TrafficCompare,
  type TrafficDriver,
  type TrafficMetrics,
} from './traffic-metrics';

export type Confidence = 'comparative' | 'first_month' | 'no_data';

export interface VerdictResult {
  headline: string;
  confidence: Confidence;
  basis: Record<string, string | number>;
}

// Slice 3 result type. Same shape as VerdictResult so the page can
// render both identically from a narrator consumer's perspective.
export interface SlowdownResult {
  headline: string;
  source: 'ranking_drop' | 'more_issues' | 'traffic_drop' | 'current_issue' | 'none' | 'no_data';
  basis: Record<string, string | number>;
}

// --- Thresholds ---
// Below these magnitudes, a signal is noise. Tunable. Documented so
// future slices can justify changes.
const SIG_TOP3 = 3;   // gaining/losing 3+ top-3 placements is real
const SIG_PAGE1 = 5;  // gaining/losing 5+ page-1 placements is real
const SIG_ISSUES = 3; // 3+ fewer/new site issues is real

// --- DB helpers ---

interface Period {
  id: string;
  period_start: string;
}

async function recentPeriodsWithData(clientId: string, limit: number): Promise<Period[]> {
  // A period "has data" only if at least one snapshot table has rows
  // for (client, period). Empty placeholder periods are ignored.
  const r = await turso.execute({
    sql: `SELECT p.id, p.period_start
          FROM periods p
          WHERE p.client_id = ?
            AND (
              EXISTS (SELECT 1 FROM keyword_snapshots k WHERE k.period_id = p.id AND k.client_id = p.client_id)
              OR EXISTS (SELECT 1 FROM metric_snapshots m WHERE m.period_id = p.id AND m.client_id = p.client_id)
              OR EXISTS (SELECT 1 FROM issue_snapshots i WHERE i.period_id = p.id AND i.client_id = p.client_id)
            )
          ORDER BY p.period_start DESC
          LIMIT ?`,
    args: [clientId, limit],
  });
  return r.rows.map((row) => ({
    id: row[0] as string,
    period_start: row[1] as string,
  }));
}

async function getClientName(clientId: string): Promise<string> {
  const r = await turso.execute({
    sql: 'SELECT name FROM clients WHERE id = ?',
    args: [clientId],
  });
  return (r.rows[0]?.[0] as string) ?? 'this client';
}

interface KeywordSlice {
  total: number;
  top3: number;
  page1: number; // positions 4-10 (page-one-but-not-top-3)
}

async function loadKeywordSlice(clientId: string, periodId: string): Promise<KeywordSlice> {
  // Only position_tracking has reliable current-rank positions. The
  // keyword_research and keyword_suggestions sources track different
  // things (volume, difficulty) and their position values are from a
  // different context. Using one source keeps the comparison honest.
  const r = await turso.execute({
    sql: `SELECT position FROM keyword_snapshots
          WHERE client_id = ? AND period_id = ?
            AND source = 'position_tracking'
            AND position IS NOT NULL`,
    args: [clientId, periodId],
  });
  let top3 = 0;
  let page1 = 0;
  let total = 0;
  for (const row of r.rows) {
    const pos = Number(row[0]);
    total++;
    if (pos <= 3) top3++;
    else if (pos <= 10) page1++;
  }
  return { total, top3, page1 };
}

// Slice 18d — narrator-scoped traffic loader. Returns the full
// TrafficMetrics shape (all 5 keys) if every key is present for
// the (client, period) pair, null otherwise. Matches the partial-
// rejection rule used by Slice 18c so we never feed half a row
// into the compare.
async function loadNarratorTraffic(
  clientId: string,
  periodId: string
): Promise<TrafficMetrics | null> {
  const r = await turso.execute({
    sql: `SELECT metric_key, metric_value FROM metric_snapshots
          WHERE client_id = ? AND period_id = ? AND category = 'traffic'`,
    args: [clientId, periodId],
  });
  if (r.rows.length === 0) return null;
  const map = new Map<string, number>();
  for (const row of r.rows) map.set(row[0] as string, Number(row[1] ?? 0));
  const needed = ['sessions', 'users', 'page_views', 'engaged_sessions', 'engagement_rate'];
  for (const k of needed) if (!map.has(k)) return null;
  return {
    sessions: map.get('sessions')!,
    users: map.get('users')!,
    page_views: map.get('page_views')!,
    engaged_sessions: map.get('engaged_sessions')!,
    engagement_rate: map.get('engagement_rate')!,
  };
}

async function loadHealthIssueCount(clientId: string, periodId: string): Promise<number | null> {
  const r = await turso.execute({
    sql: `SELECT metric_value FROM metric_snapshots
          WHERE client_id = ? AND period_id = ?
            AND category = 'health' AND metric_key = 'total_issues'`,
    args: [clientId, periodId],
  });
  if (r.rows.length === 0) return null;
  return Number(r.rows[0][0]);
}

// --- Signal ranking ---

export type FactKind = 'top3' | 'page1' | 'health' | 'traffic';

interface Fact {
  kind: FactKind;
  delta: number;      // signed; positive = improvement for the client
  magnitude: number;  // abs(delta)
  isStrong: boolean;
  direction: 'positive' | 'negative';
  // Slice 18d: only populated when kind === 'traffic'. Tells the
  // render templates which metric (visits / people / page views)
  // drove the direction so the plain-language sentence uses the
  // right noun. The delta/magnitude above hold the signed + absolute
  // counts of this driving metric specifically.
  traffic_driver?: TrafficDriver;
}

function buildFacts(
  cur: { keyword: KeywordSlice; health: number | null; traffic: TrafficMetrics | null },
  prior: { keyword: KeywordSlice; health: number | null; traffic: TrafficMetrics | null }
): Fact[] {
  const facts: Fact[] = [];

  const dTop3 = cur.keyword.top3 - prior.keyword.top3;
  if (dTop3 !== 0) {
    facts.push({
      kind: 'top3',
      delta: dTop3,
      magnitude: Math.abs(dTop3),
      isStrong: Math.abs(dTop3) >= SIG_TOP3,
      direction: dTop3 > 0 ? 'positive' : 'negative',
    });
  }

  const dPage1 = cur.keyword.page1 - prior.keyword.page1;
  if (dPage1 !== 0) {
    facts.push({
      kind: 'page1',
      delta: dPage1,
      magnitude: Math.abs(dPage1),
      isStrong: Math.abs(dPage1) >= SIG_PAGE1,
      direction: dPage1 > 0 ? 'positive' : 'negative',
    });
  }

  if (cur.health !== null && prior.health !== null) {
    // Fewer issues is better. Flip so positive = improvement.
    const dIssues = prior.health - cur.health;
    if (dIssues !== 0) {
      facts.push({
        kind: 'health',
        delta: dIssues,
        magnitude: Math.abs(dIssues),
        isStrong: Math.abs(dIssues) >= SIG_ISSUES,
        direction: dIssues > 0 ? 'positive' : 'negative',
      });
    }
  }

  // Slice 18d — traffic fact. Eligible only when two full traffic
  // rows exist AND compareTraffic chose a driving metric (i.e. at
  // least one of sessions/users/page_views moved ≥5% with prior>0).
  // A flat compare yields driver=null and produces no fact, so the
  // narrator falls back to ranking/issue facts only — same as the
  // pre-Slice-18d behavior for every client without GA4.
  if (cur.traffic && prior.traffic) {
    const cmp = compareTraffic(cur.traffic, prior.traffic);
    if (cmp.driver !== null && cmp.direction !== 'flat') {
      facts.push({
        kind: 'traffic',
        delta: cmp.driver_delta,
        magnitude: Math.abs(cmp.driver_delta),
        isStrong: true, // the 5% gate inside compareTraffic is the strength gate
        direction: cmp.direction === 'up' ? 'positive' : 'negative',
        traffic_driver: cmp.driver,
      });
    }
  }

  return facts;
}

function pickWinner(facts: Fact[]): Fact | null {
  const strong = facts.filter((f) => f.isStrong);
  if (strong.length === 0) return null;

  // No spin rule: lead with any strong negative first.
  const negatives = strong.filter((f) => f.direction === 'negative');
  if (negatives.length > 0) {
    negatives.sort((a, b) => b.magnitude - a.magnitude);
    return negatives[0];
  }
  // All strong facts are positive. Pick the largest by raw magnitude.
  // Ties break by kind order: health > top3 > page1 > traffic —
  // site-cleaner stories tend to be the cleaner truth when present,
  // and the user explicitly said not to overfit to rankings language
  // when health is the honest signal. Traffic is last in the
  // tiebreak (not because it's least important, but because at equal
  // raw magnitudes the existing signals are the cleaner story —
  // traffic almost always wins via pure magnitude, not tiebreak).
  const order: Record<FactKind, number> = { health: 0, top3: 1, page1: 2, traffic: 3 };
  const sorted = [...strong].sort((a, b) => {
    if (b.magnitude !== a.magnitude) return b.magnitude - a.magnitude;
    return order[a.kind] - order[b.kind];
  });
  return sorted[0];
}

// --- Sentence templates ---
// Templates are held as constants so the reading level is auditable at
// a glance. Each reads at roughly a 7th-grade level: short clauses,
// common words, no jargon, no passive voice where avoidable.

// English plurals for the specific words this narrator uses. Keeping it
// local and explicit is safer than pulling in an inflector library for
// three words. Extend only when a new word shows up in a template.
function plural(n: number, singular: string): string {
  if (n === 1) return singular;
  const irregular: Record<string, string> = {
    search: 'searches',
    thing: 'things',
  };
  return irregular[singular] ?? `${singular}s`;
}

function renderFactSentence(fact: Fact): string {
  const n = fact.magnitude;
  switch (fact.kind) {
    case 'top3':
      return fact.direction === 'positive'
        ? `${n} more ${plural(n, 'search')} now bring${n === 1 ? 's' : ''} people to your site first.`
        : `${n} fewer ${plural(n, 'search')} bring people to your site first this month.`;
    case 'page1':
      return fact.direction === 'positive'
        ? `${n} more ${plural(n, 'search')} now show your site on the front page.`
        : `${n} fewer ${plural(n, 'search')} show your site on the front page this month.`;
    case 'health':
      return fact.direction === 'positive'
        ? `Your site got cleaner this month. ${n} fewer ${plural(n, 'thing')} to fix.`
        : `Your site has ${n} new ${plural(n, 'thing')} slowing it down this month.`;
    case 'traffic': {
      const driver = fact.traffic_driver ?? 'sessions';
      if (fact.direction === 'positive') {
        if (driver === 'sessions') {
          return n === 1
            ? `1 more visit came to your site this month.`
            : `${n.toLocaleString()} more visits came to your site this month.`;
        }
        if (driver === 'users') {
          return n === 1
            ? `1 more person visited your site this month.`
            : `${n.toLocaleString()} more people visited your site this month.`;
        }
        // page_views
        return n === 1
          ? `1 more page view this month.`
          : `${n.toLocaleString()} more page views this month.`;
      }
      // negative
      if (driver === 'sessions') {
        return n === 1
          ? `1 fewer visit came to your site this month.`
          : `${n.toLocaleString()} fewer visits came to your site this month.`;
      }
      if (driver === 'users') {
        return n === 1
          ? `1 fewer person visited your site this month.`
          : `${n.toLocaleString()} fewer people visited your site this month.`;
      }
      // page_views
      return n === 1
        ? `1 fewer page view this month.`
        : `${n.toLocaleString()} fewer page views this month.`;
    }
  }
}

// --- Public entry point ---

export async function generateOverviewVerdict(clientId: string): Promise<VerdictResult> {
  const [name, periods] = await Promise.all([
    getClientName(clientId),
    recentPeriodsWithData(clientId, 2),
  ]);

  if (periods.length === 0) {
    return {
      headline: `We don't have data on where ${name} shows up in search yet.`,
      confidence: 'no_data',
      basis: { periods_with_data: 0 },
    };
  }

  if (periods.length === 1) {
    return {
      headline: `This is the first month we have data for ${name}. Next month we'll show you what changed.`,
      confidence: 'first_month',
      basis: {
        periods_with_data: 1,
        period_start: periods[0].period_start,
      },
    };
  }

  const [curPeriod, priorPeriod] = periods;
  const [curKw, priorKw, curHealth, priorHealth, curTraffic, priorTraffic] = await Promise.all([
    loadKeywordSlice(clientId, curPeriod.id),
    loadKeywordSlice(clientId, priorPeriod.id),
    loadHealthIssueCount(clientId, curPeriod.id),
    loadHealthIssueCount(clientId, priorPeriod.id),
    loadNarratorTraffic(clientId, curPeriod.id),
    loadNarratorTraffic(clientId, priorPeriod.id),
  ]);

  const facts = buildFacts(
    { keyword: curKw, health: curHealth, traffic: curTraffic },
    { keyword: priorKw, health: priorHealth, traffic: priorTraffic }
  );
  const winner = pickWinner(facts);

  const basis: Record<string, string | number> = {
    periods_with_data: 2,
    current_period: curPeriod.period_start,
    prior_period: priorPeriod.period_start,
    current_top3: curKw.top3,
    prior_top3: priorKw.top3,
    current_page1: curKw.page1,
    prior_page1: priorKw.page1,
    current_health: curHealth ?? -1,
    prior_health: priorHealth ?? -1,
    strong_facts: facts.filter((f) => f.isStrong).length,
  };

  if (!winner) {
    return {
      headline: `Things look steady this month. No big change yet, but we're watching what moves next.`,
      confidence: 'comparative',
      basis,
    };
  }

  return {
    headline: renderFactSentence(winner),
    confidence: 'comparative',
    basis: {
      ...basis,
      winning_fact: winner.kind,
      winning_delta: winner.delta,
      winning_direction: winner.direction,
    },
  };
}

// ════════════════════════════════════════════════════════════════════
// Slice 3: "what is slowing growth right now?"
// ════════════════════════════════════════════════════════════════════
//
// Second server-rendered sentence on the client dashboard. Picks the
// single most honest negative signal:
//
//   1. If a strong negative ranking delta exists (and it isn't the
//      fact slice 1 already rendered), lead with it.
//   2. Otherwise, if the current period has a translatable site issue,
//      lead with the highest-consequence one (priority tier first,
//      affected_urls second).
//   3. Otherwise, say plainly that nothing major is slowing the client
//      down right now.
//
// Same judgment rules as slice 1: no spin, no piling on, no flashy
// ranking language when the cleaner truth is a broken internal link.

// --- Translated issue library ---
//
// Each entry is a function that returns a complete, grammatically clean
// clause for any N. Singular/plural handled explicitly. Entries collapse
// multiple raw tool issues (e.g., all four H2 variants, all three
// security header issues) into one plain clause because a client does
// not care which specific tool-label produced the finding.
//
// If a raw issue_name is not in this map, slice 3 will silently skip it
// and fall through to the next-ranked translatable issue. Slice 3 never
// names an issue it cannot render plainly.

type IssueClause = (n: number) => string;

const TRANSLATED_ISSUES: Record<string, IssueClause> = {
  'Response Codes: Internal Client Error (4xx)': (n) =>
    n === 1
      ? `1 broken link on your pages is leading visitors to a dead end`
      : `${n} broken links on your pages are leading visitors to dead ends`,
  'Response Codes: External Client Error (4xx)': (n) =>
    n === 1
      ? `1 link on your pages points to a site that no longer exists`
      : `${n} links on your pages point to sites that no longer exist`,

  'Meta Description: Missing': (n) =>
    n === 1
      ? `1 page is missing its short search description`
      : `${n} pages are missing their short search description`,
  'Meta Description: Duplicate': (n) => `${n} pages share the same short search description`,
  'Meta Description: Below 70 Characters': (n) =>
    n === 1
      ? `1 page has a search description that is too short`
      : `${n} pages have search descriptions that are too short`,

  'Page Titles: Missing': (n) =>
    n === 1 ? `1 page has no title at all` : `${n} pages have no title at all`,
  'Page Titles: Duplicate': (n) => `${n} pages share the same title`,
  'Page Titles: Below 30 Characters': (n) =>
    n === 1
      ? `1 page has a title too short to show well in search`
      : `${n} pages have titles too short to show well in search`,
  'Page Titles: Below 200 Pixels': (n) =>
    n === 1
      ? `1 page has a title too short to show well in search`
      : `${n} pages have titles too short to show well in search`,

  'H1: Missing': (n) =>
    n === 1 ? `1 page has no main heading` : `${n} pages have no main heading`,
  'H1: Multiple': (n) =>
    n === 1
      ? `1 page has more than one main heading`
      : `${n} pages have more than one main heading`,
  'H1: Duplicate': (n) => `${n} pages share the same main heading`,
  'H2: Missing': (n) =>
    n === 1 ? `1 page has sub-headings out of order or repeated` : `${n} pages have sub-headings out of order or repeated`,
  'H2: Multiple': (n) =>
    n === 1 ? `1 page has sub-headings out of order or repeated` : `${n} pages have sub-headings out of order or repeated`,
  'H2: Duplicate': (n) =>
    n === 1 ? `1 page has sub-headings out of order or repeated` : `${n} pages have sub-headings out of order or repeated`,
  'H2: Non-Sequential': (n) =>
    n === 1 ? `1 page has sub-headings out of order or repeated` : `${n} pages have sub-headings out of order or repeated`,

  'Images: Missing Alt Text': (n) =>
    n === 1
      ? `1 image has no description for screen readers`
      : `${n} images have no description for screen readers`,
  'Images: Over 100 KB': (n) =>
    n === 1
      ? `1 image is large enough to slow the site down`
      : `${n} images are large enough to slow the site down`,
  'Images: Alt Text Over 100 Characters': (n) =>
    n === 1
      ? `1 image description is too long to be useful`
      : `${n} image descriptions are too long to be useful`,

  'Links: Internal Outlinks With No Anchor Text': (n) =>
    n === 1
      ? `1 link on your site has no readable text`
      : `${n} links on your site have no readable text`,
  'Links: Non-Descriptive Anchor Text In Internal Outlinks': (n) =>
    n === 1
      ? `1 link on your site does not describe where it goes`
      : `${n} links on your site do not describe where they go`,

  // All three security header issues collapse to one plain clause.
  // Clients do not need to know which specific header is missing —
  // naming the header is tool-speak.
  'Security: Missing Content-Security-Policy Header': () =>
    `your site is missing a security setting that helps protect visitors`,
  'Security: Missing HSTS Header': () =>
    `your site is missing a security setting that helps protect visitors`,
  'Security: Missing Secure Referrer-Policy Header': () =>
    `your site is missing a security setting that helps protect visitors`,

  'Content: Low Content Pages': (n) =>
    n === 1
      ? `1 page has very little content on it`
      : `${n} pages have very little content on them`,
};

interface IssueRow {
  issue_name: string;
  priority: string | null;
  affected_urls: number | null;
  pct_of_total: number | null;
}

async function loadRankedIssues(clientId: string, periodId: string): Promise<IssueRow[]> {
  // Priority tier (critical > high > medium > low > unknown) sorted by
  // the tool's own severity assessment, then by affected_urls so the
  // more widespread issue wins within a tier, then pct_of_total and
  // issue_name for determinism.
  const r = await turso.execute({
    sql: `SELECT issue_name, priority, affected_urls, pct_of_total
          FROM issue_snapshots
          WHERE client_id = ? AND period_id = ?
          ORDER BY
            CASE LOWER(COALESCE(priority, ''))
              WHEN 'critical' THEN 0
              WHEN 'high' THEN 1
              WHEN 'medium' THEN 2
              WHEN 'low' THEN 3
              ELSE 4
            END,
            COALESCE(affected_urls, 0) DESC,
            COALESCE(pct_of_total, 0) DESC,
            issue_name ASC`,
    args: [clientId, periodId],
  });
  return r.rows.map((row) => ({
    issue_name: row[0] as string,
    priority: row[1] as string | null,
    affected_urls: row[2] === null ? null : Number(row[2]),
    pct_of_total: row[3] === null ? null : Number(row[3]),
  }));
}

function renderIssueSentence(row: IssueRow): string | null {
  const translator = TRANSLATED_ISSUES[row.issue_name];
  if (!translator) return null;
  const n = row.affected_urls ?? 0;
  if (n < 1) return null;
  const clause = translator(n);
  return `${clause.charAt(0).toUpperCase()}${clause.slice(1)}. That's the main thing slowing you down right now.`;
}

// --- Negative ranking sentence templates ---
// These differ from slice 1's — slice 3 frames negatives as "the biggest
// drop" rather than "N fewer searches". Separation keeps the two
// sentences feeling like distinct observations, not echoes.

function renderNegativeRankingSentence(fact: Fact): string {
  const n = fact.magnitude;
  switch (fact.kind) {
    case 'top3':
      return `The biggest drop this month: ${n} fewer ${plural(n, 'search')} now bring people to your site first.`;
    case 'page1':
      return `The biggest drop this month: ${n} fewer ${plural(n, 'search')} now show your site on the front page.`;
    case 'health':
      return `Your site picked up ${n} new ${plural(n, 'thing')} slowing it down this month. That's the main thing slowing you down right now.`;
    case 'traffic': {
      // Driver-specific plain-language phrasing. Keeps voice aligned
      // with the Slice 18c ClientSummary so the two surfaces don't
      // contradict each other.
      const driver = fact.traffic_driver ?? 'sessions';
      if (driver === 'sessions') {
        return n === 1
          ? `The biggest drop this month: 1 fewer visit came to your site.`
          : `The biggest drop this month: ${n.toLocaleString()} fewer visits came to your site.`;
      }
      if (driver === 'users') {
        return n === 1
          ? `The biggest drop this month: 1 fewer person visited your site.`
          : `The biggest drop this month: ${n.toLocaleString()} fewer people visited your site.`;
      }
      // page_views
      return n === 1
        ? `The biggest drop this month: 1 fewer page view.`
        : `The biggest drop this month: ${n.toLocaleString()} fewer page views.`;
    }
  }
}

// --- Public entry point ---

export async function generateSlowdownVerdict(
  clientId: string,
  options: { excludeFactKind?: FactKind } = {}
): Promise<SlowdownResult> {
  const periods = await recentPeriodsWithData(clientId, 2);

  if (periods.length === 0) {
    return {
      headline: `We don't have enough yet to spot what's slowing you down.`,
      source: 'no_data',
      basis: { periods_with_data: 0 },
    };
  }

  const curPeriod = periods[0];
  const priorPeriod = periods[1] ?? null;

  // Branch A: if we have a prior period, look for a strong negative
  // ranking or health delta that slice 1 did not already render.
  if (priorPeriod) {
    const [curKw, priorKw, curHealth, priorHealth, curTraffic, priorTraffic] = await Promise.all([
      loadKeywordSlice(clientId, curPeriod.id),
      loadKeywordSlice(clientId, priorPeriod.id),
      loadHealthIssueCount(clientId, curPeriod.id),
      loadHealthIssueCount(clientId, priorPeriod.id),
      loadNarratorTraffic(clientId, curPeriod.id),
      loadNarratorTraffic(clientId, priorPeriod.id),
    ]);
    const facts = buildFacts(
      { keyword: curKw, health: curHealth, traffic: curTraffic },
      { keyword: priorKw, health: priorHealth, traffic: priorTraffic }
    );
    const negatives = facts
      .filter((f) => f.direction === 'negative' && f.isStrong)
      .filter((f) => f.kind !== options.excludeFactKind)
      .sort((a, b) => b.magnitude - a.magnitude);

    if (negatives.length > 0) {
      const winner = negatives[0];
      let source: SlowdownResult['source'];
      if (winner.kind === 'health') source = 'more_issues';
      else if (winner.kind === 'traffic') source = 'traffic_drop';
      else source = 'ranking_drop';
      return {
        headline: renderNegativeRankingSentence(winner),
        source,
        basis: {
          periods_with_data: 2,
          current_period: curPeriod.period_start,
          prior_period: priorPeriod.period_start,
          winning_fact: winner.kind,
          winning_magnitude: winner.magnitude,
          excluded: options.excludeFactKind ?? '',
        },
      };
    }
  }

  // Branch B: fall through to current-period issue rank. This fires in
  // first_month mode and also whenever there's no strong negative delta
  // to lead with.
  const issues = await loadRankedIssues(clientId, curPeriod.id);
  let winningRow: IssueRow | null = null;
  let winningSentence: string | null = null;
  for (const row of issues) {
    const sentence = renderIssueSentence(row);
    if (sentence) {
      winningRow = row;
      winningSentence = sentence;
      break;
    }
  }

  if (winningSentence && winningRow) {
    return {
      headline: winningSentence,
      source: 'current_issue',
      basis: {
        periods_with_data: priorPeriod ? 2 : 1,
        current_period: curPeriod.period_start,
        issue_name: winningRow.issue_name,
        issue_priority: winningRow.priority ?? '',
        issue_affected_urls: winningRow.affected_urls ?? 0,
      },
    };
  }

  // Branch C: nothing honest to flag. Do not invent friction.
  return {
    headline: `Nothing major is slowing you down right now.`,
    source: 'none',
    basis: {
      periods_with_data: priorPeriod ? 2 : 1,
      current_period: curPeriod.period_start,
      issues_considered: issues.length,
    },
  };
}

// ════════════════════════════════════════════════════════════════════
// Slice 4: "what is happening now?"
// ════════════════════════════════════════════════════════════════════
//
// Third server-rendered sentence on the client dashboard. Tells the
// client what is actively being worked on right now, or — when there
// is no real delivery activity — the most honest present-tense fact
// about what the system is currently tracking or when the latest data
// came in.
//
// Hard rule: a provisioned project shell row (no milestones, no tasks,
// no recent updates) is NEVER treated as "active work". This is the
// single most important honesty constraint in the entire slice. The
// probes below only consider rows in tasks/milestones with
// client_visible = 1 AND a real recent timestamp.
//
// Priority ladder:
//   1. real recent client-visible completed task
//   2. real recent client-visible active task
//   3. real recent client-visible completed milestone
//   4. latest applied import + current position_tracking count
//   5. stale-refresh warning (31–90 days)
//   6. no-data fallback

const ACTIVE_WINDOW_DAYS = 14;
const STALE_REFRESH_DAYS = 30;
const VERY_STALE_REFRESH_DAYS = 90;

export interface NowResult {
  headline: string;
  source:
    | 'completed_task'
    | 'active_task'
    | 'completed_milestone'
    | 'recent_refresh'
    | 'stale_refresh'
    | 'no_data';
  basis: Record<string, string | number>;
}

interface TaskHit {
  id: string;
  label: string;
  completed_at: string | null;
  updated_at: string;
}

interface MilestoneHit {
  id: string;
  label: string;
  completed_at: string;
}

async function loadRecentCompletedTask(clientId: string): Promise<TaskHit | null> {
  const r = await turso.execute({
    sql: `SELECT t.id, t.title, t.client_update_text, t.completed_at, t.updated_at
          FROM tasks t
          JOIN milestones m ON m.id = t.milestone_id
          JOIN projects p ON p.id = m.project_id
          WHERE p.client_id = ?
            AND t.client_visible = 1
            AND t.completed_at IS NOT NULL
            AND t.completed_at >= datetime('now', '-' || ? || ' days')
          ORDER BY t.completed_at DESC
          LIMIT 1`,
    args: [clientId, ACTIVE_WINDOW_DAYS],
  });
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  const title = row[1] as string;
  const clientCopy = row[2] as string | null;
  return {
    id: row[0] as string,
    label: (clientCopy && clientCopy.trim()) || title,
    completed_at: row[3] as string,
    updated_at: row[4] as string,
  };
}

async function loadInProgressTask(clientId: string): Promise<TaskHit | null> {
  const r = await turso.execute({
    sql: `SELECT t.id, t.title, t.client_update_text, t.completed_at, t.updated_at
          FROM tasks t
          JOIN milestones m ON m.id = t.milestone_id
          JOIN projects p ON p.id = m.project_id
          WHERE p.client_id = ?
            AND t.client_visible = 1
            AND t.status = 'in_progress'
            AND t.updated_at >= datetime('now', '-' || ? || ' days')
          ORDER BY t.updated_at DESC
          LIMIT 1`,
    args: [clientId, ACTIVE_WINDOW_DAYS],
  });
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  const title = row[1] as string;
  const clientCopy = row[2] as string | null;
  return {
    id: row[0] as string,
    label: (clientCopy && clientCopy.trim()) || title,
    completed_at: row[3] as string | null,
    updated_at: row[4] as string,
  };
}

async function loadRecentCompletedMilestone(clientId: string): Promise<MilestoneHit | null> {
  const r = await turso.execute({
    sql: `SELECT m.id, m.title, m.client_update_text, m.completed_at
          FROM milestones m
          JOIN projects p ON p.id = m.project_id
          WHERE p.client_id = ?
            AND m.client_visible = 1
            AND m.completed_at IS NOT NULL
            AND m.completed_at >= datetime('now', '-' || ? || ' days')
          ORDER BY m.completed_at DESC
          LIMIT 1`,
    args: [clientId, ACTIVE_WINDOW_DAYS],
  });
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  const title = row[1] as string;
  const clientCopy = row[2] as string | null;
  return {
    id: row[0] as string,
    label: (clientCopy && clientCopy.trim()) || title,
    completed_at: row[3] as string,
  };
}

async function loadLatestAppliedImportFinishedAt(clientId: string): Promise<string | null> {
  const r = await turso.execute({
    sql: `SELECT finished_at FROM imports
          WHERE client_id = ? AND status = 'applied' AND finished_at IS NOT NULL
          ORDER BY finished_at DESC
          LIMIT 1`,
    args: [clientId],
  });
  if (r.rows.length === 0) return null;
  return r.rows[0][0] as string;
}

async function loadCurrentPositionTrackingCount(clientId: string): Promise<number> {
  const periods = await recentPeriodsWithData(clientId, 1);
  if (periods.length === 0) return 0;
  const r = await turso.execute({
    sql: `SELECT COUNT(*) FROM keyword_snapshots
          WHERE client_id = ? AND period_id = ? AND source = 'position_tracking'`,
    args: [clientId, periods[0].id],
  });
  return Number(r.rows[0][0]);
}

// UTC-only. Produces "April 11" when the ISO date's year matches now's
// UTC year, otherwise "April 11, 2025". Never renders a time. Never
// leaks the raw ISO string.
function formatFriendlyDate(iso: string, now: Date = new Date()): string {
  // SQLite returns "YYYY-MM-DD HH:MM:SS" for datetime() without a T.
  // Normalize by replacing the space before parsing.
  const normalized = iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z';
  const d = new Date(normalized);
  if (isNaN(d.getTime())) return iso;
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const monthName = months[d.getUTCMonth()];
  const day = d.getUTCDate();
  const year = d.getUTCFullYear();
  if (year === now.getUTCFullYear()) return `${monthName} ${day}`;
  return `${monthName} ${day}, ${year}`;
}

function daysSinceUtc(iso: string, now: Date = new Date()): number {
  const normalized = iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z';
  const d = new Date(normalized);
  if (isNaN(d.getTime())) return Number.MAX_SAFE_INTEGER;
  const msPerDay = 86400000;
  const a = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const b = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((b - a) / msPerDay);
}

// --- Public entry point ---

export async function generateNowVerdict(clientId: string): Promise<NowResult> {
  // Branch 1: recently completed client-visible task beats everything.
  const completedTask = await loadRecentCompletedTask(clientId);
  if (completedTask) {
    return {
      headline: `We just finished ${completedTask.label} for you.`,
      source: 'completed_task',
      basis: {
        task_id: completedTask.id,
        label: completedTask.label,
        completed_at: completedTask.completed_at ?? '',
      },
    };
  }

  // Branch 2: active in-progress task with recent updated_at.
  const inProgressTask = await loadInProgressTask(clientId);
  if (inProgressTask) {
    return {
      headline: `We're working on ${inProgressTask.label} right now.`,
      source: 'active_task',
      basis: {
        task_id: inProgressTask.id,
        label: inProgressTask.label,
        updated_at: inProgressTask.updated_at,
      },
    };
  }

  // Branch 3: recently completed client-visible milestone.
  const completedMilestone = await loadRecentCompletedMilestone(clientId);
  if (completedMilestone) {
    return {
      headline: `We just wrapped up ${completedMilestone.label} for you.`,
      source: 'completed_milestone',
      basis: {
        milestone_id: completedMilestone.id,
        label: completedMilestone.label,
        completed_at: completedMilestone.completed_at,
      },
    };
  }

  // Branch 4/5/6: fall through to import freshness. Project rows with no
  // real children NEVER qualify as a signal. If we're here, there is no
  // real delivery activity to report.
  const latestFinishedAt = await loadLatestAppliedImportFinishedAt(clientId);
  const name = await getClientName(clientId);

  if (!latestFinishedAt) {
    return {
      headline: `We don't have recent site data for ${name} yet.`,
      source: 'no_data',
      basis: { has_applied_import: 0 },
    };
  }

  const daysAgo = daysSinceUtc(latestFinishedAt);

  // Branch 6 (very stale): treat as no_data for messaging purposes.
  if (daysAgo > VERY_STALE_REFRESH_DAYS) {
    return {
      headline: `We don't have recent site data for ${name} yet.`,
      source: 'no_data',
      basis: {
        has_applied_import: 1,
        days_since_refresh: daysAgo,
      },
    };
  }

  const dateLabel = formatFriendlyDate(latestFinishedAt);

  // Branch 5: stale refresh (31–90 days).
  if (daysAgo > STALE_REFRESH_DAYS) {
    return {
      headline: `Your latest site data is from ${dateLabel} — it's time for a fresh upload.`,
      source: 'stale_refresh',
      basis: {
        days_since_refresh: daysAgo,
        latest_finished_at: latestFinishedAt,
      },
    };
  }

  // Branch 4: recent refresh. Include tracked count when > 0.
  const trackedCount = await loadCurrentPositionTrackingCount(clientId);
  if (trackedCount > 0) {
    return {
      headline: `Your latest site data came in on ${dateLabel}, and we're tracking ${trackedCount} ${plural(trackedCount, 'search')} for you right now.`,
      source: 'recent_refresh',
      basis: {
        days_since_refresh: daysAgo,
        latest_finished_at: latestFinishedAt,
        tracked_count: trackedCount,
      },
    };
  }

  return {
    headline: `Your latest site data came in on ${dateLabel}.`,
    source: 'recent_refresh',
    basis: {
      days_since_refresh: daysAgo,
      latest_finished_at: latestFinishedAt,
      tracked_count: 0,
    },
  };
}

// ════════════════════════════════════════════════════════════════════
// Slice 5: "what do I need to know?"
// ════════════════════════════════════════════════════════════════════
//
// Fourth server-rendered sentence on the client dashboard. Surfaces the
// single most time-sensitive client-facing fact. When nothing real is
// waiting on the client, the narrator says so plainly instead of
// inventing urgency.
//
// Hard rules:
//   1. Draft invoices are admin work, not client truth. Never surfaced.
//   2. Notifications must join to their target entity and the target
//      must exist AND be in a client-appropriate state. This prevents
//      test pollution or deleted records from producing client-facing
//      lies.
//   3. No fake urgency. No filler. If the honest answer is "nothing",
//      the sentence is exactly "Nothing is waiting on you right now."
//
// Priority ladder (first match wins):
//   1. overdue sent invoice with unpaid balance
//   2. sent invoice due within the next 14 days
//   3. pending approval waiting on the client
//   4. recent real client-facing notification pointing at a live,
//      non-draft entity — created within the last 14 days
//   5. fallback: nothing is waiting on you right now

const DUE_SOON_WINDOW_DAYS = 14;
const NOTIFICATION_FRESHNESS_DAYS = 14;

export interface NeedToKnowResult {
  headline: string;
  source:
    | 'overdue_invoice'
    | 'due_soon_invoice'
    | 'pending_approval'
    | 'recent_notification'
    | 'none';
  basis: Record<string, string | number>;
}

interface InvoiceHit {
  id: string;
  invoice_number: string;
  total: number;
  amount_paid: number;
  due_date: string;
}

async function loadOverdueInvoice(clientId: string): Promise<InvoiceHit | null> {
  const r = await turso.execute({
    sql: `SELECT id, invoice_number, total, amount_paid, due_date
          FROM invoices
          WHERE client_id = ?
            AND status = 'sent'
            AND due_date < date('now')
            AND amount_paid < total
          ORDER BY due_date ASC
          LIMIT 1`,
    args: [clientId],
  });
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    id: row[0] as string,
    invoice_number: row[1] as string,
    total: Number(row[2]),
    amount_paid: Number(row[3]),
    due_date: row[4] as string,
  };
}

async function loadDueSoonInvoice(clientId: string): Promise<InvoiceHit | null> {
  const r = await turso.execute({
    sql: `SELECT id, invoice_number, total, amount_paid, due_date
          FROM invoices
          WHERE client_id = ?
            AND status = 'sent'
            AND due_date >= date('now')
            AND due_date <= date('now', '+' || ? || ' days')
            AND amount_paid < total
          ORDER BY due_date ASC
          LIMIT 1`,
    args: [clientId, DUE_SOON_WINDOW_DAYS],
  });
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    id: row[0] as string,
    invoice_number: row[1] as string,
    total: Number(row[2]),
    amount_paid: Number(row[3]),
    due_date: row[4] as string,
  };
}

interface ApprovalHit {
  id: string;
  title: string;
}

async function loadPendingApproval(clientId: string): Promise<ApprovalHit | null> {
  const r = await turso.execute({
    sql: `SELECT a.id, a.title
          FROM approvals a
          JOIN contracts co ON co.id = a.contract_id
          WHERE co.client_id = ?
            AND a.status = 'pending'
          ORDER BY a.created_at ASC
          LIMIT 1`,
    args: [clientId],
  });
  if (r.rows.length === 0) return null;
  return {
    id: r.rows[0][0] as string,
    title: r.rows[0][1] as string,
  };
}

interface NotificationHit {
  id: string;
  type: string;
  entity_type: string | null;
  entity_id: string | null;
}

async function loadRecentClientFacingNotification(
  clientId: string
): Promise<NotificationHit | null> {
  // Only consider notifications that point at a real, present entity
  // in a client-appropriate state. This filters out:
  //   - notifications whose entity was deleted (test pollution)
  //   - notifications whose entity is a draft invoice (admin work)
  //   - notifications referencing approvals no longer pending
  //
  // Notification types considered: invoice_sent (must join to a non-
  // draft invoice belonging to this client), milestone_completed
  // (must join to a client_visible milestone), task_completed
  // (must join to a client_visible task).
  const r = await turso.execute({
    sql: `SELECT n.id, n.type, n.entity_type, n.entity_id
          FROM notifications n
          JOIN users u ON u.id = n.user_id
          WHERE u.client_id = ?
            AND n.created_at >= datetime('now', '-' || ? || ' days')
            AND (
              (n.type = 'invoice_sent'
               AND n.entity_type = 'invoice'
               AND EXISTS (
                 SELECT 1 FROM invoices i
                 WHERE i.id = n.entity_id
                   AND i.client_id = u.client_id
                   AND i.status != 'draft'
                   AND i.status != 'cancelled'
               ))
              OR
              (n.type = 'milestone_completed'
               AND n.entity_type = 'milestone'
               AND EXISTS (
                 SELECT 1 FROM milestones m
                 JOIN projects p ON p.id = m.project_id
                 WHERE m.id = n.entity_id
                   AND p.client_id = u.client_id
                   AND m.client_visible = 1
               ))
              OR
              (n.type = 'task_completed'
               AND n.entity_type = 'task'
               AND EXISTS (
                 SELECT 1 FROM tasks t
                 JOIN milestones m ON m.id = t.milestone_id
                 JOIN projects p ON p.id = m.project_id
                 WHERE t.id = n.entity_id
                   AND p.client_id = u.client_id
                   AND t.client_visible = 1
               ))
            )
          ORDER BY n.created_at DESC
          LIMIT 1`,
    args: [clientId, NOTIFICATION_FRESHNESS_DAYS],
  });
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    id: row[0] as string,
    type: row[1] as string,
    entity_type: row[2] as string | null,
    entity_id: row[3] as string | null,
  };
}

async function resolveNotificationLabel(n: NotificationHit): Promise<string | null> {
  if (n.type === 'invoice_sent' && n.entity_id) {
    const r = await turso.execute({
      sql: 'SELECT total FROM invoices WHERE id = ?',
      args: [n.entity_id],
    });
    if (r.rows.length === 0) return null;
    const total = Number(r.rows[0][0]);
    return `Your new invoice for $${total.toFixed(0)} is ready to view.`;
  }
  if (n.type === 'milestone_completed' && n.entity_id) {
    const r = await turso.execute({
      sql: 'SELECT title, client_update_text FROM milestones WHERE id = ?',
      args: [n.entity_id],
    });
    if (r.rows.length === 0) return null;
    const title = r.rows[0][0] as string;
    const copy = r.rows[0][1] as string | null;
    return `${(copy && copy.trim()) || title} just wrapped up — check it out.`;
  }
  if (n.type === 'task_completed' && n.entity_id) {
    const r = await turso.execute({
      sql: 'SELECT title, client_update_text FROM tasks WHERE id = ?',
      args: [n.entity_id],
    });
    if (r.rows.length === 0) return null;
    const title = r.rows[0][0] as string;
    const copy = r.rows[0][1] as string | null;
    return `${(copy && copy.trim()) || title} just finished — check it out.`;
  }
  return null;
}

// --- Public entry point ---

export async function generateNeedToKnowVerdict(
  clientId: string,
  viewerEmail?: string
): Promise<NeedToKnowResult> {
  // Branch 1: overdue invoice (highest urgency — money is late).
  const overdue = await loadOverdueInvoice(clientId);
  if (overdue) {
    const outstanding = overdue.total - overdue.amount_paid;
    const dateLabel = formatFriendlyDate(overdue.due_date);
    return {
      headline: `Your invoice for $${outstanding.toFixed(0)} is past due — it was due ${dateLabel}.`,
      source: 'overdue_invoice',
      basis: {
        invoice_id: overdue.id,
        invoice_number: overdue.invoice_number,
        outstanding,
        due_date: overdue.due_date,
      },
    };
  }

  // Branch 2: sent invoice due within the next 14 days.
  const dueSoon = await loadDueSoonInvoice(clientId);
  if (dueSoon) {
    const outstanding = dueSoon.total - dueSoon.amount_paid;
    const dateLabel = formatFriendlyDate(dueSoon.due_date);
    return {
      headline: `Your next invoice for $${outstanding.toFixed(0)} is due ${dateLabel}.`,
      source: 'due_soon_invoice',
      basis: {
        invoice_id: dueSoon.id,
        invoice_number: dueSoon.invoice_number,
        outstanding,
        due_date: dueSoon.due_date,
      },
    };
  }

  // Branch 3: pending approval waiting on the client.
  const approval = await loadPendingApproval(clientId);
  if (approval) {
    // Slice 12b — route approval phrasing through contacts-by-role.
    // The honest mapping is:
    //   0 approval contacts            → "your" (fallback, matches pre-slice behavior)
    //   1 approval contact, viewer = it → "your"
    //   1 approval contact, viewer ≠ it → name them (first name)
    //   N approval contacts             → "your team's"
    const approvers = await getContactsByRole(clientId, 'approval');
    const viewer = viewerEmail?.toLowerCase() ?? null;
    let possessive = 'your';
    let approverName: string | null = null;
    let viewerIsApprover = false;
    if (approvers.length === 1) {
      const only = approvers[0];
      if (viewer && only.email.toLowerCase() === viewer) {
        viewerIsApprover = true;
      } else {
        approverName = only.name.trim().split(/\s+/)[0];
        possessive = `${approverName}'s`;
      }
    } else if (approvers.length > 1) {
      possessive = "your team's";
    }
    return {
      headline: `We need ${possessive} okay on "${approval.title}".`,
      source: 'pending_approval',
      basis: {
        approval_id: approval.id,
        title: approval.title,
        approver_count: approvers.length,
        approver_name: approverName,
        viewer_is_approver: viewerIsApprover,
      },
    };
  }

  // Branch 4: recent real client-facing notification (filtered to live,
  // non-draft entities — test pollution and deleted rows are excluded
  // at query time). This is the softest signal and is purely additive.
  const notif = await loadRecentClientFacingNotification(clientId);
  if (notif) {
    const label = await resolveNotificationLabel(notif);
    if (label) {
      return {
        headline: label,
        source: 'recent_notification',
        basis: {
          notification_id: notif.id,
          type: notif.type,
          entity_type: notif.entity_type ?? '',
          entity_id: notif.entity_id ?? '',
        },
      };
    }
  }

  // Branch 5: nothing waiting. Say so plainly. No filler.
  return {
    headline: `Nothing is waiting on you right now.`,
    source: 'none',
    basis: {},
  };
}
