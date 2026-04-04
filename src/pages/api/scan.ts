export const prerender = false;

import type { APIRoute } from 'astro';
import { parseInput, searchForMentions } from '../../lib/search';
import { scrapeAll } from '../../lib/scraper';
import { generateReport } from '../../lib/sentiment';
import { getRecommendation } from '../../lib/recommend';
import { createScan, updateScan, insertMention, checkRateLimit, incrementRateLimit, getMonthlySearchCount, getScan, getMentions, getCachedScan, setCacheEntry } from '../../lib/db';
import { fetchTrustpilotData } from '../../lib/trustpilot';
import { deriveCategoryAndConfidence } from '../../lib/sentiment';
import { generateDiagnostic } from '../../lib/diagnostic';
import type { ScrapedMention } from '../../lib/scraper';
import { createHash } from 'crypto';

/**
 * Reciprocal Rank Fusion (Cormack, Clarke & Butt, SIGIR 2009)
 * RRF_score(d) = Σ 1/(k + rank_i(d))
 * k=60 is optimal per the original paper.
 * Works purely on ranks — no score normalization needed across sources.
 */
function rrfMerge(
  serperResults: (ScrapedMention & { query_type: string })[],
  trustpilotResults: (ScrapedMention & { query_type: string })[],
  k = 60
): (ScrapedMention & { query_type: string })[] {
  const scores = new Map<string, { score: number; mention: ScrapedMention & { query_type: string } }>();

  // Score Serper results by their rank
  serperResults.forEach((m, rank) => {
    const key = m.url;
    const existing = scores.get(key);
    const rrfScore = 1 / (k + rank);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scores.set(key, { score: rrfScore, mention: m });
    }
  });

  // Score Trustpilot results by their rank
  trustpilotResults.forEach((m, rank) => {
    const key = m.url + '#tp-' + rank; // Trustpilot reviews share URL, so key by index
    scores.set(key, { score: 1 / (k + rank), mention: m });
  });

  // Sort by combined RRF score descending
  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .map(s => s.mention);
}

