// POST /api/naming/preview
// Phase 3 endpoint: 200-candidate generation, two-tier scoring, top-25 with
// tonality vectors returned for the slider UI.
//
// The route handler stays thin: parse JSON body, derive client IP, defer to
// handlePreview. handlePreview takes a deps object so unit tests mock the
// engine, RDAP, scorer, rate limiter, and storage.

import type { APIRoute } from 'astro';
import { rateLimit as rateLimitFn } from '../../../lib/rate-limit';
import { logger } from '../../../lib/logger';
import {
  generate,
  createGeminiClient,
  GeneratorValidationError,
  type GeminiClient,
} from '../../../lib/naming/generator';
import { checkAvailability as checkAvailabilityFn } from '../../../lib/naming/availability';
import { scoreAllCandidates, topK } from '../../../lib/naming/scorer';
import { createStorage, type NamingStorage } from '../../../lib/naming/storage';
import { DEFAULTS } from '../../../lib/naming/config';
import {
  DEFAULT_TONALITY,
  TONALITY_AXES,
  type ScoredCandidate,
  type TonalityVector,
} from '../../../lib/naming/types';
import turso from '../../../lib/turso';

export const prerender = false;

const SEED_MAX_LENGTH = 200;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const HOURLY_LIMIT = 10;
const DAILY_LIMIT = 50;

export interface PreviewDeps {
  rateLimit?: (key: string, max: number, windowMs: number) => Promise<boolean>;
  generate?: typeof generate;
  checkAvailability?: typeof checkAvailabilityFn;
  storage?: NamingStorage;
  geminiClient?: GeminiClient;
  apiKey?: string;
}

export interface PreviewName {
  name: string;
  typology: string;
  rationale: string;
  tonality: TonalityVector;
  score: number;
  domain: {
    available: boolean | null;
    secondaryPriceUsd: number | null;
  };
}

export interface PreviewResult {
  status: number;
  body: {
    runId?: string;
    candidates?: PreviewName[];
    error?: string;
    validationRule?: string;
  };
}

function readGeminiApiKey(): string {
  const env: Record<string, string | undefined> =
    (import.meta as { env?: Record<string, string | undefined> }).env ??
    (typeof process !== 'undefined' ? (process.env as Record<string, string | undefined>) : {});
  return (env.GEMINI_API_KEY ?? '').trim();
}

function parseTonalityFromBody(raw: unknown): TonalityVector {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_TONALITY };
  const obj = raw as Record<string, unknown>;
  const result: TonalityVector = { ...DEFAULT_TONALITY };
  for (const axis of TONALITY_AXES) {
    const v = obj[axis];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 5) {
      result[axis] = v;
    }
  }
  return result;
}

export async function handlePreview(
  rawBody: unknown,
  ip: string,
  deps: PreviewDeps = {},
): Promise<PreviewResult> {
  if (!rawBody || typeof rawBody !== 'object') {
    return { status: 400, body: { error: 'Invalid request body' } };
  }
  const body = rawBody as { seed?: unknown; tonality?: unknown };

  const seed = typeof body.seed === 'string' ? body.seed.trim() : '';
  if (!seed) return { status: 400, body: { error: 'Seed term is required' } };
  if (seed.length > SEED_MAX_LENGTH) {
    return {
      status: 400,
      body: { error: `Seed term must be ${SEED_MAX_LENGTH} characters or fewer` },
    };
  }

  const userTonality = parseTonalityFromBody(body.tonality);

  if (!ip || ip === 'unknown') {
    return { status: 400, body: { error: 'Could not verify your request' } };
  }

  const rl = deps.rateLimit ?? rateLimitFn;
  const hourOk = await rl(`naming-preview:hour:${ip}`, HOURLY_LIMIT, HOUR_MS);
  if (!hourOk) {
    return {
      status: 429,
      body: { error: "You've reached the hourly preview limit. Try again in an hour." },
    };
  }
  const dayOk = await rl(`naming-preview:day:${ip}`, DAILY_LIMIT, DAY_MS);
  if (!dayOk) {
    return {
      status: 429,
      body: { error: "You've reached the daily preview limit. Try again tomorrow." },
    };
  }

  const storage = deps.storage ?? createStorage(turso);

  let gemini: GeminiClient;
  if (deps.geminiClient) {
    gemini = deps.geminiClient;
  } else {
    const apiKey = (deps.apiKey ?? readGeminiApiKey()).trim();
    if (!apiKey) {
      logger.error('Naming preview: GEMINI_API_KEY not set');
      return { status: 500, body: { error: 'Service not configured' } };
    }
    try {
      gemini = createGeminiClient(apiKey);
    } catch (err) {
      logger.error('Naming preview: Gemini client init failed', err);
      return { status: 500, body: { error: 'Service not configured' } };
    }
  }

  const cache = {
    async get(key: string) {
      const entry = await storage.getCache(key);
      if (!entry) return null;
      return {
        value: entry.value as Awaited<ReturnType<typeof generate>>,
        expiresAt: entry.expiresAt,
      };
    },
    async set(key: string, value: Awaited<ReturnType<typeof generate>>, ttlDays: number) {
      await storage.setCache(key, value, ttlDays);
    },
  };

  try {
    const generateFn = deps.generate ?? generate;
    const generation = await generateFn({ seed }, { gemini, cache });

    const allNames = generation.candidates.map((c) => c.name);
    const avFn = deps.checkAvailability ?? checkAvailabilityFn;
    const availability = await avFn(allNames, ['com']);

    // Score all 200, then take the top-K from the non-excluded subset.
    const allScored: ScoredCandidate[] = await scoreAllCandidates(
      generation,
      availability,
      { userTonality },
    );
    const topScored = topK(allScored, DEFAULTS.TOP_K_FOR_SLIDER);

    // Persist run, all candidates (with score and excluded reason), and availability.
    const runId = await storage.insertRun({
      seedTerm: seed,
      creativity: 5, // legacy column; tonality replaces creativity in Phase 3
      tlds: ['com'],
      source: 'preview',
      configSnapshot: JSON.stringify({ tonality: userTonality }),
    });

    const idMap = await storage.insertScoredCandidates(runId, allScored);
    await storage.insertAvailability(idMap, availability);

    const responseCandidates: PreviewName[] = topScored.map((s) => ({
      name: s.candidate.name,
      typology: s.candidate.typology,
      rationale: s.candidate.rationale,
      tonality: s.candidate.tonality,
      score: Math.round(s.score * 100) / 100,
      domain: {
        available: s.domain.available,
        secondaryPriceUsd: s.domain.secondaryPriceUsd,
      },
    }));

    return {
      status: 200,
      body: { runId: String(runId), candidates: responseCandidates },
    };
  } catch (err) {
    if (err instanceof GeneratorValidationError) {
      logger.error(`Naming preview validation failed: ${err.rule} - ${err.details}`);
      return {
        status: 500,
        body: {
          error: 'Something went wrong. Try again in a minute.',
          validationRule: err.rule,
        },
      };
    }
    logger.error('Naming preview engine error', err);
    return {
      status: 500,
      body: { error: 'Something went wrong. Try again in a minute.' },
    };
  }
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const json = (s: unknown, status = 200) =>
    new Response(JSON.stringify(s), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const ip =
    clientAddress ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown';

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const result = await handlePreview(body, ip);
  return json(result.body, result.status);
};
