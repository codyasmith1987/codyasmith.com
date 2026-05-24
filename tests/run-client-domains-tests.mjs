#!/usr/bin/env node
// Unit tests for client-domains helpers and the crawl-internal parser
// helpers. Pure functions only; DB query paths are covered by
// integration runs against live data.

import {
  normalizeHostname,
  extractHostnameFromUrl,
} from '../src/lib/client-domains.ts';
import {
  extractHostname as extractHostnameCi,
  findHeaderIndex,
} from '../src/lib/csv/parsers/crawl-internal.ts';
import {
  extractHostname as extractHostnameRd,
  findIdx as findIdxRd,
} from '../src/lib/csv/parsers/redirects.ts';
import {
  extractHostname as extractHostnameIm,
  findIdx as findIdxIm,
} from '../src/lib/csv/parsers/images.ts';
import { detectFormat } from '../src/lib/csv/detector.ts';

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
  test('accepts hyphens', normalizeHostname('my-site.com') === 'my-site.com');

  // ---------- extractHostnameFromUrl ----------
  test('https URL', extractHostnameFromUrl('https://example.com/about') === 'example.com');
  test('http URL', extractHostnameFromUrl('http://example.com') === 'example.com');
  test('URL with www', extractHostnameFromUrl('https://www.example.com/path') === 'example.com');
  test('URL without protocol', extractHostnameFromUrl('example.com/foo') === 'example.com',
    `got "${extractHostnameFromUrl('example.com/foo')}"`);
  test('URL with subdomain', extractHostnameFromUrl('https://blog.example.com/post') === 'blog.example.com');
  test('URL with query', extractHostnameFromUrl('https://example.com/?q=1') === 'example.com');
  test('garbage input', extractHostnameFromUrl('not a url') === null);
  test('empty input', extractHostnameFromUrl('') === null);

  // ---------- crawl-internal: extractHostname ----------
  test('crawl extractHostname matches', extractHostnameCi('https://www.example.com/p') === 'example.com');
  test('crawl extractHostname null on empty', extractHostnameCi('') === null);
  test('crawl extractHostname strips www', extractHostnameCi('http://www.foo.co/x') === 'foo.co');

  // ---------- crawl-internal: findHeaderIndex ----------
  const headers = ['Address', 'Status Code', 'Title 1', 'H1-1', 'Meta Description 1', 'Word Count'];
  test('finds Address', findHeaderIndex(headers, 'address') === 0);
  test('finds Status Code', findHeaderIndex(headers, 'status code') === 1);
  test('finds Title 1 by title', findHeaderIndex(headers, 'title') === 2);
  test('finds H1-1 by h1', findHeaderIndex(headers, 'h1') === 3);
  test('finds Meta Description 1 by meta description',
    findHeaderIndex(headers, 'meta description') === 4);
  test('finds Word Count', findHeaderIndex(headers, 'word count') === 5);
  test('returns -1 for missing column', findHeaderIndex(headers, 'response time') === -1);

  // ---------- redirects + images: hostname + header helpers ----------
  test('redirects extractHostname strips www',
    extractHostnameRd('https://www.example.com/p') === 'example.com');
  test('images extractHostname returns null on empty',
    extractHostnameIm('') === null);

  const redirectsHeaders = ['Chain Type', 'Number of Redirects', 'Loop', 'Source', 'Final Address', 'Status Code 1', 'Redirect URL 1'];
  test('redirects findIdx exact match',
    findIdxRd(redirectsHeaders, 'chain type') === 0);
  test('redirects findIdx hop column',
    findIdxRd(redirectsHeaders, 'redirect url 1') === 6);

  const imagesHeaders = ['Address', 'Content Type', 'Size (Bytes)', 'IMG Inlinks', 'Indexability', 'Dimensions'];
  test('images findIdx Size (Bytes)',
    findIdxIm(imagesHeaders, 'size (bytes)') === 2);
  test('images findIdx Dimensions',
    findIdxIm(imagesHeaders, 'dimensions') === 5);

  // ---------- detector: new formats recognized ----------
  // Synthesize a minimal CSV matching each detector signature.
  const internalHtmlCsv = '"Address","Status Code","Indexability","Title 1","Word Count"\n"https://a.com/","200","Indexable","Hello","100"\n';
  test('detector: internal_html as crawl_internal',
    detectFormat(internalHtmlCsv, 'internal_html.csv').format === 'crawl_internal');

  const redirectsCsv = '"Chain Type","Number of Redirects","Loop","Source","Final Address"\n"HTTP Redirect","1","false","https://a.com/old","https://a.com/new"\n';
  test('detector: redirects.csv as redirects',
    detectFormat(redirectsCsv, 'redirects.csv').format === 'redirects');

  const imagesCsv = '"Address","Content Type","Size (Bytes)","IMG Inlinks","Indexability","Dimensions"\n"https://a.com/i.png","image/png","1000","5","Indexable","100x100"\n';
  test('detector: images_all.csv as images',
    detectFormat(imagesCsv, 'images_all.csv').format === 'images');

  const crawlOverviewCsv = '"Site Crawled","https://a.com/"\n"Start Date","2026-05-23"\n';
  test('detector: crawl_overview.csv as crawl_overview',
    detectFormat(crawlOverviewCsv, 'crawl_overview.csv').format === 'crawl_overview');

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
