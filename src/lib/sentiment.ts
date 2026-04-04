import Sentiment from 'sentiment';

const analyzer = new Sentiment();

export interface SentimentResult {
  sentiment_score: number;    // -1.0 to 1.0
  sentiment_label: string;    // positive, negative, neutral, mixed
  confidence: number;         // 0.0 to 1.0
  summary: string;            // brief explanation
  key_phrases: string[];      // words that drove the score
}

export function analyzeSentiment(text: string): SentimentResult {
  const result = analyzer.analyze(text);

  // Normalize score to -1..1 range (raw score can be any number based on word count)
  // comparative is already normalized per-word, typically -5 to 5 range
  const raw = result.comparative;
  const normalized = Math.max(-1, Math.min(1, raw * 2));

  const label = normalized > 0.1 ? 'positive'
    : normalized < -0.1 ? 'negative'
    : 'neutral';

  // Confidence based on how many sentiment words were found vs total
  const totalWords = result.tokens.length || 1;
  const sentimentWords = result.positive.length + result.negative.length;
  const confidence = Math.min(1, sentimentWords / Math.max(totalWords * 0.1, 1));

  // Top positive and negative words as key phrases
  const positiveWords = [...new Set(result.positive)].slice(0, 3);
  const negativeWords = [...new Set(result.negative)].slice(0, 3);
  const keyPhrases = [...positiveWords, ...negativeWords].slice(0, 5);

  // Build a simple summary
  const posCount = result.positive.length;
  const negCount = result.negative.length;
  let summary: string;
  if (posCount === 0 && negCount === 0) {
    summary = 'No strong sentiment detected. The content appears factual or neutral.';
  } else if (label === 'positive') {
    summary = `Overall positive tone with ${posCount} positive and ${negCount} negative signals.`;
  } else if (label === 'negative') {
    summary = `Overall negative tone with ${negCount} negative and ${posCount} positive signals.`;
  } else {
    summary = `Neutral or balanced tone with ${posCount} positive and ${negCount} negative signals.`;
  }

  return {
    sentiment_score: Math.round(normalized * 100) / 100,
    sentiment_label: label,
    confidence: Math.round(confidence * 100) / 100,
    summary,
    key_phrases: keyPhrases,
  };
}
