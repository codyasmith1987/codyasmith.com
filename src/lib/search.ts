// Smart search engine: 4 targeted queries per scan via Serper.dev (Google Search API)
// Free tier: 2,500 queries, no credit card

export interface SearchResult {
  url: string;
  title: string;
  description: string;
  query_type: 'reviews' | 'complaints' | 'testimonials' | 'domain';
}

interface SerperResult {
  title: string;
  link: string;
  snippet: string;
}

interface SerperResponse {
  organic?: SerperResult[];
}

async function serperSearch(query: string, apiKey: string, num = 5): Promise<SerperResult[]> {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ q: query, num }),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    console.error(`Serper search error: ${res.status} ${await res.text()}`);
    return [];
  }

  const data: SerperResponse = await res.json();
  return data.organic || [];
}

/**
 * Construct 4 smart queries from the input.
 *
 * Key principle: we want what OTHER PEOPLE say about the brand.
 * Not the brand's own website, social profiles, or marketing.
 *
 * Review sites and Reddit are gold — those are real people talking.
 * Brand-owned social pages are noise — that's the company talking about itself.
 */
function buildQueries(brand: string, domain: string | null): { query: string; type: SearchResult['query_type'] }[] {
  const q = `"${brand}"`;
  const ownSite = domain || (brand.toLowerCase().replace(/[^a-z0-9]/g, '') + '.com');

  const queries: { query: string; type: SearchResult['query_type'] }[] = [
    // 1. Review platforms: real consumer reviews
    { query: `${q} site:yelp.com OR site:trustpilot.com OR site:bbb.org OR site:consumeraffairs.com OR site:glassdoor.com`, type: 'reviews' },
    // 2. Reddit + forums: real discussions (not brand accounts)
    { query: `${q} site:reddit.com OR site:quora.com`, type: 'complaints' },
    // 3. News + independent coverage about the brand
    { query: `${q} review OR complaint OR experience OR opinion -site:${ownSite}`, type: 'testimonials' },
    // 4. Broader web: anything people say, excluding owned properties
    { query: `${q} recommended OR terrible OR "stay away" OR "love this" OR "would not" -site:${ownSite}`, type: 'domain' },
  ];

  return queries;
}

/**
 * Extract brand name from a domain.
 */
export function brandFromDomain(domain: string): string {
  const name = domain
    .replace(/^www\./, '')
    .replace(/\.(com|net|org|io|co|biz|us|info)$/i, '')
    .replace(/[-_]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
  return name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Parse the input to determine if it's a URL or brand name.
 */
export function parseInput(input: string): { brand: string; domain: string | null; inputType: 'url' | 'brand' } {
  const trimmed = input.trim();
  try {
    const url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    if (url.hostname.includes('.')) {
      const domain = url.hostname.replace(/^www\./, '');
      return { brand: brandFromDomain(domain), domain, inputType: 'url' };
    }
  } catch {}
  return { brand: trimmed, domain: null, inputType: 'brand' };
}

/**
 * Build a list of domains to exclude (the brand's own properties).
 * Works even when only a brand name is provided (no explicit domain).
 */
function buildExcludedDomains(brand: string, domain: string | null): string[] {
  const excluded: string[] = [];

  if (domain) {
    excluded.push(domain.toLowerCase());
  }

  // Derive likely owned domains from the brand name
  // "Starbucks" -> starbucks.com, starbucks.co, etc.
  const slug = brand.toLowerCase()
    .replace(/[^a-z0-9]/g, '')  // "Acme Plumbing" -> "acmeplumbing"
    .trim();

  if (slug.length >= 3) {
    excluded.push(`${slug}.com`);
    excluded.push(`${slug}.co`);
    excluded.push(`${slug}.net`);
    excluded.push(`${slug}.org`);
  }

  // Also try hyphenated/spaced versions: "Acme Plumbing" -> "acme-plumbing.com"
  const hyphenated = brand.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').trim();
  if (hyphenated !== slug && hyphenated.length >= 3) {
    excluded.push(`${hyphenated}.com`);
  }

  return excluded;
}

/**
 * Detect if a URL belongs to the brand (own website, social profiles, etc.)
 * This catches:
 * - Brand's own domain (starbucks.com, *.starbucks.com)
 * - Brand's social profiles (facebook.com/starbucks, youtube.com/@starbucks)
 * - Brand's official pages on any platform
 */
function isOwnContent(url: string, excludedDomains: string[], brandSlug: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const pathname = parsed.pathname.toLowerCase();

    // Check if it's the brand's own domain
    if (excludedDomains.some(d => hostname === d || hostname.endsWith('.' + d))) return true;

    // Check if it's a brand-owned social profile
    // e.g. facebook.com/starbucks, twitter.com/starbucks, youtube.com/@starbucks
    const socialPlatforms = ['facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'linkedin.com', 'youtube.com', 'tiktok.com', 'pinterest.com'];
    if (socialPlatforms.some(p => hostname === p || hostname.endsWith('.' + p))) {
      // Check if the first path segment is the brand name (their profile page)
      const firstSegment = pathname.split('/').filter(Boolean)[0]?.replace('@', '') || '';
      if (firstSegment && brandSlug && (
        firstSegment === brandSlug ||
        firstSegment.includes(brandSlug) ||
        brandSlug.includes(firstSegment)
      )) {
        return true;
      }
      // Also check for /channel/, /user/, /company/ patterns with brand name
      if (pathname.includes(brandSlug)) return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Run the full search: 4 queries, 5 results each, deduplicated.
 * Filters out the brand's own domains — we only want external mentions.
 */
export async function searchForMentions(brand: string, domain: string | null, apiKey: string): Promise<SearchResult[]> {
  const queries = buildQueries(brand, domain);
  const excludedDomains = buildExcludedDomains(brand, domain);
  const brandSlug = brand.toLowerCase().replace(/[^a-z0-9]/g, '');
  const seen = new Set<string>();
  const results: SearchResult[] = [];

  // Run all 4 queries in parallel
  const queryResults = await Promise.all(
    queries.map(async ({ query, type }) => {
      try {
        const hits = await serperSearch(query, apiKey, 8);
        return hits.map(h => ({ url: h.link, title: h.title, description: h.snippet, query_type: type }));
      } catch (err) {
        console.error(`Search query failed (${type}):`, err);
        return [];
      }
    })
  );

  for (const hits of queryResults) {
    for (const hit of hits) {
      const key = hit.url.split('?')[0].toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      // Skip the brand's own content — website, social profiles, official pages
      if (isOwnContent(hit.url, excludedDomains, brandSlug)) continue;
      results.push({
        url: hit.url,
        title: hit.title,
        description: hit.description,
        query_type: hit.query_type as SearchResult['query_type'],
      });
    }
  }

  return results;
}
