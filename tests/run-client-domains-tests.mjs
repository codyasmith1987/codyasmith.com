#!/usr/bin/env node
// Unit tests for client-domains helpers: URL parsing, hostname
// normalization, dedup behavior. The DB query path is covered
// elsewhere; here we only exercise the pure helpers.

import {
  normalizeHostname,
  extractHostnameFromUrl,
} from '../src/lib/client-domains.ts';

const results = [];
function test(name, pass, detail = '') {
  results.push({ name, pass, detail: String(detail).slice(0, 200) });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  if (!pass && detail) console.log(`       ${detail}`);
}

async function run() {
  // ---------- normalizeHostname ----------
  test('strips www. prefix', normalizeHostname('www.example.com') === 'example.com');
  test('keeps non-www subdomains', normalizeHostname('blog.example.com') === 'blog.example.com');
  test('lowercases', normalizeHostname('EXAMPLE.COM') === 'example.com');
  test('strips port', normalizeHostname('example.com:8080') === 'example.com');
  test('rejects bare TLD', normalizeHostname('com') === null);
  test('rejects empty', normalizeHostname('') === null);
  test('rejects whitespace', normalizeHostname('   ') === null);
  test('accepts hyphens', normalizeHostname('my-site.com') === 'my-site.com');

  // ---------- extractHostnameFromUrl ----------
  test('https URL', extractHostnameFromUrl('https://example.com/about') === 'example.com');
  test('http URL', extractHostnameFromUrl('http://example.com') === 'example.com');
  test('URL with www', extractHostnameFromUrl('https://www.example.com/path') === 'example.com');
  test('URL without protocol', extractHostnameFromUrl('example.com/foo') === 'example.com',
    `got "${extractHostnameFromUrl('example.com/foo')}"`);
  test('URL with subdomain', extractHostnameFromUrl('https://blog.example.com/post') === 'blog.example.com');
  test('URL with port', extractHostnameFromUrl('https://example.com:8443/x') === 'example.com');
  test('URL with query', extractHostnameFromUrl('https://example.com/?q=1') === 'example.com');
  test('garbage input', extractHostnameFromUrl('not a url') === null);
  test('empty input', extractHostnameFromUrl('') === null);

  // ---------- Summary ----------
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass);
  console.log(`\n${passed}/${results.length} passed`);
  if (failed.length > 0) {
    console.log('\nFailed:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

run().catch(err => { console.error(err); process.exit(1); });
