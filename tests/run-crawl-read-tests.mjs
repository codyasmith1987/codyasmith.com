#!/usr/bin/env node
// Unit tests for the pure logic in src/lib/crawl-read.ts (the SQL functions
// need a DB and are validated by the prod walk). Pins the priority bucketing
// to match score.ts. Runs via tsx.

import { __test } from '../src/lib/crawl-read.ts';
const { bucketPriority, rollupByPriority, isAdvisoryIssue } = __test;

const results = [];
function test(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  if (!pass && detail) console.log(`       ${String(detail).slice(0, 200)}`);
}

function run() {
  test('critical -> high', bucketPriority('critical') === 'high');
  test('High -> high (case-insensitive)', bucketPriority('High') === 'high');
  test('medium -> medium', bucketPriority('medium') === 'medium');
  test('Low -> low', bucketPriority('Low') === 'low');
  test('null -> low', bucketPriority(null) === 'low');
  test('unknown -> low', bucketPriority('whatever') === 'low');

  const rollup = rollupByPriority([
    { issue_name: 'a', priority: 'High', affected_urls: 10 },
    { issue_name: 'b', priority: 'critical', affected_urls: 5 },
    { issue_name: 'c', priority: 'Medium', affected_urls: 3 },
    { issue_name: 'd', priority: null, affected_urls: 1 },
  ]);
  test('rollup counts categories not urls', rollup.high === 2 && rollup.medium === 1 && rollup.low === 1, JSON.stringify(rollup));

  // Advisory split (M2 + M3): Warning/Opportunity (SF advisory types) and
  // site_audit ('audit') rows are advisories, NOT scored problems.
  test('Warning -> advisory', isAdvisoryIssue({ issue_type: 'Warning' }) === true);
  test('Opportunity -> advisory', isAdvisoryIssue({ issue_type: 'Opportunity' }) === true);
  test('audit -> advisory (site_audit hardcoded medium)', isAdvisoryIssue({ issue_type: 'audit' }) === true);
  test('Issue -> scored (not advisory)', isAdvisoryIssue({ issue_type: 'Issue' }) === false);
  test('null type -> scored (not advisory)', isAdvisoryIssue({ issue_type: null }) === false);

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exit(1);
}

run();
