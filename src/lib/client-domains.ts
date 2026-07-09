// Derive the set of domains under management for a client by reading
// data the admin has already uploaded.
//
// Three data sources today:
//   - crawl_urls: per-URL rows from Screaming Frog Internal HTML
//     uploads. Hostname is pre-computed at parse time so the lookup
//     is a cheap GROUP BY on an indexed column.
//   - raw_csv_data: fallback only for authoritative internal crawl
//     files (internal_html.csv / internal_all.csv) that were stored
//     raw because detection missed them.
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
import Papa from 'papaparse';

export type ClientDomainSource = 'crawl_urls' | 'raw_csv_data' | 'keyword_rankings';

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

function normalizeHeader(header: string): string {
  return (header || '').replace(/^\uFEFF/, '').trim().toLowerCase();
}

export function isAuthoritativeRawCrawlFile(filename: string | null | undefined): boolean {
  if (!filename) return false;
  const base = filename.replace(/^.*[\\/]/, '').trim().toLowerCase().split(':').pop() || '';
  return base === 'internal_html.csv' || base === 'internal_all.csv';
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

const RAW_URL_COLUMNS = [
  'address',
  'url',
  'ranking url',
  'landing page',
];

function pickRawUrlColumn(headers: string[]): number {
  const normalized = headers.map(normalizeHeader);
  for (const wanted of RAW_URL_COLUMNS) {
    const idx = normalized.indexOf(wanted);
    if (idx >= 0) return idx;
  }
  return -1;
}

export function deriveDomainsFromRawCsvText(
  raw: string,
  opts: {
    sampleLimit?: number;
    filename?: string | null;
    requireAuthoritativeFilename?: boolean;
  } = {},
): DerivedClientDomain[] {
  if (opts.requireAuthoritativeFilename && !isAuthoritativeRawCrawlFile(opts.filename)) {
    return [];
  }
  const sampleLimit = opts.sampleLimit ?? 50000;
  const parsed = Papa.parse(raw, { header: false, skipEmptyLines: true });
  const rows = parsed.data as string[][];
  if (!Array.isArray(rows) || rows.length < 2) return [];

  const headers = (rows[0] || []).map(v => String(v || ''));
  const urlIdx = pickRawUrlColumn(headers);
  if (urlIdx < 0) return [];

  const counts = new Map<string, { sample: string; count: number }>();
  for (const row of rows.slice(1, sampleLimit + 1)) {
    const rawUrl = String(row?.[urlIdx] || '');
    const host = extractHostnameFromUrl(rawUrl);
    if (!host) continue;
    const existing = counts.get(host);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(host, { sample: rawUrl, count: 1 });
    }
  }

  return Array.from(counts.entries()).map(([domain, info]) => ({
    domain,
    source: 'raw_csv_data' as const,
    url_sample: info.sample,
    url_count: info.count,
  }));
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

  // Source 2: raw_csv_data. Only trust authoritative internal crawl
  // files. Generic URL/outlink/export tables contain third-party
  // embeds, social profiles, analytics scripts, lenders, maps, and
  // other external hosts. Those are useful audit data, but they are
  // NOT client-managed sites. The prod Zip Kit backfill proved this
  // the hard way: raw url_all/validation files yielded youtube.com,
  // google.com, facebook.com, etc. and syncDetectedDomains inserted
  // them as managed sites. Keep raw fallback narrow: it exists to
  // recover Internal HTML/Internal All crawls that the typed parser
  // missed, not to infer ownership from arbitrary URLs.
  try {
    const rawRows = await turso.execute({
      sql: `SELECT filename, raw_text
            FROM raw_csv_data
            WHERE client_id = ?
              AND (
                lower(filename) IN ('internal_html.csv', 'internal_all.csv')
                OR lower(filename) LIKE '%:internal_html.csv'
                OR lower(filename) LIKE '%:internal_all.csv'
              )
            ORDER BY
              CASE
                WHEN lower(filename) = 'internal_html.csv' THEN 0
                WHEN lower(filename) = 'internal_all.csv' THEN 1
                ELSE 4
              END,
              created_at DESC
            LIMIT 100`,
      args: [clientId],
    });
    const rawCounts = new Map<string, { sample: string; count: number }>();
    for (const row of rawRows.rows as any[]) {
      const filename = String(row[0] || '');
      const raw = String(row[1] || '');
      for (const derived of deriveDomainsFromRawCsvText(raw, {
        sampleLimit: 50000,
        filename,
        requireAuthoritativeFilename: true,
      })) {
        const existing = rawCounts.get(derived.domain);
        if (existing) {
          existing.count += derived.url_count;
        } else {
          rawCounts.set(derived.domain, { sample: derived.url_sample, count: derived.url_count });
        }
      }
    }
    for (const [host, info] of rawCounts.entries()) {
      if (byDomain.has(host)) continue; // typed crawl data wins
      byDomain.set(host, {
        domain: host,
        source: 'raw_csv_data',
        url_sample: info.sample,
        url_count: info.count,
      });
    }
  } catch {
    // raw_csv_data may not exist on stale databases; treat as empty.
  }

  // Source 3: keyword_rankings.url. Read a bounded slice and extract
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

  // Order: typed crawl data first, then raw stored CSV fallback, then
  // keyword rankings. Within the same source, larger URL count wins.
  return Array.from(byDomain.values()).sort((a, b) => {
    const weight = { crawl_urls: 0, raw_csv_data: 1, keyword_rankings: 2 } as const;
    if (a.source !== b.source) return weight[a.source] - weight[b.source];
    if (a.url_count !== b.url_count) return b.url_count - a.url_count;
    return a.domain.localeCompare(b.domain);
  });
}

// Exported for unit tests.
export { normalizeHostname, extractHostnameFromUrl };
