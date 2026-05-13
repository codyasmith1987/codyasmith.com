export const prerender = false;

import type { APIRoute } from 'astro';
import { parseInput, searchForMentions } from '../../lib/search';
import { logger } from '../../lib/logger';
import { scrapeAll } from '../../lib/scraper';
import { generateReport } from '../../lib/sentiment';
import { getRecommendation } from '../../lib/recommend';
import { createScan, updateScan, insertMention, checkRateLimit, incrementRateLimit, getMonthlySearchCount } from '../../lib/db';
import { rateLimit } from '../../lib/rate-limit';

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const json = (s: any, status = 200) => new Response(JSON.stringify(s), {
    status, headers: { 'Content-Type': 'application/json' },
  });

  try {
    const body = await request.json();
    const input = typeof body.input === 'string' ? body.input.trim() : '';
    const timestamp = typeof body.timestamp === 'number' ? body.timestamp : 0;
    const location = typeof body.location === 'string' ? body.location.trim() || null : null;
    const industry = typeof body.industry === 'string' ? body.industry.trim() || null : null;
    const exclude = typeof body.exclude === 'string' ? body.exclude.trim() || null : null;

    if (!input || input.length > 200) {
      return json({ error: 'Enter a brand name or URL (200 characters max)' }, 400);
    }

    // Bot protection: require at least 2 seconds between page load and submission
    if (!timestamp || timestamp > Date.now() || Date.now() - timestamp < 2000) {
      return json({ error: 'Please wait a moment before scanning' }, 429);
    }

    // Rate limiting: 3 scans per day per IP (long-window cap) plus a
    // tighter hourly cap to slow rapid bursts. The portal_rate_limits
    // bucket is keyed by IP and runs fail-closed for the hourly window
    // since a Turso outage should not open the door to Serper/Gemini
    // cost amplification. See SEC-028.
    const ip = clientAddress || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    if (ip === 'unknown') {
      return json({ error: 'Could not verify your request' }, 400);
    }
    if (!await rateLimit(`scan:hour:${ip}`, 2, 60 * 60 * 1000, true)) {
      return json({
        error: 'Slow down. You can run two scans per hour.',
        rate_limited: true,
      }, 429);
    }
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
      logger.error('SERPER_API_KEY not set');
      return json({ error: 'Search service not configured' }, 500);
    }

    // Parse input
    const { brand, domain, inputType } = parseInput(input);

    // Increment rate limit BEFORE creating scan to avoid orphaned records
    await incrementRateLimit(ip);

    // Create scan record
    const scanId = await createScan(brand, domain, inputType);

    // Stream progress via SSE
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const emit = (step: string, status: string, detail: string, data?: any) => {
          const event = JSON.stringify({ step, status, detail, ...(data ? { data } : {}) });
          controller.enqueue(encoder.encode(`data: ${event}\n\n`));
        };

        try {
          // Step 1: Search
          emit('search', 'active', 'Searching the web for mentions...');
          const searchResults = await searchForMentions(brand, domain, serperKey, { location, industry, exclude });
          emit('search', 'done', `Found ${searchResults.length} mentions across the web`);

          if (searchResults.length === 0) {
            await updateScan(scanId, {
              overall_score: 50, overall_label: 'Unknown', mention_count: 0,
              summary: 'No mentions found. This brand may have limited online presence, or the name may be too common. Try adding a city or industry to your search.',
              top_positive_phrases: '[]', top_negative_phrases: '[]', source_breakdown: '{}',
            });
            emit('complete', 'done', 'Report ready', {
              scan_id: scanId, brand, domain, overall_score: 50, overall_label: 'Unknown',
              mention_count: 0, summary: 'No mentions found. This brand may have limited online presence.',
              sample_mentions: [], source_breakdown: {}, teaser_lines: [],
            });
            controller.close();
            return;
          }

          // Step 2: Scrape
          emit('scrape', 'active', `Reading ${searchResults.length} pages...`);
          const scraped = await scrapeAll(searchResults.map(r => ({
            url: r.url, query_type: r.query_type,
            fallback_snippet: r.description, fallback_title: r.title,
          })));
          emit('scrape', 'done', `Read ${scraped.length} pages`);

          // Step 3: Analyze
          emit('analyze', 'active', `Analyzing sentiment across ${scraped.length} mentions...`);
          const report = await generateReport(scraped, brand, {
            onMentionScored: (idx, total) => {
              if (total > 10) {
                emit('analyze', 'progress', `Scoring ${idx + 1} of ${total} mentions`);
              }
            },
          });
          emit('analyze', 'done', `Sentiment analysis complete. Score: ${report.overall_score}`);

          // Step 4: Report
          emit('report', 'active', 'Building your report...');

          for (const m of report.mentions) {
            await insertMention({
              scan_id: scanId, url: m.url, source_name: m.source_name,
              source_type: m.source_type, snippet: m.snippet,
              sentiment_score: m.sentiment_score, sentiment_label: m.sentiment_label,
              key_phrases: JSON.stringify(m.key_phrases), query_type: m.query_type,
            });
          }

          await updateScan(scanId, {
            overall_score: report.overall_score, overall_label: report.overall_label,
            mention_count: report.mention_count, summary: report.summary,
            top_positive_phrases: JSON.stringify(report.top_positive_phrases),
            top_negative_phrases: JSON.stringify(report.top_negative_phrases),
            source_breakdown: JSON.stringify(report.source_breakdown),
          });

          const recommendation = getRecommendation(report.overall_score, report.mention_count);

          emit('report', 'done', 'Report ready!');
          emit('complete', 'done', 'Report ready', {
            scan_id: scanId, brand, domain,
            overall_score: report.overall_score, overall_label: report.overall_label,
            mention_count: report.mention_count, summary: report.summary,
            sample_mentions: report.sample_mentions,
            source_breakdown: report.source_breakdown,
            teaser_lines: report.teaser_lines, recommendation,
          });
        } catch (err: any) {
          // Log full detail server-side; show only a generic message to the
          // client. err.message may carry Serper/Gemini internals or URLs.
          logger.error('Scan stream error', err);
          emit('error', 'error', 'Scan failed. Please try again in a few minutes.');
        }
        controller.close();
      }
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });

  } catch (err: any) {
    logger.error('Scan error', err);
    return json({ error: 'Scan failed. Please try again in a few minutes.' }, 500);
  }
};
