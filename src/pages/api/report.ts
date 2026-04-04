export const prerender = false;

import type { APIRoute } from 'astro';
import { getScan, getMentions } from '../../lib/db';
import { getRecommendation } from '../../lib/recommend';
import { deriveCategoryAndConfidence } from '../../lib/sentiment';

export const GET: APIRoute = async ({ url }) => {
  const json = (s: any, status = 200) => new Response(JSON.stringify(s), {
    status, headers: { 'Content-Type': 'application/json' },
  });

  const scanId = Number(url.searchParams.get('id'));
  if (!scanId) return json({ error: 'Missing scan ID' }, 400);

  const scan = await getScan(scanId);
  if (!scan || !scan.overall_score) return json({ error: 'Report not found' }, 404);

  // Check if report has expired (30 days)
  const createdAt = new Date(scan.created_at + 'Z');
  const daysSince = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince > 30) {
    // Return expired with context for re-engagement instead of dead end
    return json({
      expired: true,
      brand: scan.brand,
      domain: scan.domain,
      overall_label: scan.overall_label,
      mention_count: scan.mention_count,
      scanned_date: scan.created_at,
      days_ago: Math.floor(daysSince),
    }, 410);
  }

  const mentions = await getMentions(scanId);
  const recommendation = getRecommendation(scan.overall_score, scan.mention_count, scan.brand);
  const derived = deriveCategoryAndConfidence(scan.overall_score, scan.mention_count);

  let topPositive: string[] = [];
  let topNegative: string[] = [];
  let sourceBreakdown: any = {};
  try { topPositive = JSON.parse(scan.top_positive_phrases || '[]'); } catch {}
  try { topNegative = JSON.parse(scan.top_negative_phrases || '[]'); } catch {}
  try { sourceBreakdown = JSON.parse(scan.source_breakdown || '{}'); } catch {}

  // Build sample mentions for Tier 1 view
  const sampleMentions: any[] = [];
  const pos = mentions.find(m => m.sentiment_label === 'positive');
  const neg = mentions.find(m => m.sentiment_label === 'negative');
  const neu = mentions.find(m => m.sentiment_label === 'neutral');
  if (pos) sampleMentions.push(pos);
  if (neg) sampleMentions.push(neg);
  if (neu && sampleMentions.length < 3) sampleMentions.push(neu);

  const hiddenCount = mentions.length - sampleMentions.length;
  const teaserLines: string[] = [];
  if (hiddenCount > 0) teaserLines.push(`${hiddenCount} more mentions analyzed`);
  if (topNegative.length > 0) teaserLines.push(`Top ${Math.min(3, topNegative.length)} phrases hurting your reputation`);
  if (topPositive.length > 0) teaserLines.push(`Top ${Math.min(3, topPositive.length)} phrases helping your reputation`);

  return json({
    scan_id: scan.id,
    brand: scan.brand,
    domain: scan.domain,
    overall_score: scan.overall_score,
    overall_label: derived.overall_label,
    overall_category: derived.overall_category,
    confidence_level: derived.confidence_level,
    confidence_note: derived.confidence_note,
    mention_count: scan.mention_count,
    summary: scan.summary,
    sample_mentions: sampleMentions,
    source_breakdown: sourceBreakdown,
    teaser_lines: teaserLines,
    recommendation,
    // Full Tier 2 data (already unlocked via email)
    mentions,
    top_positive_phrases: topPositive,
    top_negative_phrases: topNegative,
    unlocked: true,
  });
};
