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

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exit(1);
}

run();
