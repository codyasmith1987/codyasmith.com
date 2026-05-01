// Gemini-backed per-mention sentiment scoring with deterministic AFINN fallback.
//
// Cascade per mention: cache hit, then Gemini, then AFINN. Any exception in
// the Gemini path falls through to AFINN. Lexicon results are never cached.
// The Listener stays running through any Gemini outage because AFINN is local
// and never throws.
//
// This module is imported by src/lib/sentiment.ts (which retains the
// generateReport aggregation). It does not import sentiment.ts back, so there
// is no cycle.

import { createHash } from 'node:crypto';
import Sentiment from 'sentiment';
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import type { Client } from '@libsql/client';

export const PROMPT_VERSION = 'v1';
export const MODEL = 'gemini-2.5-flash-lite';
export const CACHE_TTL_DAYS = 7;

export type SentimentLabel = 'positive' | 'negative' | 'neutral' | 'mixed';
export type ScoredBy = 'gemini' | 'lexicon';

export interface ScoredMention {
  score: number;
  label: SentimentLabel;
  positive: string[];
  negative: string[];
  key_phrases: string[];
  scored_by: ScoredBy;
}

export interface MentionInput {
  url: string;
  source_name: string;
  source_type: string;
  full_text: string;
}

// Public so the prompt is reviewable in the diff and version-controllable.
export const SCORE_SYSTEM_PROMPT = `You are a brand monitoring analyst. Read a single web mention of a specific named brand and produce a structured sentiment assessment that a marketing director could act on.

Brief the director honestly: was the writer's stance toward this brand positive, negative, mixed, or neutral? What specific themes drove that stance? Be precise. Avoid generic adjectives and template phrasing.

Return a JSON object with this exact shape:
{
  "score": number,
  "label": "positive" | "negative" | "neutral" | "mixed",
  "positive_themes": string[],
  "negative_themes": string[],
  "key_phrases": string[]
}

Field rules:
- score: a number in [-1.0, 1.0] with one decimal place. -1.0 is overwhelmingly hostile, 0.0 is neutral or balanced, 1.0 is enthusiastic endorsement.
- label: maps roughly to score. Use "negative" for score at or below -0.3. Use "positive" for score at or above 0.3. Use "neutral" for scores between -0.3 and 0.3 with no strong opposing signals. Use "mixed" only when there are strong positive AND strong negative signals that average out near zero but neither cancels the other.
- positive_themes: 0 to 5 short phrases, 1 to 4 words each, naming positive elements of the mention. "reliable shipping" not "reliable". "responsive support" not "good".
- negative_themes: 0 to 5 short phrases naming negative elements. Same length rule.
- key_phrases: 2 to 5 phrases that most drove your assessment. Multi-word allowed. May overlap with positive_themes or negative_themes.

Edge cases:
- Empty, garbage, or non-English text: return score=0.0, label="neutral", and empty arrays for the three string lists.
- The named brand is mentioned only incidentally and the text is about something else: return label="neutral", score=0.0.
- Off-topic content (spam, boilerplate, link farms): return label="neutral", score=0.0.

Do not include preamble, sign-off, or any text outside the JSON object. Do not wrap the response in markdown fences.`;

export function buildUserPrompt(brand: string, mention: MentionInput): string {
  return `Brand: ${brand}
Source: ${mention.source_type} (${mention.source_name})
URL: ${mention.url}

Mention text:
${mention.full_text}

Score this mention's sentiment toward the brand named above.`;
}

const responseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    score: { type: SchemaType.NUMBER },
    label: { type: SchemaType.STRING, enum: ['positive', 'negative', 'neutral', 'mixed'] },
    positive_themes: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    negative_themes: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    key_phrases: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
  },
  required: ['score', 'label', 'positive_themes', 'negative_themes', 'key_phrases'],
};

// AFINN. The lexicon path inside the cascade. Deterministic, never throws.
const analyzer = new Sentiment();

