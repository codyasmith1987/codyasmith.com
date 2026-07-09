#!/usr/bin/env node
// Pure-logic tests for the file-category taxonomy that backs the issued-report
// surface. The DB reads (getFilesForClient, getIssuedReportsForClient,
// markFileIssued) are validated by the prod walk; these pin the invariants
// the gates depend on. Runs via tsx.

import {
  ADMIN_ONLY_FILE_CATEGORIES,
  ISSUABLE_FILE_CATEGORIES,
  FILE_CATEGORY_LABELS,
  fileCategoryLabel,
} from '../src/lib/storage.ts';
import { MONTHLY_REQUEST_LIMIT } from '../src/lib/data-update-requests.ts';

const results = [];
function test(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  if (!pass && detail) console.log(`       ${String(detail).slice(0, 200)}`);
}

function run() {
  // Disjoint: a category that is both admin-only AND issuable would be hidden
  // from the client forever yet show an Issue button that can never deliver it.
  const overlap = ISSUABLE_FILE_CATEGORIES.filter(c => ADMIN_ONLY_FILE_CATEGORIES.includes(c));
  test('issuable and admin-only categories are disjoint', overlap.length === 0, JSON.stringify(overlap));

  // Every issuable + admin-only category has a human label so no raw token
  // (e.g. "internal_draft", "strategic_recommendation") leaks into the UI.
  for (const c of [...ISSUABLE_FILE_CATEGORIES, ...ADMIN_ONLY_FILE_CATEGORIES]) {
    test(`label exists for "${c}"`, typeof FILE_CATEGORY_LABELS[c] === 'string' && FILE_CATEGORY_LABELS[c].length > 0);
  }

  test('strategic_recommendation label', fileCategoryLabel('strategic_recommendation') === 'Strategic Recommendations');
  test('research label', fileCategoryLabel('research') === 'Research Reports');
  test('performance_summary label', fileCategoryLabel('performance_summary') === 'Performance Summary');
  test('site_health_report label', fileCategoryLabel('site_health_report') === 'Site Health Report');
  test('advisory label', fileCategoryLabel('advisory') === 'Advisory');
  // The EOM report types are draft-until-sent deliverables (issuable).
  test('performance_summary is issuable', ISSUABLE_FILE_CATEGORIES.includes('performance_summary'));
  test('site_health_report is issuable', ISSUABLE_FILE_CATEGORIES.includes('site_health_report'));
  test('advisory is issuable', ISSUABLE_FILE_CATEGORIES.includes('advisory'));
  test('internal_draft is admin-only', ADMIN_ONLY_FILE_CATEGORIES.includes('internal_draft'));
  test('report is retired (not issuable, not labeled distinctly)', !ISSUABLE_FILE_CATEGORIES.includes('report'));

  // Unknown category falls back to the raw token rather than throwing/blanking.
  test('unknown category falls back to token', fileCategoryLabel('mystery') === 'mystery');

  // The request cap is two per month, as Cody set.
  test('monthly request limit is 2', MONTHLY_REQUEST_LIMIT === 2);

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exit(1);
}

run();
