#!/usr/bin/env node
// Unit tests for the Site Health Report assembly (pure markdown builder).
// Same SOP guarantees as the Performance Summary: descriptive-only (no
// judgment tokens in non-comment lines), no em/en dashes, deterministic,
// graceful baseline mode, intact Cody placeholders, plus the "Closed this
// month" derivation. Runs via tsx.

import { buildSiteHealthMarkdown } from '../src/lib/reports/site-health.ts';

const results = [];
function test(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  if (!pass && detail) console.log(`       ${String(detail).slice(0, 240)}`);
}

function issue(name, priority, affected) {
  return { issue_name: name, issue_type: null, priority, affected_urls: affected, pct_of_total: null, description: null, how_to_fix: null };
}
function health(month, issues) {
  return { month, issues, totalIssues: issues.length, totalAffected: issues.reduce((s, i) => s + (i.affected_urls || 0), 0), byPriority: { high: 0, medium: 0, low: 0 } };
}

const current = health('2026-05', [
  issue('Security: Missing HSTS Header', 'Low', 142),
  issue('Images: Missing Alt Text', 'Low', 35),
  issue('Meta Description: Missing', 'Low', 28),         // was 39 -> -28%, under the 50% gate, excluded from closed
  issue('Images: Over 100 kB', 'Medium', 109),           // was 230 -> 52.6% reduction
  issue('Canonicals: Missing', 'High', 2),
  issue('Bad | Pipe: Category', 'Low', 1),               // pipe in a cell value
]);
const prior = health('2026-04', [
  issue('Security: Missing HSTS Header', 'Low', 150),
  issue('Meta Description: Missing', 'Low', 39),
  issue('Images: Over 100 kB', 'Medium', 230),
  issue('Page Titles: Over 60 Characters', 'Medium', 3), // cleared (absent from current)
]);

const baseInput = {
  siteName: 'ZipKit Homes',
  periodLabel: 'Month Two, May 2026',
  current, prior,
  navigablePages: 55, navigablePagesPrior: 52,
  responseCodes: [
    { code: '2xx', current: 55, prior: 52 },
    { code: '3xx', current: 3, prior: 2 },
    { code: '4xx', current: 1, prior: 4 },
    { code: '5xx', current: 0, prior: 0 },
  ],
};

const JUDGMENT_TOKENS = [' means ', 'likely means', 'suggests', 'worth watching', 'worth deciding', 'candidate for', 'should be', 'the lever', 'opportunity', 'healthier', ' risk', 'improved', 'worsened', 'significantly'];
function nonCommentBody(md) { return md.split('\n').filter(l => !l.trim().startsWith('<!--')).join('\n'); }

function run() {
  const trend = buildSiteHealthMarkdown(baseInput);

  // Sections
  test('trend: thesis placeholder', trend.includes('## [Thesis - Cody to write]'));
  test('trend: crawl health + scope + response codes', trend.includes('## Crawl health') && trend.includes('### Scope') && trend.includes('### Response codes'));
  test('trend: page-level section', trend.includes('## Page-level health'));
  test('trend: image health section', trend.includes('## Image health'));
  test('trend: security section', trend.includes('## Security and protocol'));
  test('trend: closed this month', trend.includes('### Closed this month'));
  test('trend: uptime/infra placeholder', trend.includes('## Uptime and infrastructure') && trend.includes('### Active defense stack'));
  test('trend: page-level table Change column', /## Page-level health[\s\S]*?\| Change \|/.test(trend));

  // Closed this month derivation
  test('closed: Page Titles cleared row', trend.includes('Page Titles: Over 60 Characters cleared'));
  test('closed: Images reduced 230->109 (-52.6%)', /Images: Over 100 kB reduced[\s\S]*?230 to 109 URLs \(-52\.6%\)/.test(trend), trend.split('\n').find(l => l.includes('reduced')));
  test('closed: Meta Description NOT a closed row (only 38% reduction)', !trend.includes('Meta Description: Missing cleared') && !trend.includes('Meta Description: Missing reduced'));

  // Finding sentences (factual)
  test('finding: response codes states 4xx/5xx', trend.includes('1 client-error (4xx) responses and 0 server-error (5xx) responses'));
  test('finding: navigable pages', trend.includes('55 navigable pages were crawled'));

  // Pipe sanitization
  test('pipe in issue name sanitized to slash', trend.includes('Bad / Pipe: Category') && !trend.includes('Bad | Pipe: Category'));

  // SOP: descriptive-only, no em dash, deterministic
  {
    const body = nonCommentBody(trend).toLowerCase();
    const hit = JUDGMENT_TOKENS.find(t => body.includes(t));
    test('no judgment tokens in factual body', !hit, hit ? `leaked: "${hit}"` : '');
  }
  test('no em/en dashes', !/[–—]/.test(trend), (trend.match(/[–—]/) || [])[0]);
  test('deterministic', buildSiteHealthMarkdown(baseInput) === buildSiteHealthMarkdown(baseInput));
  {
    const thesisLine = trend.split('\n').find(l => l.includes('[Thesis - Cody to write]'));
    test('thesis line has no digits', !!thesisLine && !/\d/.test(thesisLine));
  }

  // Baseline mode
  const baseline = buildSiteHealthMarkdown({ ...baseInput, prior: null, navigablePagesPrior: null, responseCodes: baseInput.responseCodes.map(r => ({ ...r, prior: null })) });
  test('baseline: no Change column', !baseline.includes('| Change |'));
  test('baseline: first site health report disclosure', baseline.includes('first site health report'));
  test('baseline: closed-this-month suppressed (placeholder only)', baseline.includes('### Closed this month') && baseline.includes('no prior cycle to compare'));
  test('baseline: still has sections + data', baseline.includes('## Image health') && baseline.includes('Affected URLs'));

  // Resilience
  test('empty issues builds without throwing', typeof buildSiteHealthMarkdown({ ...baseInput, current: health('2026-05', []), prior: null, navigablePagesPrior: null }) === 'string');

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exit(1);
}

run();
