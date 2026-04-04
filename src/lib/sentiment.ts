import vader from 'vader-sentiment';
import type { ScrapedMention } from './scraper';

// --- Categorical scoring system ---
// Replaces the false-precision 0-100 score with defensible categories.
// Based on Wilson score interval research: 10-20 mentions produce ±25-point
// confidence intervals, making numeric scores statistically indefensible.

export type SentimentCategory = 'strong' | 'adequate' | 'mixed' | 'needs-attention' | 'critical' | 'insufficient-data';
export type ConfidenceLevel = 'solid' | 'moderate' | 'preliminary' | 'insufficient';

export interface MentionSentiment {
  url: string;
  source_name: string;
  source_type: string;
  snippet: string;
  sentiment_score: number;       // VADER compound: -1 to 1
  sentiment_label: string;       // positive / negative / neutral / mixed
  key_phrases: string[];
  query_type: string;
}

export interface ScanReport {
  overall_score: number;                // 0-100 (kept for backward compat / internal use)
  overall_label: string;                // categorical: Strong / Adequate / Mixed / Needs Attention / Critical
  overall_category: SentimentCategory;  // machine-readable category
  confidence_level: ConfidenceLevel;    // based on mention count
  confidence_note: string;              // human-readable confidence explanation
  mention_count: number;
  mentions: MentionSentiment[];
  source_breakdown: Record<string, { count: number; avg_score: number }>;
  top_positive_phrases: string[];
  top_negative_phrases: string[];
  summary: string;
  sample_mentions: MentionSentiment[];
  teaser_lines: string[];
}

// --- Brand-aware VADER analysis ---
//
// Plain VADER scores all words equally regardless of WHO they're about.
// "I left my terrible old ISP and switched to [brand] — best decision"
// gets penalized for "terrible" even though it's about a competitor.
//
// Fix: split text into sentences, score each sentence, weight sentences
// containing the brand name higher. Sentences without the brand name
// get reduced weight — they're more likely to be about competitors,
// context, or other entities.

let _currentBrand: string | null = null;

export function setBrandContext(brand: string) {
  _currentBrand = brand.toLowerCase().trim();
}

function analyzeSingleMention(text: string): {
  score: number;
  label: string;
  positiveWords: string[];
  negativeWords: string[];
} {
  // Split into sentences for brand-proximity weighting
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 5);
  const brandLower = _currentBrand || '';
  const brandSlug = brandLower.replace(/[^a-z0-9]/g, '');

  let weightedSum = 0;
  let totalWeight = 0;

  if (sentences.length > 1 && brandLower) {
    for (const sentence of sentences) {
      const sentLower = sentence.toLowerCase();
      const sentScores = vader.SentimentIntensityAnalyzer.polarity_scores(sentence.trim());

      // Sentences mentioning the brand get full weight
      // Sentences without the brand get reduced weight (0.3)
      const mentionsBrand = sentLower.includes(brandLower)
        || (brandSlug.length >= 4 && sentLower.replace(/[^a-z0-9]/g, '').includes(brandSlug));
      const weight = mentionsBrand ? 1.0 : 0.3;

      weightedSum += sentScores.compound * weight;
      totalWeight += weight;
    }
  }

  // Fall back to full-text VADER when we can't split or no brand context
  const fullScores = vader.SentimentIntensityAnalyzer.polarity_scores(text);
  const compound = (totalWeight > 0 && sentences.length > 1 && brandLower)
    ? weightedSum / totalWeight
    : fullScores.compound;

  // VADER thresholds (Hutto & Gilbert 2014)
  const label = compound >= 0.05 ? 'positive'
    : compound <= -0.05 ? 'negative'
    : 'neutral';

  // Extract sentiment-bearing words
  const words = text.split(/\s+/).filter(w => w.length > 2);
  const positiveWords: string[] = [];
  const negativeWords: string[] = [];

  for (const word of words) {
    const clean = word.toLowerCase().replace(/[^a-z]/g, '');
    if (!clean || clean.length < 3) continue;
    const wordScore = vader.SentimentIntensityAnalyzer.polarity_scores(word);
    if (wordScore.compound >= 0.3) positiveWords.push(clean);
    if (wordScore.compound <= -0.3) negativeWords.push(clean);
  }

  return {
    score: Math.round(compound * 100) / 100,
    label,
    positiveWords: [...new Set(positiveWords)],
    negativeWords: [...new Set(negativeWords)],
  };
}

