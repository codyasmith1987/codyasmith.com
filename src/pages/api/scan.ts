export const prerender = false;

import type { APIRoute } from 'astro';
import { parseInput, searchForMentions } from '../../lib/search';
import { scrapeAll } from '../../lib/scraper';
import { generateReport } from '../../lib/sentiment';
import { createScan, updateScan, insertMention, checkRateLimit, incrementRateLimit, getMonthlySearchCount } from '../../lib/db';

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const json = (s: any, status = 200) => new Response(JSON.stringify(s), {
    status, headers: { 'Content-Type': 'application/json' },
  });

  try {
    const body = await request.json();
    const input = body.input?.trim();
    const timestamp = body.timestamp;

    if (!input) return json({ error: 'Enter a brand name or URL' }, 400);

    // Bot protection: require at least 2 seconds between page load and submission
    if (timestamp && Date.now() - timestamp < 2000) {
      return json({ error: 'Please wait a moment before scanning' }, 429);
    }

    // Rate limiting: 3 scans per day per IP
    const ip = clientAddress || request.headers.get('x-forwarded-for') || 'unknown';
    const rateCheck = await checkRateLimit(ip);
    if (!rateCheck.allowed) {
      return json({
        error: "You've used your free scans for today. Come back tomorrow or contact me for a full audit.",
        rate_limited: true,
      }, 429);
    }

    // Global budget check: reserve 200 searches as buffer
    const monthlySearches = await getMonthlySearchCount();
    if (monthlySearches >= 1800) {
      return json({
        error: 'High demand right now. Try again later or contact me directly for a brand audit.',
        capacity: true,
      }, 503);
    }

    // Serper API key
    const serperKey = import.meta.env.SERPER_API_KEY;
    if (!serperKey) {
      console.error('SERPER_API_KEY not set');
      return json({ error: 'Search service not configured' }, 500);
    }

    // Parse input
    const { brand, domain, inputType } = parseInput(input);

    // Create scan record
    const scanId = await createScan(brand, domain, inputType);

    // Increment rate limit
    await incrementRateLimit(ip);

    // Search for mentions (4 queries, 5 results each)
    const searchResults = await searchForMentions(brand, domain, serperKey);

    if (searchResults.length === 0) {
      await updateScan(scanId, {
        overall_score: 50,
        overall_label: 'Unknown',
        mention_count: 0,
        summary: 'No mentions found. This brand may have limited online presence, or the name may be too common. Try adding a city or industry to your search.',
        top_positive_phrases: '[]',
        top_negative_phrases: '[]',
        source_breakdown: '{}',
      });
      return json({
        scan_id: scanId,
        brand,
        domain,
        overall_score: 50,
        overall_label: 'Unknown',
        mention_count: 0,
        summary: 'No mentions found. This brand may have limited online presence.',
        sample_mentions: [],
        source_breakdown: {},
        teaser_lines: [],
      });
    }

    // Scrape all found URLs in parallel
    const scraped = await scrapeAll(searchResults.map(r => ({ url: r.url, query_type: r.query_type })));

    // Generate the full report
    const report = generateReport(scraped);

    // Store mentions in DB
    for (const m of report.mentions) {
      await insertMention({
        scan_id: scanId,
        url: m.url,
        source_name: m.source_name,
        source_type: m.source_type,
        snippet: m.snippet,
        sentiment_score: m.sentiment_score,
        sentiment_label: m.sentiment_label,
        key_phrases: JSON.stringify(m.key_phrases),
        query_type: m.query_type,
      });
    }

    // Update scan with aggregate results
    await updateScan(scanId, {
      overall_score: report.overall_score,
      overall_label: report.overall_label,
      mention_count: report.mention_count,
      summary: report.summary,
      top_positive_phrases: JSON.stringify(report.top_positive_phrases),
      top_negative_phrases: JSON.stringify(report.top_negative_phrases),
      source_breakdown: JSON.stringify(report.source_breakdown),
    });

    // Return Tier 1 data (ungated preview)
    return json({
      scan_id: scanId,
      brand,
      domain,
      overall_score: report.overall_score,
      overall_label: report.overall_label,
      mention_count: report.mention_count,
      summary: report.summary,
      sample_mentions: report.sample_mentions,
      source_breakdown: report.source_breakdown,
      teaser_lines: report.teaser_lines,
    });

  } catch (err: any) {
    console.error('Scan error:', err);
    return json({ error: err.message || 'Scan failed' }, 500);
  }
};