function cacheKey(brand: string, location?: string | null, industry?: string | null): string {
  const raw = [brand.toLowerCase().trim(), location?.toLowerCase().trim() || '', industry?.toLowerCase().trim() || ''].join('|');
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const json = (s: any, status = 200) => new Response(JSON.stringify(s), {
    status, headers: { 'Content-Type': 'application/json' },
  });

  try {
    const body = await request.json();
    const input = body.input?.trim();
    const timestamp = body.timestamp;
    const location = body.location?.trim() || null;
    const industry = body.industry?.trim() || null;
    const exclude = body.exclude?.trim() || null;

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

    // Parse input
    const { brand, domain, inputType } = parseInput(input);

    // Check cache: same brand + location + industry within 24 hours
    const key = cacheKey(brand, location, industry);
    const cachedScanId = await getCachedScan(key);
    if (cachedScanId) {
      const cachedScan = await getScan(cachedScanId);
      if (cachedScan && cachedScan.overall_score !== null) {
        const cachedMentions = await getMentions(cachedScanId);
        // Still count against rate limit
        await incrementRateLimit(ip);

        const recommendation = getRecommendation(cachedScan.overall_score, cachedScan.mention_count, cachedScan.brand);
        const derived = deriveCategoryAndConfidence(cachedScan.overall_score, cachedScan.mention_count);
        const sampleMentions = cachedMentions.slice(0, 3).map(m => ({
          url: m.url,
          source_name: m.source_name,
          source_type: m.source_type,
          snippet: m.snippet,
          sentiment_score: m.sentiment_score,
          sentiment_label: m.sentiment_label,
          key_phrases: m.key_phrases ? JSON.parse(m.key_phrases) : [],
          query_type: m.query_type,
        }));

        return json({
          scan_id: cachedScanId,
          brand: cachedScan.brand,
          domain: cachedScan.domain,
          overall_score: cachedScan.overall_score,
          overall_label: derived.overall_label,
          overall_category: derived.overall_category,
          confidence_level: derived.confidence_level,
          confidence_note: derived.confidence_note,
          mention_count: cachedScan.mention_count,
          summary: cachedScan.summary,
          sample_mentions: sampleMentions,
          source_breakdown: cachedScan.source_breakdown ? JSON.parse(cachedScan.source_breakdown) : {},
          teaser_lines: [],
          recommendation,
          cached: true,
        });
      }
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

    // Create scan record
    const scanId = await createScan(brand, domain, inputType);

    // Increment rate limit
    await incrementRateLimit(ip);

    // Run Serper search and Trustpilot lookup in parallel
    const [searchResults, trustpilotData] = await Promise.all([
      searchForMentions(brand, domain, serperKey, { location, industry, exclude }),
      domain ? fetchTrustpilotData(domain) : Promise.resolve({ business: null, reviews: [] }),
    ]);

    const totalSources = searchResults.length + trustpilotData.reviews.length;

    if (totalSources === 0) {
      // Build response with Trustpilot summary if available (even with no reviews)
      const tpSummary = trustpilotData.business
        ? ` Trustpilot shows ${trustpilotData.business.numberOfReviews} reviews with a ${trustpilotData.business.trustScore}/5 trust score.`
        : '';

      await updateScan(scanId, {
        overall_score: 50,
        overall_label: 'Insufficient Data',
        mention_count: 0,
        summary: `No mentions found across web search${tpSummary ? '.' + tpSummary : ', and no Trustpilot presence detected.'} This brand may have limited online presence, or the name may be too common. Try adding a city or industry to your search.`,
        top_positive_phrases: '[]',
        top_negative_phrases: '[]',
        source_breakdown: '{}',
      });

      await setCacheEntry(key, scanId);

      return json({
        scan_id: scanId,
        brand,
        domain,
        overall_score: 50,
        overall_label: 'Insufficient Data',
        overall_category: 'insufficient-data',
        confidence_level: 'insufficient',
        confidence_note: 'No mentions found — this limited online presence is itself a finding worth addressing.',
        mention_count: 0,
        summary: 'No mentions found. This brand may have limited online presence.',
        sample_mentions: [],
        source_breakdown: {},
        teaser_lines: [],
        trustpilot: trustpilotData.business || undefined,
      });
    }

    // Scrape Serper results in parallel (with search snippets as fallback)
    const scraped = await scrapeAll(searchResults.map(r => ({
      url: r.url,
      query_type: r.query_type,
      fallback_snippet: r.description,
      fallback_title: r.title,
    })));

    // Convert Trustpilot reviews to ScrapedMention format
    const trustpilotMentions: (ScrapedMention & { query_type: string })[] = trustpilotData.reviews.map(r => ({
      url: `https://www.trustpilot.com/review/${domain}`,
      source_name: 'Trustpilot',
      source_type: 'review' as const,
      snippet: r.text.slice(0, 300),
      full_text: `${r.title}. ${r.text}`,
      query_type: 'reviews',
    }));

    // Merge with RRF (Reciprocal Rank Fusion, k=60)
    // Each source ranks its results independently. RRF produces a combined
    // ranking without requiring score normalization across heterogeneous sources.
    const allMentions = rrfMerge(scraped, trustpilotMentions);

    // Generate the full report
    const report = generateReport(allMentions);

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

    // Cache this result
    await setCacheEntry(key, scanId);

    // Generate smart service recommendation based on results
    const recommendation = getRecommendation(report.overall_score, report.mention_count, brand);

    // Generate dimensional diagnostic for sparse-data scans
    const diagnostic = report.mention_count < 8 ? generateDiagnostic({
      brand,
      domain,
      mentionCount: report.mention_count,
      sourceTypes: report.mentions.map(m => m.source_type),
      sourceNames: report.mentions.map(m => m.source_name),
      trustpilot: trustpilotData.business,
      positiveCount: report.mentions.filter(m => m.sentiment_label === 'positive').length,
      negativeCount: report.mentions.filter(m => m.sentiment_label === 'negative').length,
      neutralCount: report.mentions.filter(m => m.sentiment_label === 'neutral').length,
    }) : undefined;

    // Return Tier 1 data (ungated preview)
    return json({
      scan_id: scanId,
      brand,
      domain,
      overall_score: report.overall_score,
      overall_label: report.overall_label,
      overall_category: report.overall_category,
      confidence_level: report.confidence_level,
      confidence_note: report.confidence_note,
      mention_count: report.mention_count,
      summary: report.summary,
      sample_mentions: report.sample_mentions,
      source_breakdown: report.source_breakdown,
      teaser_lines: report.teaser_lines,
      recommendation,
      trustpilot: trustpilotData.business || undefined,
      diagnostic,
    });

  } catch (err: any) {
    console.error('Scan error:', err);
    return json({ error: err.message || 'Scan failed' }, 500);
  }
};
