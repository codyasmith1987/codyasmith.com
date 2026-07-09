#!/usr/bin/env node
// CSV format detector tests. Focus: filenames extracted from a ZIP arrive
// tagged "<archive>.zip:<basename>", and the detector must route them the
// same as a direct upload. Regression guard for the GSC-via-ZIP bug where
// every GSC Performance CSV fell through to unknown_stored because the
// exact-match GSC switch saw the zip-prefixed name. Runs via tsx.

import { detectFormat } from '../src/lib/csv/detector.ts';

const results = [];
function test(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  if (!pass && detail) console.log(`       ${String(detail).slice(0, 200)}`);
}

// Real GSC Performance export headers (one row of data so parsing is sane).
const GSC = {
  'Queries.csv': 'Top queries,Clicks,Impressions,CTR,Position\nmodular homes,10,200,5%,4.1\n',
  'Pages.csv': 'Top pages,Clicks,Impressions,CTR,Position\nhttps://x.com/,5,80,6.2%,3.0\n',
  'Chart.csv': 'Date,Clicks,Impressions,CTR,Position\n2026-04-09,3,40,7.5%,5.2\n',
  'Countries.csv': 'Country,Clicks,Impressions,CTR,Position\nUnited States,9,90,10%,2.0\n',
  'Devices.csv': 'Device,Clicks,Impressions,CTR,Position\nMobile,7,70,10%,3.3\n',
  'Search appearance.csv': 'Search Appearance,Clicks,Impressions,CTR,Position\nVideo,1,10,10%,8.0\n',
  'Filters.csv': 'Filter,Value\nQuery,modular\n',
};
const GSC_EXPECT = {
  'Queries.csv': 'gsc_queries', 'Pages.csv': 'gsc_pages', 'Chart.csv': 'gsc_chart',
  'Countries.csv': 'gsc_countries', 'Devices.csv': 'gsc_devices',
  'Search appearance.csv': 'gsc_search_appearance', 'Filters.csv': 'gsc_filters',
};

const ZIP = 'zipkithomes.com-Performance-on-Search-2026-05-10 (1).zip';

