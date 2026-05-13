import * as cheerio from 'cheerio';

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
// attacker-planted redirect. See security-audit-2026-05-12 round 2 SEC2-002.
function isAllowedFetchUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false; // strip credentials surface

  const host = parsed.hostname.toLowerCase();
  if (!host) return false;

  // Hostname-based blocks (covers localhost variants and special-use names).
  if (host === 'localhost' || host === 'localhost.localdomain') return false;
  if (host.endsWith('.local') || host.endsWith('.localhost') || host.endsWith('.internal')) return false;
  if (host.endsWith('.lan') || host.endsWith('.intranet') || host.endsWith('.corp') || host.endsWith('.home')) return false;

  // IPv4 literal blocks.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const parts = host.split('.').map(Number);
    if (parts.some(n => Number.isNaN(n) || n < 0 || n > 255)) return false;
    const [a, b] = parts;
    if (a === 10) return false;                                  // 10.0.0.0/8
    if (a === 127) return false;                                 // loopback
    if (a === 169 && b === 254) return false;                    // link-local incl. EC2/GCP metadata at 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return false;           // 172.16.0.0/12
    if (a === 192 && b === 168) return false;                    // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return false;          // CGNAT 100.64.0.0/10
    if (a === 0) return false;                                   // 0.0.0.0/8
    if (a >= 224) return false;                                  // multicast + reserved
  }

  // IPv6 literal blocks. URL hostnames keep brackets stripped after .hostname.
  if (host.includes(':')) {
    if (host === '::1' || host === '::' ) return false;
    if (host.startsWith('fc') || host.startsWith('fd')) return false; // unique local
    if (host.startsWith('fe80')) return false;                       // link-local
    if (host.startsWith('ff')) return false;                         // multicast
    // Block IPv4-mapped (::ffff:a.b.c.d) by re-checking the v4 tail.
    const v4match = host.match(/::ffff:([0-9.]+)$/i);
    if (v4match && !isAllowedFetchUrl(`${parsed.protocol}//${v4match[1]}`)) return false;
  }

  return true;
}

async function scrapeSinglePage(url: string): Promise<{ text: string; snippet: string } | null> {
  // SSRF guard runs before any network call. Redirects are followed manually
  // and revalidated to keep an attacker from bouncing through a public host
  // to a metadata IP. See SEC2-002.
  if (!isAllowedFetchUrl(url)) return null;
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
        if (!isAllowedFetchUrl(next)) return null;
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