// --- Confidence graduation ---
// Based on Wilson score interval research: confidence depends on sample size

function getConfidence(mentionCount: number): { level: ConfidenceLevel; note: string } {
  if (mentionCount < 3) {
    return {
      level: 'insufficient',
      note: `Based on ${mentionCount} mention${mentionCount !== 1 ? 's' : ''}. We found very little about this brand online — that itself may be worth discussing.`,
    };
  }
  if (mentionCount <= 7) {
    return {
      level: 'preliminary',
      note: `Based on ${mentionCount} mentions. This is a preliminary picture — the data is directional, not definitive.`,
    };
  }
  if (mentionCount <= 15) {
    return {
      level: 'moderate',
      note: `Based on ${mentionCount} mentions across multiple sources. Moderate confidence — results are directional.`,
    };
  }
  return {
    level: 'solid',
    note: `Based on ${mentionCount} mentions across multiple sources. Solid coverage for a meaningful assessment.`,
  };
}

// --- Categorical scoring ---
// Maps raw sentiment + mention count to a defensible category

function categorize(avgCompound: number, mentionCount: number): {
  category: SentimentCategory;
  label: string;
  score: number;  // 0-100 for backward compat
} {
  if (mentionCount < 3) {
    return { category: 'insufficient-data', label: 'Insufficient Data', score: 50 };
  }

  // Convert compound (-1..1) to 0-100 scale for internal use
  const score = Math.round(((avgCompound + 1) / 2) * 100);

  if (avgCompound >= 0.3) return { category: 'strong', label: 'Strong', score };
  if (avgCompound >= 0.1) return { category: 'adequate', label: 'Adequate', score };
  if (avgCompound >= -0.1) return { category: 'mixed', label: 'Mixed', score };
  if (avgCompound >= -0.3) return { category: 'needs-attention', label: 'Needs Attention', score };
  return { category: 'critical', label: 'Critical', score };
}

// --- Public helpers for cached results ---

export function deriveCategoryAndConfidence(overallScore: number, mentionCount: number) {
  // Reverse the 0-100 score back to compound (-1..1)
  const compound = (overallScore / 100) * 2 - 1;
  const { category, label } = categorize(compound, mentionCount);
  const { level, note } = getConfidence(mentionCount);
  return { overall_category: category, overall_label: label, confidence_level: level, confidence_note: note };
}

// --- Report generation ---