export function analyzeWithLexicon(text: string): Omit<ScoredMention, 'scored_by'> {
  const result = analyzer.analyze(text || '');
  const raw = result.comparative;
  const normalized = Math.max(-1, Math.min(1, raw * 2));
  const score = Math.round(normalized * 100) / 100;
  let label: SentimentLabel;
  if (normalized > 0.1) label = 'positive';
  else if (normalized < -0.1) label = 'negative';
  else label = 'neutral';
  const positive = [...new Set(result.positive)];
  const negative = [...new Set(result.negative)];
  return {
    score,
    label,
    positive,
    negative,
    key_phrases: [...positive.slice(0, 2), ...negative.slice(0, 2)],
  };
}

// Gemini client interface. Production wires this to @google/generative-ai;
// tests pass a mock that returns canned JSON or throws.
export interface GeminiScoreClient {
  scoreOnce(systemPrompt: string, userPrompt: string): Promise<string>;
}

export function createGeminiScoreClient(apiKey: string, model: string = MODEL): GeminiScoreClient {
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is required to create a Gemini score client');
  }
  const ai = new GoogleGenerativeAI(apiKey);
  return {
    async scoreOnce(systemPrompt: string, userPrompt: string): Promise<string> {
      const m = ai.getGenerativeModel({
        model,
        systemInstruction: systemPrompt,
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
          responseSchema: responseSchema as any,
        },
      });
      const result = await m.generateContent(userPrompt);
      return result.response.text();
    },
  };
}

// Cache wrapper. Production wires this to the default turso client; tests
// pass an in-memory libsql client for round-trip verification.
export interface ScoreCacheClient {
  get(key: string): Promise<{ value: ParsedGeminiResponse; expiresAt: string } | null>;
  set(key: string, value: ParsedGeminiResponse, ttlDays: number): Promise<void>;
}

export function createCacheClient(turso: Client): ScoreCacheClient {
  return {
    async get(key) {
      const result = await turso.execute({
        sql: `SELECT response_json, expires_at
              FROM listener_sentiment_cache
              WHERE cache_key = ? AND expires_at > datetime('now')
              LIMIT 1`,
        args: [key],
      });
      if (result.rows.length === 0) return null;
      const row = result.rows[0];
      return {
        value: JSON.parse(String(row[0])),
        expiresAt: String(row[1]),
      };
    },
    async set(key, value, ttlDays) {
      const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
      await turso.execute({
        sql: `INSERT INTO listener_sentiment_cache
                (cache_key, response_json, created_at, expires_at)
              VALUES (?, ?, datetime('now'), ?)
              ON CONFLICT(cache_key) DO UPDATE SET
                response_json = excluded.response_json,
                created_at = datetime('now'),
                expires_at = excluded.expires_at`,
        args: [key, JSON.stringify(value), expiresAt],
      });
    },
  };
}

export interface ParsedGeminiResponse {
  score: number;
  label: SentimentLabel;
  positive_themes: string[];
  negative_themes: string[];
  key_phrases: string[];
}

const VALID_LABELS = new Set<SentimentLabel>(['positive', 'negative', 'neutral', 'mixed']);

