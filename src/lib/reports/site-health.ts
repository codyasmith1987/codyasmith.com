// Site Health Report assembly: pure markdown builder.
//
// Takes already-read crawl data (the site_issues rollup for the current and
// prior cycle, plus navigable-page and response-code counts) and returns the
// full report markdown. Like the Performance Summary, it emits the
// DESCRIPTIVE substrate only: issue counts grouped into the report's
// sections, month-over-month deltas, a "Closed this month" list, and plain
// factual sentences. It NEVER writes judgment, cause diagnoses, or a
// prioritized fix roadmap (the roadmap now lives in Cody's Marketing
// Consulting Strategic Recommendations) - those are <!-- CODY -->
// placeholders. No em/en dashes; deterministic (same input -> same bytes).

import { table, escCell, fmtInt, fmtSignedPct, deltaCell } from './_shared';
import { computeDelta } from './deltas';
import type { HealthMonthData, SiteIssueRow } from '../crawl-read';

export interface SiteHealthInput {
  siteName: string;
  periodLabel: string;
  current: HealthMonthData;
  prior: HealthMonthData | null;          // null => baseline mode
  navigablePages: number | null;
  navigablePagesPrior: number | null;
  responseCodes: { code: string; current: number | null; prior: number | null }[];
}

// Issue-name family (the text before the first colon) -> report section.
// Any family not listed falls into "Other findings", so nothing ingested is
// silently dropped.
const SECTIONS: { heading: string; families: string[] }[] = [
  { heading: 'Page-level health', families: ['Meta Description', 'Page Titles', 'H1', 'H2', 'Headings', 'Content', 'Canonicals', 'Directives', 'URL', 'Pagination', 'Hreflang'] },
  { heading: 'Image health', families: ['Images'] },
  { heading: 'Security and protocol', families: ['Security'] },
  { heading: 'Structured data', families: ['Structured Data'] },
  { heading: 'Internal linking', families: ['Links'] },
  { heading: 'Accessibility', families: ['Accessibility'] },
];

function family(issueName: string): string {
  const idx = issueName.indexOf(':');
  return (idx > 0 ? issueName.slice(0, idx) : issueName).trim();
}

function countMap(data: HealthMonthData | null): Map<string, number | null> {
  const m = new Map<string, number | null>();
  if (data) for (const i of data.issues) m.set(i.issue_name, i.affected_urls);
  return m;
}

function pluralCat(n: number): string {
  return n === 1 ? 'category' : 'categories';
}

// ---- section builders (exported via __test) ----

function buildTitle(input: SiteHealthInput): string {
  return `Site Health Report, ${input.siteName}, ${input.periodLabel}`;
}

function buildThesisPlaceholder(): string {
  return [
    '<!-- CODY: thesis lede is yours. The descriptive findings are below; interpret them here, do not restate the counts. -->',
    '## [Thesis - Cody to write]',
    '',
  ].join('\n');
}

function buildCrawlHealthSection(input: SiteHealthInput): string {
  const trend = !!input.prior;
  const parts: string[] = ['## Crawl health'];
  if (trend) {
    parts.push('This report compares the latest crawl against the prior cycle.');
  } else {
    parts.push('This is the first site health report, so the figures below establish a baseline. Month-over-month comparison begins next cycle.');
  }
  parts.push('');
  parts.push('### Scope');
  if (trend) {
    parts.push(table(['Metric', 'This cycle', 'Prior cycle', 'Change'], [
      ['Navigable pages', fmtInt(input.navigablePages), fmtInt(input.navigablePagesPrior), deltaCell(input.navigablePagesPrior, input.navigablePages)],
    ]));
  } else {
    parts.push(table(['Metric', 'This cycle'], [['Navigable pages', fmtInt(input.navigablePages)]]));
  }
  parts.push('');
  parts.push(`**Finding:** ${fmtInt(input.navigablePages)} navigable pages were crawled this cycle.`);
  parts.push('');

  parts.push('### Response codes');
  if (trend) {
    parts.push(table(['Code range', 'This cycle', 'Prior cycle', 'Change'],
      input.responseCodes.map(r => [r.code, fmtInt(r.current), fmtInt(r.prior), deltaCell(r.prior, r.current)])));
  } else {
    parts.push(table(['Code range', 'This cycle'], input.responseCodes.map(r => [r.code, fmtInt(r.current)])));
  }
  const c4 = input.responseCodes.find(r => r.code === '4xx')?.current ?? 0;
  const c5 = input.responseCodes.find(r => r.code === '5xx')?.current ?? 0;
  parts.push('');
  parts.push(`**Finding:** ${fmtInt(c4)} client-error (4xx) responses and ${fmtInt(c5)} server-error (5xx) responses this cycle.`);
  parts.push('');
  return parts.join('\n');
}

