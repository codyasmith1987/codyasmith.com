export const prerender = false;

import type { APIRoute } from 'astro';
import { scrapePage } from '../../lib/scraper';
import { analyzeSentiment } from '../../lib/sentiment';
import { insertAnalysis } from '../../lib/db';

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const url = body.url?.trim();

    if (!url) {
      return new Response(JSON.stringify({ error: 'URL is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Validate URL format
    try {
      new URL(url);
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid URL format' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Scrape the page
    const page = await scrapePage(url);

    // Analyze sentiment
    const sentiment = analyzeSentiment(page.text);

    // Store in database
    const analysis = await insertAnalysis({
      url: page.url,
      page_title: page.title,
      sentiment_score: sentiment.sentiment_score,
      sentiment_label: sentiment.sentiment_label,
      confidence: sentiment.confidence,
      summary: sentiment.summary,
      key_phrases: JSON.stringify(sentiment.key_phrases),
      raw_text: page.text.slice(0, 2000),
    });

    const json = JSON.stringify(analysis);
    return new Response(json, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('Analysis error:', err);
    return new Response(JSON.stringify({ error: err.message || 'Analysis failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