export function generateReport(scrapedMentions: (ScrapedMention & { query_type: string })[]): ScanReport {
  // Analyze all mentions once, keep the full analysis for phrase aggregation
  const analyses = scrapedMentions.map(m => ({
    scraped: m,
    analysis: analyzeSingleMention(m.full_text),
  }));

  const mentions: MentionSentiment[] = analyses.map(({ scraped, analysis }) => ({
    url: scraped.url,
    source_name: scraped.source_name,
    source_type: scraped.source_type,
    snippet: scraped.snippet,
    sentiment_score: analysis.score,
    sentiment_label: analysis.label,
    key_phrases: [...analysis.positiveWords.slice(0, 2), ...analysis.negativeWords.slice(0, 2)],
    query_type: scraped.query_type,
  }));

  // Average compound score
  const avgCompound = mentions.length > 0
    ? mentions.reduce((sum, m) => sum + m.sentiment_score, 0) / mentions.length
    : 0;

  const { category, label, score } = categorize(avgCompound, mentions.length);
  const { level: confidenceLevel, note: confidenceNote } = getConfidence(mentions.length);

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

  // Aggregate phrases from the already-computed analyses (no re-analysis)
  const allPositive: Record<string, number> = {};
  const allNegative: Record<string, number> = {};
  for (const { analysis } of analyses) {
    for (const w of analysis.positiveWords) {
      allPositive[w] = (allPositive[w] || 0) + 1;
    }
    for (const w of analysis.negativeWords) {
      allNegative[w] = (allNegative[w] || 0) + 1;
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

  // Summary — adapted for categorical output
  const posCount = mentions.filter(m => m.sentiment_label === 'positive').length;
  const negCount = mentions.filter(m => m.sentiment_label === 'negative').length;
  const neuCount = mentions.filter(m => m.sentiment_label === 'neutral').length;

  let summary: string;
  if (mentions.length === 0) {
    summary = 'No mentions found. This brand may have limited online presence, or the name may be too common. Try adding a city or industry to your search.';
  } else if (category === 'insufficient-data') {
    summary = `We found only ${mentions.length} mention${mentions.length !== 1 ? 's' : ''} — not enough for a reliable sentiment assessment. This limited online presence is itself a finding worth addressing.`;
  } else if (category === 'strong') {
    summary = `Online sentiment looks strong. Across ${mentions.length} mentions, ${posCount} were positive, ${neuCount} neutral, and ${negCount} negative.${top_positive_phrases.length > 0 ? ` Terms like "${top_positive_phrases.slice(0, 3).join('", "')}" come up frequently.` : ''} ${confidenceNote}`;
  } else if (category === 'adequate') {
    summary = `Online sentiment is generally positive. Of ${mentions.length} mentions, ${posCount} were positive and ${negCount} negative.${top_positive_phrases.length > 0 ? ` Positive signals include "${top_positive_phrases.slice(0, 2).join('", "')}"` : ''}${top_negative_phrases.length > 0 ? `, but watch for "${top_negative_phrases.slice(0, 2).join('", "')}" in negative mentions.` : '.'} ${confidenceNote}`;
  } else if (category === 'mixed') {
    summary = `Online sentiment is mixed. Of ${mentions.length} mentions, ${posCount} were positive and ${negCount} negative — no clear pattern in either direction.${top_negative_phrases.length > 0 ? ` Recurring negative themes: "${top_negative_phrases.slice(0, 3).join('", "')}".` : ''} ${confidenceNote}`;
  } else if (category === 'needs-attention') {
    summary = `Online sentiment needs attention. ${negCount} of ${mentions.length} mentions were negative.${top_negative_phrases.length > 0 ? ` The most common negative signals: "${top_negative_phrases.slice(0, 3).join('", "')}".` : ''} This is fixable with the right approach. ${confidenceNote}`;
  } else {
    summary = `Online sentiment is a serious concern. ${negCount} of ${mentions.length} mentions were negative.${top_negative_phrases.length > 0 ? ` Dominant negative themes: "${top_negative_phrases.slice(0, 3).join('", "')}".` : ''} Immediate action recommended. ${confidenceNote}`;
  }

  // Tier 1 samples: one positive, one negative, one neutral
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

  // Teaser lines
  const hiddenCount = mentions.length - sample_mentions.length;
  const teaser_lines: string[] = [];
  if (hiddenCount > 0) teaser_lines.push(`${hiddenCount} more mentions analyzed`);
  if (top_negative_phrases.length > 0) teaser_lines.push(`Top ${Math.min(3, top_negative_phrases.length)} phrases hurting your reputation`);
  if (top_positive_phrases.length > 0) teaser_lines.push(`Top ${Math.min(3, top_positive_phrases.length)} phrases helping your reputation`);
  if (Object.keys(source_breakdown).length > 1) teaser_lines.push('Source-by-source breakdown available');

  return {
    overall_score: score,
    overall_label: label,
    overall_category: category,
    confidence_level: confidenceLevel,
    confidence_note: confidenceNote,
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
