#!/usr/bin/env node
// Unit tests for client-domains helpers and the crawl-internal parser
// helpers. Pure functions only; DB query paths are covered by
// integration runs against live data.

import {
  normalizeHostname,
  extractHostnameFromUrl,
  deriveDomainsFromRawCsvText,
  isAuthoritativeRawCrawlFile,
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
  const internalHtmlBomCsv = '\uFEFF"Address","Status Code","Indexability","Title 1","Word Count"\n"https://www.example.com/","200","Indexable","Hello","100"\n';
  test('detector: internal_html with BOM as crawl_internal',
    detectFormat(internalHtmlBomCsv, 'internal_html.csv').format === 'crawl_internal');

  const redirectsCsv = '"Chain Type","Number of Redirects","Loop","Source","Final Address"\n"HTTP Redirect","1","false","https://a.com/old","https://a.com/new"\n';
  test('detector: redirects.csv as redirects',
    detectFormat(redirectsCsv, 'redirects.csv').format === 'redirects');

  const imagesCsv = '"Address","Content Type","Size (Bytes)","IMG Inlinks","Indexability","Dimensions"\n"https://a.com/i.png","image/png","1000","5","Indexable","100x100"\n';
  test('detector: images_all.csv as images',
    detectFormat(imagesCsv, 'images_all.csv').format === 'images');

  const crawlOverviewCsv = '"Site Crawled","https://a.com/"\n"Start Date","2026-05-23"\n';
  test('detector: crawl_overview.csv as crawl_overview',
    detectFormat(crawlOverviewCsv, 'crawl_overview.csv').format === 'crawl_overview');

  const contentCsv = '"Address","Word Count","Sentence Count","Average Words Per Sentence","Flesch Reading Ease Score","Readability"\n"https://a.com/","100","12","8.3","65","Standard"\n';
  test('detector: content_all.csv as content_urls',
    detectFormat(contentCsv, 'content_all.csv').format === 'content_urls');

  const securityCsv = '"Address","Content Type","Status Code","Status","HTTP Version","Indexability"\n"https://a.com/","text/html","200","OK","1.1","Indexable"\n';
  test('detector: security_all.csv as security_urls',
    detectFormat(securityCsv, 'security_all.csv').format === 'security_urls');

  const structuredCsv = '"Address","Errors","Warnings","Rich Result Errors","Rich Result Warnings","Total Types","Unique Types"\n"https://a.com/","0","1","0","0","2","2"\n';
  test('detector: structured_data_all.csv as structured_data_urls',
    detectFormat(structuredCsv, 'structured_data_all.csv').format === 'structured_data_urls');

  // ---------- raw_csv_data fallback domain derivation ----------
  const rawStoredCsv = '\uFEFFAddress,Status Code,Indexability,Title 1\nhttps://www.rawexample.com/,200,Indexable,Home\nhttps://rawexample.com/about,200,Indexable,About\nhttps://blog.rawexample.com/post,200,Indexable,Post\n';
  const rawDerived = deriveDomainsFromRawCsvText(rawStoredCsv, {
    filename: 'internal_html.csv',
    requireAuthoritativeFilename: true,
  });
  const rawMain = rawDerived.find(d => d.domain === 'rawexample.com');
  const rawBlog = rawDerived.find(d => d.domain === 'blog.rawexample.com');
  const rawOutlinkCsv = 'Address,Status Code\nhttps://www.youtube.com/embed/abc,200\nhttps://maps.google.com/example,200\nhttps://client-owned.example/page,200\n';
  const rawOutlinkDerived = deriveDomainsFromRawCsvText(rawOutlinkCsv, {
    filename: 'url_all.csv',
    requireAuthoritativeFilename: true,
  });
  test('raw_csv_data fallback trusts internal_html.csv',
    isAuthoritativeRawCrawlFile('internal_html.csv') === true);
  test('raw_csv_data fallback trusts internal_all.csv',
    isAuthoritativeRawCrawlFile('internal_all.csv') === true);
  test('raw_csv_data fallback trusts ZIP-prefixed internal_html.csv',
    isAuthoritativeRawCrawlFile('f3-export.zip:internal_html.csv') === true);
  test('raw_csv_data fallback does not trust url_all.csv',
    isAuthoritativeRawCrawlFile('url_all.csv') === false);
  test('raw_csv_data fallback derives main hostname from Address column',
    rawMain?.url_count === 2,
    JSON.stringify(rawDerived));
  test('raw_csv_data fallback keeps non-www subdomain separate',
    rawBlog?.url_count === 1,
    JSON.stringify(rawDerived));
  test('raw_csv_data fallback refuses generic URL/outlink files',
    rawOutlinkDerived.length === 0,
    JSON.stringify(rawOutlinkDerived));

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