function run() {
  // Direct (baseline): bare GSC filenames detect correctly.
  for (const [name, expect] of Object.entries(GSC_EXPECT)) {
    const got = detectFormat(GSC[name], name).format;
    test(`direct ${name} -> ${expect}`, got === expect, `got ${got}`);
  }

  // ZIP-tagged (the fix): "<archive>.zip:<basename>" must detect the same.
  for (const [name, expect] of Object.entries(GSC_EXPECT)) {
    const got = detectFormat(GSC[name], `${ZIP}:${name}`).format;
    test(`zip-tagged ${name} -> ${expect}`, got === expect, `got ${got} (regression: zip prefix defeated detection)`);
  }

  // Path-prefixed (folder upload) still works.
  test('path-prefixed folder/Queries.csv -> gsc_queries',
    detectFormat(GSC['Queries.csv'], 'crawl/2026-04/Queries.csv').format === 'gsc_queries');

  // GA4 substring routing unaffected, direct and zip-tagged.
  const ga4Raw = 'Nth day,Active users\n0,5\n';
  test('GA4 ZKHReports_snapshot.csv -> ga4_reports_snapshot',
    detectFormat(ga4Raw, 'ZKHReports_snapshot.csv').format === 'ga4_reports_snapshot');
  test('GA4 zip-tagged Reports_snapshot -> ga4_reports_snapshot',
    detectFormat(ga4Raw, `${ZIP}:ZKHReports_snapshot.csv`).format === 'ga4_reports_snapshot');

  // Ubersuggest keyword exports. Suggestions carries Search Intent; bulk
  // analysis does not. Both must land as keyword_suggestions (the relaxed
  // signature drops the 'search intent' requirement).
  const suggestionsRaw = 'No,Keyword,Search Intent,Search Volume,CPC,Paid Difficulty,SEO Difficulty\n1,custom prefab homes,navigational,720,US$2.17,92,41\n';
  const bulkRaw = 'No,Keyword,Search Volume,CPC,Paid Difficulty,SEO Difficulty\n1,prefab homes idaho,"1,300",$2.17,96,29\n';
  test('Ubersuggest suggestions -> keyword_suggestions',
    detectFormat(suggestionsRaw, 'suggestions_ubersuggest_x.csv').format === 'keyword_suggestions',
    detectFormat(suggestionsRaw, 'suggestions_ubersuggest_x.csv').format);
  test('Ubersuggest bulk analysis (no Search Intent) -> keyword_suggestions',
    detectFormat(bulkRaw, 'ubersuggest_bulk_analysis-x.csv').format === 'keyword_suggestions',
    detectFormat(bulkRaw, 'ubersuggest_bulk_analysis-x.csv').format);
  // Domain overview keeps its own format (plural 'Keywords' + 'Ranking Url'),
  // not stolen by the relaxed suggestions signature.
  const domainOverviewRaw = 'No,Keywords,Volume,Position,Est. Visits,Seo Difficulty,Ranking Url\n1,zip kit homes,5400,1,1735,25,http://zipkithomes.com/\n';
  test('Ubersuggest domain overview -> keyword_research',
    detectFormat(domainOverviewRaw, 'ubersuggest zipkithomes.com_3-26-26.csv').format === 'keyword_research',
    detectFormat(domainOverviewRaw, 'ubersuggest zipkithomes.com_3-26-26.csv').format);

  // ---- Slice 1: four unique-data SF exports route to the new formats ----
  // Real ZKH June scrape headers (one data row each so Papa parsing is sane).
  // canonicals_all.csv — rel="next"/"prev" is the unique tell. Note Papa
  // yields the CSV header `rel=""next"" 1` as `rel="next" 1` after unquoting.
  const canonicalsRaw =
    'Address,Occurrences,Indexability,Indexability Status,Canonical Link Element 1,HTTP Canonical,Meta Robots 1,X-Robots-Tag 1,"rel=""next"" 1","rel=""prev"" 1","HTTP rel=""next"" 1","HTTP rel=""prev"" 1"\n' +
    'https://zipkithomes.com/,1,Indexable,,https://zipkithomes.com/,,,,,,,\n';
  test('canonicals_all header -> canonicals',
    detectFormat(canonicalsRaw, 'canonicals_all.csv').format === 'canonicals',
    detectFormat(canonicalsRaw, 'canonicals_all.csv').format);

  // directives_all.csv — Meta Refresh 1 is the unique tell.
  const directivesRaw =
    'Address,Occurrences,Meta Robots 1,X-Robots-Tag 1,Meta Refresh 1,Canonical Link Element 1,HTTP Canonical,Indexability,Indexability Status\n' +
    'https://zipkithomes.com/,1,,,,https://zipkithomes.com/,,Indexable,\n';
  test('directives_all header -> directives',
    detectFormat(directivesRaw, 'directives_all.csv').format === 'directives',
    detectFormat(directivesRaw, 'directives_all.csv').format);

  // validation_all.csv — CO2 (mg) + Carbon Rating is the unique tell; format
  // name is page_weight (size + carbon, not html/schema validation).
  const pageWeightRaw =
    'Address,Content Type,Status Code,Status,Indexability,Indexability Status,Size (Bytes),Transferred (Bytes),Total Transferred (Bytes),CO2 (mg),Carbon Rating\n' +
    'https://zipkithomes.com/,text/html,200,OK,Indexable,,123456,98765,150000,0.42,A+\n';
  test('validation_all (page weight) header -> page_weight',
    detectFormat(pageWeightRaw, 'validation_all.csv').format === 'page_weight',
    detectFormat(pageWeightRaw, 'validation_all.csv').format);

  // sitemaps_all.csv — generic header; FILENAME rule only.
  const sitemapsRaw =
    'Address,Content Type,Status Code,Status,Indexability,Indexability Status\n' +
    'https://zipkithomes.com/,text/html,200,OK,Indexable,\n';
  test('sitemaps_all.csv (generic header) -> sitemap_urls (filename rule)',
    detectFormat(sitemapsRaw, 'sitemaps_all.csv').format === 'sitemap_urls',
    detectFormat(sitemapsRaw, 'sitemaps_all.csv').format);
  // zip-tagged sitemaps_all.csv routes the same.
  test('zip-tagged sitemaps_all.csv -> sitemap_urls',
    detectFormat(sitemapsRaw, `${ZIP}:sitemaps_all.csv`).format === 'sitemap_urls',
    detectFormat(sitemapsRaw, `${ZIP}:sitemaps_all.csv`).format);

  // ---- Slice 1 regressions: new signatures must NOT mis-route ----
  // security_all has meta robots + x-robots + canonical but NO meta refresh,
  // and has HTTP Version -> stays security_urls (its own earlier signature).
  const securityAllRaw =
    'Address,Content Type,Status Code,Status,Indexability,HTTP Version,Canonical Link Element 1,Meta Robots 1,X-Robots-Tag 1\n' +
    'https://zipkithomes.com/,text/html,200,OK,Indexable,HTTP/2,https://zipkithomes.com/,,\n';
  test('REGRESSION security_all header stays security_urls (not directives)',
    detectFormat(securityAllRaw, 'security_all.csv').format === 'security_urls',
    detectFormat(securityAllRaw, 'security_all.csv').format);

  // images_all has Size (Bytes) but also IMG Inlinks + Dimensions -> images,
  // not page_weight (page_weight needs CO2/carbon which images lacks).
  const imagesAllRaw =
    'Address,Content Type,Size (Bytes),IMG Inlinks,Dimensions\n' +
    'https://zipkithomes.com/logo.png,image/png,12345,3,200x80\n';
  test('REGRESSION images_all header stays images (not page_weight)',
    detectFormat(imagesAllRaw, 'images_all.csv').format === 'images',
    detectFormat(imagesAllRaw, 'images_all.csv').format);

  // internal_all stays crawl_internal (authoritative filename + signature).
  const internalAllRaw =
    'Address,Status Code,Indexability,Title 1\n' +
    'https://zipkithomes.com/,200,Indexable,ZipKit Homes\n';
  test('REGRESSION internal_all header stays crawl_internal',
    detectFormat(internalAllRaw, 'internal_all.csv').format === 'crawl_internal',
    detectFormat(internalAllRaw, 'internal_all.csv').format);

  // A generic response_codes_* header must NOT become sitemap_urls — only
  // the sitemaps_all.csv filename triggers that rule. This header has no
  // first-column "url" and no source/destination, so it falls through to
  // unknown (response_codes_all.csv has no broken_link/response_code-style
  // substring beyond "response_code", so guard the filename to not include it).
  const responseCodesRaw =
    'Address,Content Type,Status Code,Status,Indexability,Indexability Status\n' +
    'https://zipkithomes.com/,text/html,200,OK,Indexable,\n';
  test('REGRESSION generic response_codes header does NOT become sitemap_urls',
    detectFormat(responseCodesRaw, 'response_codes_redirection_3xx.csv').format !== 'sitemap_urls',
    detectFormat(responseCodesRaw, 'response_codes_redirection_3xx.csv').format);

  // ---- Issue-slice generalization (derived names + qualify/deny gate) ----
  const addr = 'Address,X\nhttps://zipkithomes.com/a,1\n';
  const derivedIssues = [
    'accessibility_text_requires_higher_color_contrast_ratio.csv',
    'amp_missing_canonical.csv',
    'hreflang_missing_return_links.csv',
    'javascript_pages_with_javascript_errors.csv',
    'pagespeed_reduce_unused_javascript.csv',
    'wcag_2_1_aa_all_violations.csv',
  ];
  for (const f of derivedIssues) {
    test(`derived issue slice ${f} -> issue_urls`,
      detectFormat(addr, f).format === 'issue_urls', detectFormat(addr, f).format);
  }
  // Curated map still wins (exact issues_overview name preserved for the join).
  test('curated h1_missing.csv -> issue_urls', detectFormat(addr, 'h1_missing.csv').format === 'issue_urls');

  // Masters / resources / summaries / headers must NEVER become issues
  // (the qualify/deny gate). They route to a typed signature or the floor.
  for (const f of ['javascript_all.csv', 'hreflang_all.csv', 'url_all.csv', 'h1_all.csv',
    'meta_description_all.csv', 'external_css.csv', 'ai_all.csv',
    'all_http_request_headers.csv', 'pagespeed_opportunities_summary.csv']) {
    test(`${f} is NOT issue_urls`, detectFormat(addr, f).format !== 'issue_urls', detectFormat(addr, f).format);
  }
  // Link dumps stay 'links' (the documented garbage fix), never issue_urls.
  const linkRaw = 'Source,Destination,Anchor,Status Code\nhttps://x/a,https://x/b,go,200\n';
  test('all_inlinks.csv -> links (not issue_urls)', detectFormat(linkRaw, 'all_inlinks.csv').format === 'links');

  // canonical/directive SLICE files stay typed (their signature wins; the
  // wider issue gate must NOT steal them).
  test('REGRESSION canonicals_self_referencing.csv stays canonicals (not issue_urls)',
    detectFormat(canonicalsRaw, 'canonicals_self_referencing.csv').format === 'canonicals',
    detectFormat(canonicalsRaw, 'canonicals_self_referencing.csv').format);
  test('REGRESSION directives_follow.csv stays directives (not issue_urls)',
    detectFormat(directivesRaw, 'directives_follow.csv').format === 'directives',
    detectFormat(directivesRaw, 'directives_follow.csv').format);

  // ---- Slice 3: rich per-URL "_all" reports route to their typed formats ----
  const javascriptRaw =
    'Address,Status Code,HTML Word Count,Rendered HTML Word Count,Word Count Change,JS Word Count %,HTML Title\n' +
    'https://zipkithomes.com/,200,100,350,250,71.4,Home\n';
  test('javascript_all header -> javascript',
    detectFormat(javascriptRaw, 'javascript_all.csv').format === 'javascript',
    detectFormat(javascriptRaw, 'javascript_all.csv').format);

  const urlAllRaw =
    'Address,Content Type,Status Code,Status,Indexability,Indexability Status,Hash,Length,Canonical Link Element 1,URL Encoded Address\n' +
    'https://zipkithomes.com/,text/html,200,OK,Indexable,,abc123,28,https://zipkithomes.com/,https%3A%2F%2F\n';
  test('url_all.csv -> url_structure (filename rule)',
    detectFormat(urlAllRaw, 'url_all.csv').format === 'url_structure',
    detectFormat(urlAllRaw, 'url_all.csv').format);
  // Backup signature catches a url_all copy renamed to a NON-issue-family name
  // (a 'url_'-prefixed name would be claimed by the issue gate first, which is
  // correct — url_uppercase.csv etc. are genuine issues).
  test('url_all backup signature (renamed export.csv) -> url_structure',
    detectFormat(urlAllRaw, 'export.csv').format === 'url_structure',
    detectFormat(urlAllRaw, 'export.csv').format);

  const hreflangRaw =
    'Address,Title 1,Occurrences,HTML hreflang 1,HTML hreflang 1 URL,Indexability,Indexability Status\n' +
    'https://zipkithomes.com/,Home,1,en,https://zipkithomes.com/,Indexable,\n';
  test('hreflang_all header -> hreflang',
    detectFormat(hreflangRaw, 'hreflang_all.csv').format === 'hreflang',
    detectFormat(hreflangRaw, 'hreflang_all.csv').format);

  // Slice 3 regressions: the new signatures must not steal neighbors.
  test('REGRESSION canonicals_all stays canonicals (not hreflang/javascript)',
    detectFormat(canonicalsRaw, 'canonicals_all.csv').format === 'canonicals',
    detectFormat(canonicalsRaw, 'canonicals_all.csv').format);
  test('REGRESSION directives_all stays directives',
    detectFormat(directivesRaw, 'directives_all.csv').format === 'directives',
    detectFormat(directivesRaw, 'directives_all.csv').format);
  test('REGRESSION security_all stays security_urls (not url_structure)',
    detectFormat(securityAllRaw, 'security_all.csv').format === 'security_urls',
    detectFormat(securityAllRaw, 'security_all.csv').format);

  // ---- 'unknown' is retired: empty / header-only files -> sf_generic ----
  // A recognized-but-empty SF report (header, zero data rows) and a truly
  // empty file are captured (0 rows), never flagged 'unknown'.
  test('header-only file (0 data rows) -> sf_generic, not unknown',
    detectFormat('﻿"Source Page"\n', 'viewport_not_set_report.csv').format === 'sf_generic',
    detectFormat('﻿"Source Page"\n', 'viewport_not_set_report.csv').format);
  test('empty (BOM + newline) file -> sf_generic, not unknown',
    detectFormat('﻿\n', 'segments_overview_report_issues.csv').format === 'sf_generic',
    detectFormat('﻿\n', 'segments_overview_report_issues.csv').format);
  test('empty string -> sf_generic, not unknown',
    detectFormat('', 'whatever.csv').format === 'sf_generic',
    detectFormat('', 'whatever.csv').format);

  // M1: response-code lists no longer become fake site_audit 'medium' issues;
  // they fall to the unscored sf_generic floor.
  const respCodeRaw = 'Address,Content Type,Status Code,Status,Indexability,Indexability Status\nhttps://x.com/,text/html,200,OK,Indexable,\n';
  test('response_codes_all.csv -> sf_generic (not site_audit / fake medium)',
    detectFormat(respCodeRaw, 'response_codes_all.csv').format === 'sf_generic',
    detectFormat(respCodeRaw, 'response_codes_all.csv').format);
  test('response_codes_redirection_(3xx).csv -> sf_generic (not site_audit)',
    detectFormat(respCodeRaw, 'response_codes_redirection_(3xx).csv').format === 'sf_generic',
    detectFormat(respCodeRaw, 'response_codes_redirection_(3xx).csv').format);

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exit(1);
}

run();
