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

async function scrapeSinglePage(url: string): Promise<{ text: string; snippet: string } | null> {
  try {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return null;

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

      // Fallback: use the Google search snippet if scraping failed
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