export function parseAndValidateScore(text: string): ParsedGeminiResponse {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let json: unknown;
  try {
    json = JSON.parse(stripped);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Listener scorer returned invalid JSON: ${msg}`);
  }

  if (!json || typeof json !== 'object') {
    throw new Error('Listener scorer response is not an object');
  }
  const obj = json as Record<string, unknown>;

  if (typeof obj.score !== 'number' || obj.score < -1 || obj.score > 1) {
    throw new Error(`Invalid score: ${String(obj.score)}`);
  }

  if (typeof obj.label !== 'string' || !VALID_LABELS.has(obj.label as SentimentLabel)) {
    throw new Error(`Invalid label: ${String(obj.label)}`);
  }

  for (const field of ['positive_themes', 'negative_themes', 'key_phrases'] as const) {
    const v = obj[field];
    if (!Array.isArray(v) || !v.every((t) => typeof t === 'string')) {
      throw new Error(`Invalid ${field}: not a string array`);
    }
  }

  return {
    score: Math.round((obj.score as number) * 10) / 10,
    label: obj.label as SentimentLabel,
    positive_themes: obj.positive_themes as string[],
    negative_themes: obj.negative_themes as string[],
    key_phrases: obj.key_phrases as string[],
  };
}

export function cacheKey(text: string, promptVersion: string = PROMPT_VERSION, model: string = MODEL): string {
  return createHash('sha256').update(`${promptVersion}|${model}|${text}`).digest('hex');
}

export interface ScoreMentionDeps {
  gemini?: GeminiScoreClient | null;
  cache?: ScoreCacheClient | null;
  apiKey?: string;
  promptVersion?: string;
  model?: string;
}

// The cascade. Tries cache, then Gemini, falls back to lexicon. Always returns.
export async function scoreMention(
  brand: string,
  mention: MentionInput,
  deps: ScoreMentionDeps = {},
): Promise<ScoredMention> {
  const promptVersion = deps.promptVersion ?? PROMPT_VERSION;
  const model = deps.model ?? MODEL;
  const text = mention.full_text || '';

  // Resolve cache. Production: createCacheClient(turso). Tests: pass in deps.
  // Caller can pass null to disable cache entirely (used by force-failure tests).
  let cache: ScoreCacheClient | null = deps.cache ?? null;
  if (cache === undefined) {
    // No-op: undefined means "use default" but we already coerced to null above.
  }
  if (deps.cache === undefined) {
    try {
      const tursoMod = await import('./turso');
      cache = createCacheClient(tursoMod.default);
    } catch {
      cache = null;
    }
  }

  // Cache lookup
  const key = cacheKey(text, promptVersion, model);
  if (cache) {
    try {
      const cached = await cache.get(key);
      if (cached) {
        return mapToScoredMention(cached.value, 'gemini');
      }
    } catch {
      // Cache lookup failure is non-fatal. Proceed to Gemini.
    }
  }

  // Resolve Gemini client. Production: createGeminiScoreClient(env key). Tests: mock or null.
  let gemini: GeminiScoreClient | null = deps.gemini ?? null;
  if (deps.gemini === undefined) {
    const apiKey = (deps.apiKey ?? readGeminiApiKey()).trim();
    if (apiKey && apiKey.startsWith('AIza')) {
      try {
        gemini = createGeminiScoreClient(apiKey, model);
      } catch {
        gemini = null;
      }
    }
  }

  if (gemini) {
    try {
      const userPrompt = buildUserPrompt(brand, mention);
      const responseText = await gemini.scoreOnce(SCORE_SYSTEM_PROMPT, userPrompt);
      const parsed = parseAndValidateScore(responseText);

      if (cache) {
        try {
          await cache.set(key, parsed, CACHE_TTL_DAYS);
        } catch {
          // Cache write failure is non-fatal. Return the parsed result.
        }
      }

      return mapToScoredMention(parsed, 'gemini');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Listener Gemini scoring failed, falling back to lexicon: ${msg}`);
      // Fall through to lexicon.
    }
  }

  // Lexicon fallback. Deterministic, never throws.
  const lex = analyzeWithLexicon(text);
  return { ...lex, scored_by: 'lexicon' };
}

function mapToScoredMention(parsed: ParsedGeminiResponse, scored_by: ScoredBy): ScoredMention {
  return {
    score: parsed.score,
    label: parsed.label,
    positive: parsed.positive_themes,
    negative: parsed.negative_themes,
    key_phrases: parsed.key_phrases,
    scored_by,
  };
}

function readGeminiApiKey(): string {
  // import.meta.env at module-eval time is undefined in tsx but populated in
  // Astro/Vite. Resolve at call time so tooling does not crash on import.
  const env: Record<string, string | undefined> =
    (import.meta as { env?: Record<string, string | undefined> }).env ??
    (typeof process !== 'undefined' ? (process.env as Record<string, string | undefined>) : {});
  return env.GEMINI_API_KEY ?? '';
}
