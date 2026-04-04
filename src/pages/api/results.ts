export const prerender = false;

import type { APIRoute } from 'astro';
import { getAnalyses, getAnalysisCount } from '../../lib/db';

export const GET: APIRoute = async ({ url }) => {
  const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 100);
  const offset = Number(url.searchParams.get('offset')) || 0;
  const filter = url.searchParams.get('sentiment'); // positive, negative, neutral, mixed

  let analyses = await getAnalyses(limit, offset);

  if (filter) {
    analyses = analyses.filter(a => a.sentiment_label === filter);
  }

  return new Response(JSON.stringify({
    data: analyses,
    total: await getAnalysisCount(),
    limit,
    offset,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
