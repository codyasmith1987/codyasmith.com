import Sentiment from 'sentiment';
import type { ScrapedMention } from './scraper';

const analyzer = new Sentiment();

export interface MentionSentiment {
  url: string;
  source_name: string;
  source_type: string;
  snippet: string;
  sentiment_score: number;
  sentiment_label: string;
  key_phrases: string[];
  query_type: string;
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

function analyzeSingleMention(text: string): { score: number; label: string; positive: string[]; negative: string[] } {
  const result = analyzer.analyze(text);
  const raw = result.comparative;
  const normalized = Math.max(-1, Math.min(1, raw * 2));
  const label = normalized > 0.1 ? 'positive' : normalized < -0.1 ? 'negative' : 'neutral';
  return {
    score: Math.round(normalized * 100) / 100,
    label,
    positive: [...new Set(result.positive)],
    negative: [...new Set(result.negative)],
  };
}

function scoreToLabel(score: number): string {
  if (score >= 75) return 'Strong';
  if (score >= 55) return 'Positive';
  if (score >= 35) return 'Mixed';
  return 'Poor';
}

/**
 * Generate a complete scan report from scraped mentions.
 */
export function generateReport(scrapedMentions: (ScrapedMention & { query_type: string })[]): ScanReport {
  // Analyze each mention
  const mentions: MentionSentiment[] = scrapedMentions.map(m => {
    const analysis = analyzeSingleMention(m.full_text);
    return {
      url: m.url,
      source_name: m.source_name,
      source_type: m.source_type,
      snippet: m.snippet,
      sentiment_score: analysis.score,
      sentiment_label: analysis.label,
      key_phrases: [...analysis.positive.slice(0, 2), ...analysis.negative.slice(0, 2)],
      query_type: m.query_type,
    };
  });

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
    source_breakdown[m.source_type].count++;
    source_breakdown[m.source_type].avg_score += m.sentiment_score;
  }
  for (const key in source_breakdown) {
    source_breakdown[key].avg_score = Math.round(
      (source_breakdown[key].avg_score / source_breakdown[key].count) * 100
    ) / 100;
  }

  // Aggregate phrase analysis across all mentions
  const allPositive: Record<string, number> = {};
  const allNegative: Record<string, number> = {};
  for (const m of scrapedMentions) {
    const analysis = analyzer.analyze(m.full_text);
    for (const w of analysis.positive) {
      allPositive[w.toLowerCase()] = (allPositive[w.toLowerCase()] || 0) + 1;
    }
    for (const w of analysis.negative) {
      allNegative[w.toLowerCase()] = (allNegative[w.toLowerCase()] || 0) + 1;
    }
  }
  const top_positive_phrases = Object.entries(allPositive)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([word]) => word);
  const top_negative_phrases = Object.entries(allNegative)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([word]) => word);

  // Build summary
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
    summary = `Your online sentiment needs attention. ${negCount} of ${mentions.length} mentions were negative. ${top_negative_phrases.length > 0 ? `The most common negative signals: "${top_negative_phrases.slice(0, 3).join('", "')}".` : ''} This is fixable — most brands can shift sentiment within 90 days with the right strategy.`;
  }

  // Tier 1 samples: pick one positive, one negative, one neutral (if available)
  const sample_mentions: MentionSentiment[] = [];
  const pos = mentions.find(m => m.sentiment_label === 'positive');
  const neg = mentions.find(m => m.sentiment_label === 'negative');
  const neu = mentions.find(m => m.sentiment_label === 'neutral');
  if (pos) sample_mentions.push(pos);
  if (neg) sample_mentions.push(neg);
  if (neu && sample_mentions.length < 3) sample_mentions.push(neu);
  // If we still need samples, add the first ones we haven't used
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
