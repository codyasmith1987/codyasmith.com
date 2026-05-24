// Derive the set of domains under management for a client by reading
// data the admin has already uploaded.
//
// Two data sources today:
//   - crawl_urls: per-URL rows from Screaming Frog Internal HTML
//     uploads. Hostname is pre-computed at parse time so the lookup
//     is a cheap GROUP BY on an indexed column.
//   - keyword_rankings.url: rank-tracking uploads (Ahrefs / SEMrush
//     style). One row per ranking entry; hostname extracted at read
//     time.
//
// Both sources feed the same dedup + lowercase + strip-leading-www
// normalization. Distinct subdomains other than www stay separate
// because each is its own site under Web Management.
//
// Clients with neither upload return an empty array. The wizard
// falls back to the manual single-domain input in that case.

import turso from './turso';

export type ClientDomainSource = 'crawl_urls' | 'keyword_rankings';

export interface DerivedClientDomain {
  domain: string;
  source: ClientDomainSource;
  url_sample: string;             // one example URL the domain was derived from
  url_count: number;              // how many URLs the source had on this domain
}

const DOMAIN_RE = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i;

function normalizeHostname(host: string): string | null {
  if (!host) return null;
  let h = host.trim().toLowerCase();
  const colon = h.indexOf(':');
  if (colon !== -1) h = h.slice(0, colon);
  if (h.startsWith('www.')) h = h.slice(4);
  if (!DOMAIN_RE.test(h)) return null;
  return h;
}

function extractHostnameFromUrl(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withProtocol);
    return normalizeHostname(u.hostname);
  } catch {
    return null;
  }
}

export async function getClientDomainsFromData(clientId: string, opts: { sampleLimit?: number } = {}): Promise<DerivedClientDomain[]> {
  const sampleLimit = opts.sampleLimit ?? 50;

  // Map of normalized hostname -> { source, url_sample, count }. When
  // both crawl_urls and keyword_rankings cover the same hostname,
  // crawl_urls wins as the source attribution because Screaming Frog
  // is the canonical "the admin crawled this site" signal.
  const byDomain = new Map<string, DerivedClientDomain>();

  // Source 1: crawl_urls. Hostname is already normalized at parse
  // time so the GROUP BY is straightforward.
  try {
    const crawl = await turso.execute({
      sql: `SELECT hostname, COUNT(*) as cnt, MIN(url) as sample_url
            FROM crawl_urls
            WHERE client_id = ?
            GROUP BY hostname`,
      args: [clientId],
    });
    for (const row of crawl.rows as any[]) {
      const host = normalizeHostname(String(row[0] || ''));
      if (!host) continue;
      byDomain.set(host, {
        domain: host,
        source: 'crawl_urls',
        url_sample: String(row[2] || ''),
        url_count: Number(row[1] || 0),
      });
    }
  } catch {
    // Table may not exist yet on stale databases; treat as empty.
  }

  // Source 2: keyword_rankings.url. Read a bounded slice and extract
  // hostnames at read time. Counts are within the sampled slice, not
  // the full table; that's fine for ordering, not for analytics.
  try {
    const ranks = await turso.execute({
      sql: `SELECT DISTINCT url FROM keyword_rankings
            WHERE client_id = ? AND url IS NOT NULL AND url != ""
            LIMIT ?`,
      args: [clientId, sampleLimit],
    });
    const rankCounts = new Map<string, { sample: string; count: number }>();
    for (const row of ranks.rows as any[]) {
      const url = String(row[0] || '');
      const host = extractHostnameFromUrl(url);
      if (!host) continue;
      const existing = rankCounts.get(host);
      if (existing) {
        existing.count += 1;
      } else {
        rankCounts.set(host, { sample: url, count: 1 });
      }
    }
    for (const [host, info] of rankCounts.entries()) {
      if (byDomain.has(host)) continue; // crawl_urls wins
      byDomain.set(host, {
        domain: host,
        source: 'keyword_rankings',
        url_sample: info.sample,
        url_count: info.count,
      });
    }
  } catch {
    // Table missing or query fails: ignore this source.
  }

  // Order: crawl_urls first (by URL count desc), then keyword_rankings.
  return Array.from(byDomain.values()).sort((a, b) => {
    if (a.source !== b.source) return a.source === 'crawl_urls' ? -1 : 1;
    if (a.url_count !== b.url_count) return b.url_count - a.url_count;
    return a.domain.localeCompare(b.domain);
  });
}

// Exported for unit tests.
export { normalizeHostname, extractHostnameFromUrl };
