#!/usr/bin/env node
// Unit tests for the Performance Summary assembly (pure markdown builder).
// Enforces the SOP-critical guarantees: descriptive-only (no judgment
// tokens in non-comment lines), no em/en dashes, deterministic output,
// graceful baseline mode, and intact Cody placeholders. Runs via tsx.

import { buildPerformanceSummaryMarkdown, __test } from '../src/lib/reports/performance-summary.ts';

const results = [];
function test(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  if (!pass && detail) console.log(`       ${String(detail).slice(0, 240)}`);
}

function ga4(month, sessions, activeUsers) {
  return {
    month, has_data: true,
    topline: { start_date: '20260412', end_date: '20260509', active_users: activeUsers, new_users: Math.round(activeUsers * 0.9), sessions, avg_engagement_time_per_active_user: 171.5 },
    channels: [
      { channel: 'Organic Search', sessions: Math.round(sessions * 0.5), engaged_sessions: 100, engagement_rate: 0.62, avg_engagement_time_per_session: 80, key_events: 5, total_revenue: 0 },
      { channel: 'Direct', sessions: Math.round(sessions * 0.3), engaged_sessions: 60, engagement_rate: 0.43, avg_engagement_time_per_session: 40, key_events: 2, total_revenue: 0 },
    ],
    pages: [{ page_path: '/', views: 5000, active_users: 3000, avg_engagement_time_per_active_user: 90, key_events: 3 }],
    sources: [{ source_medium: 'google / organic', sessions: 1000, key_events: 5, total_revenue: 0 }, { source_medium: 'chatgpt.com / referral', sessions: 40, key_events: 0, total_revenue: 0 }],
    ai_referrals: [{ source_medium: 'chatgpt.com / referral', sessions: 40, key_events: 0, total_revenue: 0 }],
    tech: { platform: [], os: [{ label: 'iOS', active_users: 1500 }], device_category: [{ label: 'mobile', active_users: 2000 }, { label: 'desktop', active_users: 1000 }] },
    geography: [{ country: 'United States', active_users: 2800, new_users: 2500, engaged_sessions: 1800, engagement_rate: 0.6 }],
    campaigns: [{ campaign_name: '02-2026 | Lead Gen - Search', sessions: 800 }],
  };
}

function isoDate(y, m, d) { return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10); }
const chart = [];
// Position differs across the prior vs current window so the position cell
// exercises a real MOVE (not flat), which is the leak path for judgment words.
for (let i = 0; i < 60; i++) {
  const date = isoDate(2026, 3, 11 + i);
  const position = date < '2026-04-09' ? 20 : 12;
  chart.push({ date, clicks: 200, impressions: 4000, ctr: 0.05, position });
}

const baseInput = {
  siteName: 'ZipKit Homes',
  periodLabel: 'Month Two, May 2026',
  nextPeriodLabel: 'next month',
  month: '2026-05',
  ga4Current: ga4('2026-05', 39418, 27969),
  ga4Prior: ga4('2026-04', 32000, 24000),
  gscChart: chart,
  gscTotals: { clicks: 12000, impressions: 240000, ctr: 0.05, avg_position: 16, first_date: '2026-03-11', last_date: '2026-05-09', days_covered: 60 },
  gscQueries: [{ value: 'modular | homes', clicks: 500, impressions: 9000, ctr: 0.055, position: 4.1 }],
  gscPages: [{ value: 'https://zipkithomes.com/', clicks: 300, impressions: 6000, ctr: 0.05, position: 3.0 }],
  gscFilters: [{ key: 'Search type', value: 'Web' }],
  windows: {
    gscCurrent: { label: 'Month Two', start: '2026-04-09', endExclusive: '2026-05-09' },
    gscPrior: { label: 'Month One', start: '2026-03-09', endExclusive: '2026-04-09' },
  },
};

const JUDGMENT_TOKENS = [' means ', 'likely means', 'suggests', 'worth watching', 'worth deciding', 'candidate for', 'should be', 'the lever', 'opportunity', 'healthier', ' risk', 'improved', 'worsened'];

