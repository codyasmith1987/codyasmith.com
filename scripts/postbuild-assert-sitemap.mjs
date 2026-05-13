// Postbuild assertion: verify the generated sitemap exists and lists
// every expected high-value route. Catches sitemap-integration regressions
// (filter logic accidentally excluding a real page, build artifact missing,
// etc.) before deploy. See seo-audit-2026-05-12 round 7 infra carryover.

import fs from 'node:fs';
import path from 'node:path';

const sitemapIndex = path.resolve('dist/client/sitemap-index.xml');
const sitemap0 = path.resolve('dist/client/sitemap-0.xml');

if (!fs.existsSync(sitemapIndex)) {
  console.error(`postbuild-assert-sitemap: ${sitemapIndex} not found`);
  process.exit(1);
}
if (!fs.existsSync(sitemap0)) {
  console.error(`postbuild-assert-sitemap: ${sitemap0} not found`);
  process.exit(1);
}

const xml = fs.readFileSync(sitemap0, 'utf8');

// astro.config.mjs has trailingSlash: 'never', so the sitemap emits the
// canonical home URL as `https://codyasmith.com` (no trailing slash) and
// every other route also bare. Match the bare form here.
const expected = [
  'https://codyasmith.com',
  'https://codyasmith.com/about',
  'https://codyasmith.com/services',
  'https://codyasmith.com/services/web-management',
  'https://codyasmith.com/services/marketing-strategy',
  'https://codyasmith.com/services/implementation',
  'https://codyasmith.com/services/training',
  'https://codyasmith.com/work',
  'https://codyasmith.com/contact',
  'https://codyasmith.com/listener',
  'https://codyasmith.com/privacy',
  'https://codyasmith.com/blog',
  'https://codyasmith.com/blog/articles',
  'https://codyasmith.com/blog/case-studies',
];

const missing = expected.filter(url => !xml.includes(`<loc>${url}</loc>`));
if (missing.length > 0) {
  console.error('postbuild-assert-sitemap: missing routes in sitemap:');
  for (const url of missing) console.error('  ' + url);
  process.exit(1);
}

// Negative checks: portal, api, naming-preview, and PNG endpoints must NOT
// appear. The filter in astro.config.mjs handles this; this catches a
// regression where the filter is removed or weakened.
const forbidden = [
  '<loc>https://codyasmith.com/portal/',
  '<loc>https://codyasmith.com/api/',
  '<loc>https://codyasmith.com/naming-preview',
  '.png</loc>',
];
const leaked = forbidden.filter(p => xml.includes(p));
if (leaked.length > 0) {
  console.error('postbuild-assert-sitemap: forbidden paths leaked into sitemap:');
  for (const p of leaked) console.error('  ' + p);
  process.exit(1);
}

console.log(`postbuild-assert-sitemap: ${expected.length} expected routes present, ${forbidden.length} forbidden patterns blocked.`);