function buildIssueSection(heading: string, issues: SiteIssueRow[], priorCounts: Map<string, number | null>, trend: boolean): string {
  if (issues.length === 0) return '';
  const sorted = [...issues].sort((a, b) => (b.affected_urls ?? 0) - (a.affected_urls ?? 0));
  const parts: string[] = [`## ${heading}`];
  if (trend) {
    parts.push(table(['Finding', 'This cycle', 'Prior cycle', 'Change'],
      sorted.map(i => {
        const prior = priorCounts.has(i.issue_name) ? priorCounts.get(i.issue_name)! : null;
        return [i.issue_name, fmtInt(i.affected_urls), fmtInt(prior), deltaCell(prior, i.affected_urls)];
      })));
  } else {
    parts.push(table(['Finding', 'Affected pages'], sorted.map(i => [i.issue_name, fmtInt(i.affected_urls)])));
  }
  const top = sorted[0];
  parts.push('');
  parts.push(`**Finding:** ${sorted.length} issue ${pluralCat(sorted.length)} in this area this cycle. The most affected is "${escCell(top.issue_name)}" at ${fmtInt(top.affected_urls)} pages.`);
  parts.push('Interpretation:');
  parts.push('<!-- CODY: what these findings mean, the causes, and the single highest-leverage fix. The prioritized roadmap lives in the Strategic Recommendations. -->');
  parts.push('');
  return parts.join('\n');
}

function buildClosedThisMonthSection(input: SiteHealthInput): string {
  if (!input.prior) {
    return ['### Closed this month', '<!-- CODY: no prior cycle to compare; closures begin next report. -->', ''].join('\n');
  }
  const curMap = countMap(input.current);
  const rows: string[][] = [];
  for (const p of input.prior.issues) {
    const priorN = p.affected_urls ?? 0;
    if (priorN <= 0) continue;
    const currN = curMap.has(p.issue_name) ? (curMap.get(p.issue_name) ?? 0) : 0;
    if (currN === 0) {
      rows.push([`${p.issue_name} cleared`, `Resolved (was ${fmtInt(priorN)} pages in the prior cycle).`]);
    } else {
      const d = computeDelta(priorN, currN, { metricKind: 'count' });
      if (d.percentChange !== null && d.percentChange <= -0.5) {
        rows.push([`${p.issue_name} reduced`, `${fmtInt(priorN)} to ${fmtInt(currN)} pages (${fmtSignedPct(d.percentChange)}).`]);
      }
    }
  }
  const parts: string[] = ['### Closed this month'];
  if (rows.length > 0) {
    parts.push(table(['Item', 'Detail'], rows));
  } else {
    parts.push('No issue categories cleared or materially reduced this cycle.');
  }
  parts.push('<!-- CODY: non-crawl closures (access grants, maintenance passes, defense-stack rollout) go here. -->');
  parts.push('');
  return parts.join('\n');
}

function buildInfraPlaceholder(): string {
  return [
    '## Uptime and infrastructure',
    '<!-- CODY: WordPress core / PHP version, plugin and license status, user roles. No portal feed yet; confirm and fill. -->',
    '### Active defense stack',
    '<!-- CODY: the security measures in place this cycle, incident dates, attacker activity. Manual record. -->',
    '',
  ].join('\n');
}

export function buildSiteHealthMarkdown(input: SiteHealthInput): string {
  const trend = !!input.prior;
  const priorCounts = countMap(input.prior);
  const blocks: string[] = [
    buildTitle(input),
    '',
    buildThesisPlaceholder(),
    buildCrawlHealthSection(input),
  ];

  // Group issues into the report's sections by family; track what was placed
  // so unmatched families land in "Other findings".
  const placed = new Set<string>();
  for (const section of SECTIONS) {
    const issues = input.current.issues.filter(i => section.families.includes(family(i.issue_name)));
    issues.forEach(i => placed.add(i.issue_name));
    const block = buildIssueSection(section.heading, issues, priorCounts, trend);
    if (block) blocks.push(block);
  }
  const other = input.current.issues.filter(i => !placed.has(i.issue_name));
  if (other.length > 0) blocks.push(buildIssueSection('Other findings', other, priorCounts, trend));

  blocks.push(buildClosedThisMonthSection(input));
  blocks.push(buildInfraPlaceholder());

  return blocks.filter(b => b !== '').join('\n');
}

export const __test = {
  buildTitle,
  buildThesisPlaceholder,
  buildCrawlHealthSection,
  buildIssueSection,
  buildClosedThisMonthSection,
  buildInfraPlaceholder,
  family,
};