function nonCommentBody(md) {
  return md.split('\n').filter(l => !l.trim().startsWith('<!--')).join('\n');
}

function run() {
  const trend = buildPerformanceSummaryMarkdown(baseInput);

  // Trend-mode content
  test('trend: has Work delivered scaffold', trend.includes('## Work delivered in Month Two, May 2026'));
  test('trend: has thesis placeholder', trend.includes('## [Thesis - Cody to write]'));
  test('trend: has what-next placeholder', trend.includes('## What the next month report will add'));
  test('trend: GA4 topline Change column', /\| Metric \| Month Two, May 2026 \| Prior period \| Change \|/.test(trend));
  test('trend: GSC arc has Clicks/day column', trend.includes('Clicks/day'));
  test('trend: GSC current-vs-prior table present', trend.includes('### Current versus prior period'));
  test('trend: AI referrals Total row equals sum', /\| Total \| 40 \|/.test(trend));
  test('trend: Sessions finding sentence', /Sessions were 39,418 versus 32,000, a change of \+\d+\.\d%\./.test(trend), trend.split('\n').find(l => l.startsWith('Sessions were')));
  test('trend: campaign factual sentence', trend.includes('The "02-2026 | Lead Gen - Search" campaign drove 800 sessions'));
  test('trend: each section has an Interpretation placeholder', (trend.match(/Interpretation:/g) || []).length >= 2);

  // Baseline mode (no prior)
  const baseline = buildPerformanceSummaryMarkdown({ ...baseInput, ga4Prior: null, windows: { gscCurrent: baseInput.windows.gscCurrent } });
  test('baseline: no Prior period column', !baseline.includes('Prior period'));
  test('baseline: no current-vs-prior table', !baseline.includes('### Current versus prior period'));
  test('baseline: states first reporting cycle', baseline.includes('first reporting cycle'));
  test('baseline: still has the data tables', baseline.includes('### Topline') && baseline.includes('### Search totals by window'));

  // SOP: no judgment tokens in non-comment body
  {
    const body = nonCommentBody(trend).toLowerCase();
    const hit = JUDGMENT_TOKENS.find(t => body.includes(t));
    test('no judgment tokens in factual body', !hit, hit ? `leaked token: "${hit}"` : '');
  }
  // SOP: no em/en dashes anywhere
  test('no em/en dashes', !/[–—]/.test(trend), (trend.match(/[–—]/) || [])[0]);

  // Pipe inside a cell value is sanitized so the table stays well-formed.
  test('pipe in query value sanitized to slash', trend.includes('modular / homes') && !trend.includes('modular | homes'));
  // Position move renders as a neutral signed value, never a verdict word.
  test('position move is neutral signed positions', /[+-]\d+\.\d+ positions/.test(trend), trend.split('\n').find(l => l.includes('position')));

  // Determinism
  const a = buildPerformanceSummaryMarkdown(baseInput);
  const b = buildPerformanceSummaryMarkdown(baseInput);
  test('deterministic: identical output on identical input', a === b);

  // Placeholder integrity: thesis never auto-filled with numbers
  {
    const thesisLine = trend.split('\n').find(l => l.includes('[Thesis - Cody to write]'));
    test('thesis line is the literal placeholder, not numbers', !!thesisLine && !/\d/.test(thesisLine));
  }

  // Date helpers
  test('ga4FmtDate 20260412 -> April 12', __test.ga4FmtDate('20260412') === 'April 12');
  test('ga4DaysBetween inclusive', __test.ga4DaysBetween('20260412', '20260509') === 28);

  // Empty-data resilience
  {
    const empty = buildPerformanceSummaryMarkdown({ ...baseInput, ga4Current: null, ga4Prior: null, gscChart: [], gscQueries: [], gscPages: [] });
    test('empty data: builds without throwing', typeof empty === 'string' && empty.includes('## [Thesis'));
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exit(1);
}

run();
