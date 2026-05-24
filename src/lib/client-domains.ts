// Derive the set of domains under management for a client by reading
// data the admin has already uploaded.
//
// Today the only per-URL table is keyword_rankings (one row per
// ranking entry from Ahrefs/SEMrush-style uploads, with a `url`
// column). Each URL parses to a hostname; we lowercase, strip a
// leading "www.", and dedupe. Subdomains other than www stay
// distinct because each is a separate site under WM.
//
// Future work: csv_uploads can FK to a sites table once Screaming
// Frog crawl files store per-URL rows, not just aggregate metrics.
// Until then this is best-effort: clients without rank-tracking
// uploads return an empty array and the wizard falls back to the
// manual single-domain input.

import turso from './turso';

export interface DerivedClientDomain {
  domain: string;
  source: 'keyword_rankings';
  url_sample: string;             // one example URL the domain was derived from
}

const DOMAIN_RE = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i;

function normalizeHostname(host: string): string | null {
  if (!host) return null;
  let h = host.trim().toLowerCase();
  // Strip port.
  const colon = h.indexOf(':');
  if (colon !== -1) h = h.slice(0, colon);
  // Collapse leading "www.".
  if (h.startsWith('www.')) h = h.slice(4);
  if (!DOMAIN_RE.test(h)) return null;
  return h;
}

function extractHostnameFromUrl(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  // Add a protocol if missing so the URL parser accepts it.
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withProtocol);
    return normalizeHostname(u.hostname);
  } catch {
    return null;
  }
}

export async function getClientDomainsFromData(clientId: string, opts: { limit?: number } = {}): Promise<DerivedClientDomain[]> {
  const limit = opts.limit ?? 50;
  const result = await turso.execute({
    sql: 'SELECT DISTINCT url FROM keyword_rankings WHERE client_id = ? AND url IS NOT NULL AND url != "" LIMIT ?',
    args: [clientId, limit],
  });

  // Group by normalized hostname, keep one example URL per domain.
  const byDomain = new Map<string, string>();
  for (const row of result.rows as any[]) {
    const url = String(row[0] || '');
    const host = extractHostnameFromUrl(url);
    if (!host) continue;
    if (!byDomain.has(host)) byDomain.set(host, url);
  }

  return Array.from(byDomain.entries())
    .map(([domain, url_sample]) => ({ domain, source: 'keyword_rankings' as const, url_sample }))
    .sort((a, b) => a.domain.localeCompare(b.domain));
}

// Exported helpers for unit tests.
export { normalizeHostname, extractHostnameFromUrl };
