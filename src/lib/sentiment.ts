// Aggregation and scan-level reporting for the Listener.
// Per-mention scoring lives in src/lib/sentiment-gemini.ts (Gemini cascade
// with AFINN fallback). This module retains the rolled-up score, source
// breakdown, top phrases, summary, sample mentions, and teaser lines.

import type { ScrapedMention } from './scraper';
import {
  scoreMention,
  type ScoredBy,
  type ScoreMentionDeps,
} from './sentiment-gemini';

export interface MentionSentiment {
  url: string;
  source_name: string;
  source_type: string;
  snippet: string;
  sentiment_score: number;
  sentiment_label: string;
  key_phrases: string[];
  query_type: string;
  scored_by: ScoredBy;
}

export interface ScanReport {
  overall_score: number;       // 0-100
  overall_label: string;       // Poor / Mixed / Positive / Strong
  mention_count: number;
  mentions: MentionSentiment[];
  source_breakdown: Record<string, { count: number; avg_score: number }>;
  top_positive_phrases: string[];
  top_negative_phrases: string[];
  summary: string;
  // Tier 1 preview
  sample_mentions: MentionSentiment[];  // 2-3 samples for ungated preview
  teaser_lines: string[];
}

function scoreToLabel(score: number): string {
  if (score >= 75) return 'Strong';
  if (score >= 55) return 'Positive';
  if (score >= 35) return 'Mixed';
  return 'Poor';
}

export interface GenerateReportDeps extends ScoreMentionDeps {
  scorer?: typeof scoreMention;
  onMentionScored?: (idx: number, total: number) => void;
}

/**
 * Generate a complete scan report from scraped mentions. Per-mention scoring
 * runs through the Gemini cascade with AFINN fallback. Aggregation is invariant
 * to which path scored each mention.
 */
export async function generateReport(
  scrapedMentions: (ScrapedMention & { query_type: string })[],
  brand: string,
  deps: GenerateReportDeps = {},
): Promise<ScanReport> {
  const scorer = deps.scorer ?? scoreMention;
  const total = scrapedMentions.length;

  // Score each mention through the cascade. Carry the scored shape through to
  // both the per-mention array AND the phrase aggregation, so we never run the
  // scorer twice on the same text.
  const mentions: MentionSentiment[] = [];
  const allPositive: Record<string, number> = {};
  const allNegative: Record<string, number> = {};

  for (let i = 0; i < total; i += 1) {
    const m = scrapedMentions[i];
    const scored = await scorer(
      brand,
      {
        url: m.url,
        source_name: m.source_name,
        source_type: m.source_type,
        full_text: m.full_text,
      },
      deps,
    );

    mentions.push({
      url: m.url,
      source_name: m.source_name,
      source_type: m.source_type,
      snippet: m.snippet,
      sentiment_score: scored.score,
      sentiment_label: scored.label,
      key_phrases: scored.key_phrases,
      query_type: m.query_type,
      scored_by: scored.scored_by,
    });

    for (const w of scored.positive) {
      const k = w.toLowerCase();
      allPositive[k] = (allPositive[k] || 0) + 1;
    }
    for (const w of scored.negative) {
      const k = w.toLowerCase();
      allNegative[k] = (allNegative[k] || 0) + 1;
    }

    if (deps.onMentionScored) deps.onMentionScored(i, total);
  }

  // Overall score: convert -1..1 average to 0..100
  const avgScore = mentions.length > 0
    ? mentions.reduce((sum, m) => sum + m.sentiment_score, 0) / mentions.length
    : 0;
  const overall_score = Math.round(((avgScore + 1) / 2) * 100);
  const overall_label = scoreToLabel(overall_score);

  // Source breakdown
  const source_breakdown: Record<string, { count: number; avg_score: number }> = {};
  for (const m of mentions) {
    if (!source_breakdown[m.source_type]) {
      source_breakdown[m.source_type] = { count: 0, avg_score: 0 };
    }
    source_breakdown[m.source_type].count += 1;
    source_breakdown[m.source_type].avg_score += m.sentiment_score;
  }
  for (const key in source_breakdown) {
    source_breakdown[key].avg_score = Math.round(
      (source_breakdown[key].avg_score / source_breakdown[key].count) * 100,
    ) / 100;
  }

  const top_positive_phrases = Object.entries(allPositive)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([word]) => word);
  const top_negative_phrases = Object.entries(allNegative)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([word]) => word);

  // Summary
  const posCount = mentions.filter(m => m.sentiment_label === 'positive').length;
  const negCount = mentions.filter(m => m.sentiment_label === 'negative').length;
  const neuCount = mentions.filter(m => m.sentiment_label === 'neutral').length;
  let summary: string;
  if (mentions.length === 0) {
    summary = 'No mentions found to analyze. This brand may have limited online presence.';
  } else if (overall_score >= 65) {
    summary = `Your online sentiment is ${overall_label.toLowerCase()}. Across ${mentions.length} mentions, ${posCount} were positive, ${neuCount} neutral, and ${negCount} negative. ${top_positive_phrases.length > 0 ? `Words like "${top_positive_phrases.slice(0, 3).join('", "')}" appear frequently.` : ''}`;
  } else if (overall_score >= 40) {
    summary = `Your online sentiment is mixed. Of ${mentions.length} mentions found, ${posCount} were positive and ${negCount} negative. ${top_negative_phrases.length > 0 ? `Watch for recurring themes like "${top_negative_phrases.slice(0, 3).join('", "')}" in negative mentions.` : ''}`;
  } else {
    summary = `Your online sentiment needs attention. ${negCount} of ${mentions.length} mentions were negative. ${top_negative_phrases.length > 0 ? `The most common negative signals: "${top_negative_phrases.slice(0, 3).join('", "')}".` : ''} This is fixable. Most brands can shift sentiment within 90 days with the right strategy.`;
  }

  // Tier 1 samples: pick one positive, one negative, one neutral (if available)
  const sample_mentions: MentionSentiment[] = [];
  const pos = mentions.find(m => m.sentiment_label === 'positive');
  const neg = mentions.find(m => m.sentiment_label === 'negative');
  const neu = mentions.find(m => m.sentiment_label === 'neutral');
  if (pos) sample_mentions.push(pos);
  if (neg) sample_mentions.push(neg);
  if (neu && sample_mentions.length < 3) sample_mentions.push(neu);
  if (sample_mentions.length < 2) {
    for (const m of mentions) {
      if (!sample_mentions.includes(m)) {
        sample_mentions.push(m);
        if (sample_mentions.length >= 3) break;
      }
    }
  }

  // Teaser lines for gated content
  const hiddenCount = mentions.length - sample_mentions.length;
  const teaser_lines: string[] = [];
  if (hiddenCount > 0) teaser_lines.push(`${hiddenCount} more mentions analyzed`);
  if (top_negative_phrases.length > 0) teaser_lines.push(`Top ${Math.min(3, top_negative_phrases.length)} phrases hurting your score`);
  if (top_positive_phrases.length > 0) teaser_lines.push(`Top ${Math.min(3, top_positive_phrases.length)} phrases helping your score`);
  if (Object.keys(source_breakdown).length > 1) teaser_lines.push('Source-by-source breakdown available');

  return {
    overall_score,
    overall_label,
    mention_count: mentions.length,
    mentions,
    source_breakdown,
    top_positive_phrases,
    top_negative_phrases,
    summary,
    sample_mentions,
    teaser_lines,
  };
}
