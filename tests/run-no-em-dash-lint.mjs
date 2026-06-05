#!/usr/bin/env node
// Lint: no em or en dashes (U+2014 / U+2013) in client-facing copy.
//
// Cody's hard rule. It has regressed repeatedly, so this codifies it. Scans
// the portal pages and the client-facing email/trigger copy, strips comments
// (// line, /* */ block, <!-- --> html), and fails on any remaining em/en
// dash. Code comments are allowed; shipped strings are not. Runs via tsx.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

// Files/globs to scan: portal pages + client-facing copy modules.
const SCAN_DIRS = ['src/pages/portal', 'src/contracts/templates'];
const SCAN_FILES = ['src/lib/contract-emails.ts', 'src/lib/triggers.ts', 'src/lib/billing.ts', 'src/lib/invoice-emails.ts'];

// Admin tooling (/portal/admin/**) is internal-facing (Cody's own UI), not
// client copy; the rule targets what the client sees. Skip it.
function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (/\/(portal|api)\/admin\//.test(p.replace(/\\/g, '/'))) continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(astro|ts|md)$/.test(name)) out.push(p);
  }
}

// Strip comments so em dashes inside code comments are allowed.
function stripComments(line) {
  return line
    .replace(/<!--.*?-->/g, '')
    .replace(/\/\*.*?\*\//g, '')
    .replace(/\/\/.*$/, '');
}

function run() {
  const files = [];
  for (const d of SCAN_DIRS) walk(join(ROOT, d), files);
  for (const f of SCAN_FILES) files.push(join(ROOT, f));

  const hits = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf-8').split('\n');
    lines.forEach((line, i) => {
      const stripped = stripComments(line);
      if (/[—–]/.test(stripped)) {
        hits.push(`${file.replace(ROOT, '')}:${i + 1}: ${line.trim().slice(0, 100)}`);
      }
    });
  }

  if (hits.length === 0) {
    console.log(`[PASS] no em/en dashes in ${files.length} client-facing files`);
    console.log('\n1/1 passed');
    return;
  }
  console.log(`[FAIL] em/en dash in shipped copy (${hits.length}):`);
  for (const h of hits) console.log('  ' + h);
  console.log(`\n0/1 passed`);
  process.exit(1);
}

run();
