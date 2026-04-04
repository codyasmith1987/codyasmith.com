import * as cheerio from 'cheerio';
import { Agent } from 'https';

const agent = new Agent({ rejectUnauthorized: false });

export interface ScrapedPage {
  url: string;
  title: string;
  text: string;
}

export async function scrapePage(url: string): Promise<ScrapedPage> {
  // Use undici dispatcher to bypass TLS cert issues on managed machines
  const fetchOptions: any = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; WebListener/1.0)',
      'Accept': 'text/html',
    },
    signal: AbortSignal.timeout(15000),
  };

  // For Node.js environments with TLS issues
  if (url.startsWith('https')) {
    (fetchOptions as any).dispatcher = undefined; // let Node handle it
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

  const response = await fetch(url, fetchOptions);

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  // Remove non-content elements
  $('script, style, nav, footer, header, aside, iframe, noscript, svg, [role="navigation"], [role="banner"], [aria-hidden="true"]').remove();

  const title = $('title').first().text().trim()
    || $('h1').first().text().trim()
    || 'Untitled';

  // Get the main content text
  const text = $('article, main, [role="main"]').text().trim()
    || $('body').text().trim();

  // Clean up whitespace
  const cleaned = text
    .replace(/\s+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 6000); // Keep it under Claude's sweet spot for fast analysis

  if (cleaned.length < 50) {
    throw new Error('Page has too little readable content to analyze');
  }

  return { url, title, text: cleaned };
}
