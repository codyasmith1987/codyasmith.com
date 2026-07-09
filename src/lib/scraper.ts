import * as cheerio from 'cheerio';
import { lookup as dnsLookup } from 'node:dns/promises';

export interface ScrapedMention {
  url: string;
  source_name: string;
  source_type: 'review' | 'forum' | 'news' | 'social' | 'blog' | 'directory' | 'other';
  snippet: string;
  full_text: string;
}

// Source type detection based on URL patterns
const SOURCE_PATTERNS: { pattern: RegExp; type: ScrapedMention['source_type']; name?: string }[] = [
  { pattern: /yelp\.com/i, type: 'review', name: 'Yelp' },
  { pattern: /google\.com\/maps|maps\.google/i, type: 'review', name: 'Google' },
  { pattern: /bbb\.org/i, type: 'review', name: 'BBB' },
  { pattern: /trustpilot\.com/i, type: 'review', name: 'Trustpilot' },
  { pattern: /glassdoor\.com/i, type: 'review', name: 'Glassdoor' },
  { pattern: /tripadvisor\.com/i, type: 'review', name: 'TripAdvisor' },
  { pattern: /angi\.com|angieslist|homeadvisor/i, type: 'review', name: 'Angi' },
  { pattern: /thumbtack\.com/i, type: 'review', name: 'Thumbtack' },
  { pattern: /reddit\.com/i, type: 'forum', name: 'Reddit' },
  { pattern: /quora\.com/i, type: 'forum', name: 'Quora' },
  { pattern: /stackexchange|stackoverflow/i, type: 'forum', name: 'Stack Exchange' },
  { pattern: /facebook\.com/i, type: 'social', name: 'Facebook' },
  { pattern: /twitter\.com|x\.com/i, type: 'social', name: 'X' },
  { pattern: /linkedin\.com/i, type: 'social', name: 'LinkedIn' },
  { pattern: /instagram\.com/i, type: 'social', name: 'Instagram' },
  { pattern: /tiktok\.com/i, type: 'social', name: 'TikTok' },
  { pattern: /youtube\.com/i, type: 'social', name: 'YouTube' },
  { pattern: /nextdoor\.com/i, type: 'social', name: 'Nextdoor' },
  { pattern: /reuters\.com|apnews|cnn\.com|bbc\.com|nytimes|washingtonpost|forbes\.com|bloomberg/i, type: 'news' },
  { pattern: /news|press|gazette|herald|tribune|journal|times|post/i, type: 'news' },
  { pattern: /yellowpages|manta\.com|chamberofcommerce|hotfrog/i, type: 'directory' },
  { pattern: /blog|medium\.com|substack|wordpress\.com|tumblr/i, type: 'blog' },
];

function detectSource(url: string): { type: ScrapedMention['source_type']; name: string } {
  for (const { pattern, type, name } of SOURCE_PATTERNS) {
    if (pattern.test(url)) {
      const sourceName = name || new URL(url).hostname.replace(/^www\./, '');
      return { type, name: sourceName };
    }
  }
  try {
    return { type: 'other', name: new URL(url).hostname.replace(/^www\./, '') };
  } catch {
    return { type: 'other', name: 'Unknown' };
  }
}

// SSRF guard. Reject URLs that would let the scraper hit cloud metadata
// endpoints, loopback, link-local, or private network ranges. The scraper
// only ever needs the public web; anything else is either a misuse or an
// attacker-planted redirect.
//
// Two-stage check: cheap synchronous block on the URL itself (handles
// literal IPs and known-bad hostnames), then async DNS-resolved IP check
// that catches attacker-controlled public hostnames pointing at private
// IPs. See security-audit-2026-05-12 round 2 SEC2-002 and round 3 SEC3-001.

function ipv4DecimalIsBlocked(parts: number[]): boolean {
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 10) return true;                                  // 10.0.0.0/8
  if (a === 127) return true;                                 // loopback
  if (a === 169 && b === 254) return true;                    // link-local incl. EC2/GCP metadata
  if (a === 172 && b >= 16 && b <= 31) return true;           // 172.16.0.0/12
  if (a === 192 && b === 168) return true;                    // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT 100.64.0.0/10
  if (a === 0) return true;                                   // 0.0.0.0/8
  if (a >= 224) return true;                                  // multicast + reserved
  return false;
}

function ipv6StringIsBlocked(host: string): boolean {
  if (host === '::1' || host === '::') return true;
  if (host.startsWith('fc') || host.startsWith('fd')) return true; // unique local
  if (host.startsWith('fe80')) return true;                        // link-local
  if (host.startsWith('ff')) return true;                          // multicast
  const v4match = host.match(/::ffff:([0-9.]+)$/i);
  if (v4match) {
    const parts = v4match[1].split('.').map(Number);
    if (ipv4DecimalIsBlocked(parts)) return true;
  }
  return false;
}

function isHostnameSpecialUse(host: string): boolean {
  if (host === 'localhost' || host === 'localhost.localdomain') return true;
  if (host.endsWith('.local') || host.endsWith('.localhost') || host.endsWith('.internal')) return true;
  if (host.endsWith('.lan') || host.endsWith('.intranet') || host.endsWith('.corp') || host.endsWith('.home')) return true;
  return false;
}

// Normalize a URL hostname for SSRF checks. Node 22's URL.hostname returns
// IPv6 literals with their square brackets intact (e.g. `[::1]`); older Node
// versions strip them. We strip unconditionally so the IPv6 string checks
// below see the raw address regardless of platform.
function normalizedHost(parsed: URL): string {
  let h = parsed.hostname.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  return h;
}

