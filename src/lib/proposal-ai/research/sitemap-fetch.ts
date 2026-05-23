// Fetch and count URLs in a site's sitemap.xml.
//
// First-pass estimate of "how many pages does this site have" for the
// Web Management ecosystem routing. Falls back gracefully:
//   - 404 / network error / parse error -> returns null
//   - sitemap index (one that points to other sitemaps) -> sums child sitemaps
//   - missing sitemap -> tries /sitemap_index.xml as a fallback
//
// A real Screaming Frog crawl always wins; this is just a starting point
// for the wizard's page_count variable when no crawl is uploaded yet.

import { lookup as dnsLookup } from 'node:dns/promises';

const FETCH_TIMEOUT_MS = 10_000;

export interface SitemapResult {
  url_count: number | null;
  source: string;             // human-readable description of where the count came from
  sitemap_url: string | null; // the sitemap URL that produced the count, when found
}

// SSRF-style guard: only allow public hostnames. Matches scraper.ts.
async function isPublicHost(hostname: string): Promise<boolean> {
  if (!hostname) return false;
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.local')) return false;
  if (lower === '169.254.169.254') return false;
  if (/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^127\.|^0\./.test(lower)) return false;
  try {
    const addrs = await dnsLookup(lower, { all: true });
    for (const a of addrs) {
      if (/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^127\.|^169\.254\.|^0\./.test(a.address)) return false;
      if (a.address === '::1' || a.address.startsWith('fc') || a.address.startsWith('fd')) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function safeFetch(url: string): Promise<string | null> {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!(await isPublicHost(u.hostname))) return null;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CodyAsmithBot/1.0)' },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function countLocTags(xml: string): number {
  // Count <loc>...</loc> entries. Ignores comments. Strips inner whitespace.
  const matches = xml.match(/<loc>\s*[^<]+?\s*<\/loc>/gi);
  return matches ? matches.length : 0;
}

function extractChildSitemaps(xml: string): string[] {
  // A sitemap index lists child sitemap URLs inside <sitemap><loc>...</loc></sitemap>
  // tags. Extract them and recurse.
  const out: string[] = [];
  const blockRe = /<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(xml)) !== null) {
    const inner = m[1];
    const loc = inner.match(/<loc>\s*([^<]+?)\s*<\/loc>/i);
    if (loc) out.push(loc[1]);
  }
  return out;
}

export async function fetchSitemapUrlCount(domain: string, opts: { maxChildSitemaps?: number } = {}): Promise<SitemapResult> {
  const maxChildren = opts.maxChildSitemaps ?? 10;
  const candidates = [
    `https://${domain}/sitemap.xml`,
    `https://${domain}/sitemap_index.xml`,
    `https://www.${domain}/sitemap.xml`,
    `https://www.${domain}/sitemap_index.xml`,
  ];

  for (const url of candidates) {
    const xml = await safeFetch(url);
    if (!xml) continue;
    // Is this a sitemap index?
    if (/<sitemapindex\b/i.test(xml)) {
      const children = extractChildSitemaps(xml).slice(0, maxChildren);
      let total = 0;
      for (const child of children) {
        const childXml = await safeFetch(child);
        if (childXml) total += countLocTags(childXml);
      }
      if (total > 0) {
        return {
          url_count: total,
          source: `sitemap index at ${url} (${children.length} child sitemaps)`,
          sitemap_url: url,
        };
      }
    }
    // Otherwise, treat as a flat urlset.
    const count = countLocTags(xml);
    if (count > 0) {
      return {
        url_count: count,
        source: `sitemap at ${url}`,
        sitemap_url: url,
      };
    }
  }

  return { url_count: null, source: 'no sitemap reachable', sitemap_url: null };
}
