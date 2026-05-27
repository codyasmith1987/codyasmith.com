#!/usr/bin/env node
// Verifies the post-upload auto-bind exports exist and have the
// expected shape. The functions themselves are DB-touching; deeper
// behavior is verified by smoke-testing a real upload against dev2.
//
// What this test catches: import wiring, function presence, signature
// drift. What it does not catch: actual SQL correctness, hostname
// match behavior, race conditions. Those rely on integration runs.

import {
  syncDetectedDomains,
  syncPerSitePageCounts,
  setSitePageCount,
} from '../src/lib/client-sites.ts';
import { readFileSync } from 'node:fs';

const results = [];
function test(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${pass ? '' : ': ' + detail}`);
}

async function run() {
  test('syncDetectedDomains is a function',
    typeof syncDetectedDomains === 'function');
  test('syncDetectedDomains takes one arg (clientId)',
    syncDetectedDomains.length === 1,
    `got arity ${syncDetectedDomains.length}`);

  test('syncPerSitePageCounts is a function',
    typeof syncPerSitePageCounts === 'function');
  test('syncPerSitePageCounts takes one arg (clientId)',
    syncPerSitePageCounts.length === 1,
    `got arity ${syncPerSitePageCounts.length}`);

  // setSitePageCount still exported (admin override path must
  // remain available; auto-bind is the fallback, manual is the
  // override per feedback_connect_to_data).
  test('setSitePageCount still exported',
    typeof setSitePageCount === 'function');

  const clientSitesSource = readFileSync(new URL('../src/lib/client-sites.ts', import.meta.url), 'utf8');
  test('client_sites sync SQL does not use double-quoted empty strings',
    !clientSitesSource.includes('domain = ""'),
    'LibSQL treats "" as an empty identifier, causing "no such column:" during post-ingest sync');

  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass);
  console.log(`\n${passed}/${results.length} passed`);
  if (failed.length > 0) {
    console.log('\nFailed:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

run().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