function syncUrlIsRejected(rawUrl: string): { rejected: true } | { rejected: false; parsed: URL; host: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { rejected: true };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { rejected: true };
  if (parsed.username || parsed.password) return { rejected: true };

  const host = normalizedHost(parsed);
  if (!host) return { rejected: true };
  if (isHostnameSpecialUse(host)) return { rejected: true };

  // Decimal-dotted IPv4 literal. (Other IPv4 representations like hex
  // 0x7f000001 and dword 2130706433 are URL-parser dependent; the DNS
  // resolution stage below catches them by resolving to a concrete v4.)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    if (ipv4DecimalIsBlocked(host.split('.').map(Number))) return { rejected: true };
  }
  if (host.includes(':') && ipv6StringIsBlocked(host)) return { rejected: true };

  return { rejected: false, parsed, host };
}

async function isAllowedFetchUrl(rawUrl: string): Promise<boolean> {
  const sync = syncUrlIsRejected(rawUrl);
  if (sync.rejected) return false;
  const host = sync.host;

  // If host is a literal IP we already validated it. Skip DNS.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return true;

  // Resolve the hostname and reject if any A/AAAA record points into a
  // private/loopback/link-local range. all:true returns every address so
  // a multi-record host cannot launder a private IP behind a public one.
  try {
    const addrs = await dnsLookup(host, { all: true, verbatim: true });
    for (const { address, family } of addrs) {
      if (family === 4) {
        if (ipv4DecimalIsBlocked(address.split('.').map(Number))) return false;
      } else if (family === 6) {
        if (ipv6StringIsBlocked(address.toLowerCase())) return false;
      }
    }
    return true;
  } catch {
    // DNS failure: reject. A scrape against an unresolvable host has nothing
    // to gain and the SSRF posture stays conservative.
    return false;
  }
}

async function scrapeSinglePage(url: string): Promise<{ text: string; snippet: string } | null> {
  // SSRF guard runs before any network call. Redirects are followed manually
  // and revalidated to keep an attacker from bouncing through a public host
  // to a metadata IP. The guard also DNS-resolves the hostname so a public
  // name pointing at a private IP is rejected. See SEC2-002, SEC3-001, and
  // SEC4-001 (IPv6 bracket normalization).
  //
  // Known residual gap: DNS rebinding. The fetch() below re-resolves the
  // hostname independently of our validation lookup, so an attacker who
  // controls an authoritative resolver could serve a public IP to the
  // validation step and a private IP to the connect. Pinning the connect
  // to the validated IP (and rewriting the Host header) is the proper fix
  // and is deferred to a follow-up since it requires switching from native
  // fetch to undici dispatcher wiring. See SEC4-002.
  if (!(await isAllowedFetchUrl(url))) return null;
  try {
    let current = url;
    let res: Response | null = null;
    // Cap to 3 redirects total. Each Location header is re-checked against
    // the SSRF allowlist before fetching.
    for (let hop = 0; hop < 4; hop++) {
      res = await fetch(current, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) return null;
        const next = new URL(loc, current).href;
        if (!(await isAllowedFetchUrl(next))) return null;
        current = next;
        continue;
      }
      break;
    }
    if (!res || !res.ok) return null;

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) return null;

    const html = await res.text();
    const $ = cheerio.load(html);

    $('script, style, nav, footer, header, aside, iframe, noscript, svg, [role="navigation"], [role="banner"]').remove();

    const text = ($('article, main, [role="main"]').text().trim() || $('body').text().trim())
      .replace(/\s+/g, ' ')
      .trim();

    if (text.length < 30) return null;

    return { text: text.slice(0, 3000), snippet: text.slice(0, 300).trim() };
  } catch {
    return null;
  }
}

/**
 * Scrape multiple URLs in parallel with graceful per-URL failure.
 * Uses search snippets as fallback when scraping is blocked (403, captcha, timeout).
 */
export async function scrapeAll(urls: { url: string; query_type: string; fallback_snippet?: string; fallback_title?: string }[]): Promise<(ScrapedMention & { query_type: string })[]> {
  const results = await Promise.allSettled(
    urls.map(async ({ url, query_type, fallback_snippet, fallback_title }) => {
      const source = detectSource(url);
      const scraped = await scrapeSinglePage(url);

      if (scraped) {
        return {
          url,
          source_name: source.name,
          source_type: source.type,
          snippet: scraped.snippet,
          full_text: scraped.text,
          query_type,
        };
      }

      // Fallback: use the Google search snippet if scraping failed.
      // Note: NODE_TLS_REJECT_UNAUTHORIZED is no longer set here. Earlier
      // versions of this scraper disabled TLS verification process-wide so
      // sites with broken certs could be scraped; that flag also disabled
      // verification for every other outbound call (Brevo, Gemini, Serper,
      // Turso, S3), an unacceptable MITM exposure. Cert failures now drop
      // cleanly to this fallback path. See SEC2-001.
      if (fallback_snippet && fallback_snippet.length > 20) {
        return {
          url,
          source_name: source.name,
          source_type: source.type,
          snippet: fallback_snippet,
          full_text: fallback_snippet,
          query_type,
        };
      }

      return null;
    })
  );

  return results
    .filter((r): r is PromiseFulfilledResult<(ScrapedMention & { query_type: string }) | null> => r.status === 'fulfilled')
    .map(r => r.value)
    .filter((r): r is ScrapedMention & { query_type: string } => r !== null);
}
