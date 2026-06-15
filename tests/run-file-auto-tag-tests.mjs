#!/usr/bin/env node
// Unit tests for the document filename auto-tagger (src/lib/files/auto-tag.ts).
// Asserts against the REAL end-of-month report filename corpus so the parser is
// validated against what Cody actually uploads, not invented examples.

import { detectFileTags } from '../src/lib/files/auto-tag.ts';

const results = [];
function test(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  if (!pass && detail) console.log(`       ${detail}`);
}

// Two managed sites, mirroring ZipKit. One carries an explicit alias; the
// other relies on label-initials derivation, so both paths are exercised.
const SITES = [
  { id: 'zkh', domain: 'zipkithomes.com', label: 'ZipKit Homes', aliases: 'ZKH', is_primary: true },
  { id: 'mvp', domain: 'mountainvalleyprefab.com', label: 'Mountain Valley Prefab', aliases: null },
];

function check(filename, expect) {
  const r = detectFileTags(filename, SITES);
  const okSite = r.siteId === expect.siteId;
  const okCat = r.category === expect.category;
  const okMonth = r.month === expect.month;
  test(
    filename,
    okSite && okCat && okMonth,
    `got site=${r.siteId} cat=${r.category} month=${r.month}; want site=${expect.siteId} cat=${expect.category} month=${expect.month}`,
  );
}

// --- Real corpus (end-of-month-reports-ZKH-May-to-June and earlier) ---
check('ZKH-Performance-Summary-May9-Jun8-2026.docx', { siteId: 'zkh', category: 'performance_summary', month: '2026-06' });
check('MVP-Performance-Summary-May9-Jun8-2026.docx', { siteId: 'mvp', category: 'performance_summary', month: '2026-06' });
check('ZKH-Site-Health-Report-May9-Jun8-2026.docx', { siteId: 'zkh', category: 'site_health_report', month: '2026-06' });
check('MVP-Site-Health-Report-May9-Jun8-2026.docx', { siteId: 'mvp', category: 'site_health_report', month: '2026-06' });
check('ZKH-Strategic-Recommendations-May9-Jun8-2026.docx', { siteId: 'zkh', category: 'strategic_recommendation', month: '2026-06' });

// MVP via label-initials only (no explicit alias on that site).
check('MVP-SITE-HEALTH-REPORT-MAY-2026-v2.docx', { siteId: 'mvp', category: 'site_health_report', month: '2026-05' });
check('ZKH-MONTH-TWO-PERFORMANCE-SUMMARY-MAY-2026.docx', { siteId: 'zkh', category: 'performance_summary', month: '2026-05' });

// Combined "ZKH-MVP" report -> matches both -> engagement-level (null site).
check('ZKH-MVP-MONTH-TWO-PERFORMANCE-SUMMARY-MAY-2026.docx', { siteId: null, category: 'performance_summary', month: '2026-05' });

// Advisories / analyses.
check('ZKH-California-Market-Entry-Advisory-April-2026.docx', { siteId: 'zkh', category: 'advisory', month: '2026-04' });
check('ZipKit-Homes-SWOT-Analysis-April-2026.docx', { siteId: 'zkh', category: 'research', month: '2026-04' });
check('ZKH-Month-One-Performance-Summary-April-2026.docx', { siteId: 'zkh', category: 'performance_summary', month: '2026-04' });

// A non-report file: no category guess, admin picks. (Invoices are not part of
// the report auto-tag flow.)
check('invoice-INV-003.docx', { siteId: null, category: null, month: null });

// Label-initials path with NO alias configured on either site.
const SITES_NO_ALIAS = [
  { id: 'zkh', domain: 'zipkithomes.com', label: 'ZipKit Homes', aliases: null, is_primary: true },
  { id: 'mvp', domain: 'mountainvalleyprefab.com', label: 'Mountain Valley Prefab', aliases: null },
];
(() => {
  const r = detectFileTags('ZKH-Performance-Summary-May9-Jun8-2026.docx', SITES_NO_ALIAS);
  test('label-initials match without explicit alias (ZKH -> zipkithomes.com)',
    r.siteId === 'zkh' && r.category === 'performance_summary' && r.month === '2026-06',
    `got site=${r.siteId} cat=${r.category} month=${r.month}`);
})();

// Single-site client: no site dimension ever attributed.
(() => {
  const r = detectFileTags('Some-Report-April-2026.docx', [{ id: 'solo', domain: 'example.com', label: 'Example', aliases: null, is_primary: true }]);
  test('single unrelated site -> no false site match', r.siteId === null, `got site=${r.siteId}`);
})();

const passed = results.filter(r => r.pass).length;
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
