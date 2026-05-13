// POST /api/naming/preview
// Phase 2 of the naming pipeline. Public preview endpoint.
//
// The route handler is thin: parse JSON body, derive client IP, defer to the
// exported handlePreview function for all logic. handlePreview takes a deps
// object so the unit-test runner can mock the engine, RDAP, and rate limiter
// without touching the network or the real DB.

import type { APIRoute } from 'astro';
import { rateLimit as rateLimitFn } from '../../../lib/rate-limit';
import { logger } from '../../../lib/logger';
import {
  generate,
  createGeminiClient,
  type GeminiClient,
} from '../../../lib/naming/generator';
import {
  checkAvailability as checkAvailabilityFn,
} from '../../../lib/naming/availability';
import { rankPhase1 } from '../../../lib/naming/ranker';
import { createStorage, type NamingStorage } from '../../../lib/naming/storage';
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
  available: boolean | null;
  rationale: string;
}

export interface PreviewResult {
  status: number;
  body: {
    runId?: string;
    names?: PreviewName[];
    error?: string;
  };
}

function readGeminiApiKey(): string {
  const env: Record<string, string | undefined> =
    (import.meta as { env?: Record<string, string | undefined> }).env ??
    (typeof process !== 'undefined' ? (process.env as Record<string, string | undefined>) : {});
  return (env.GEMINI_API_KEY ?? '').trim();
}

export async function handlePreview(
  rawBody: unknown,
  ip: string,
  deps: PreviewDeps = {},
): Promise<PreviewResult> {
  // Body shape
  if (!rawBody || typeof rawBody !== 'object') {
    return { status: 400, body: { error: 'Invalid request body' } };
  }
  const body = rawBody as { seed?: unknown; creativity?: unknown };

  // Seed
  const seed = typeof body.seed === 'string' ? body.seed.trim() : '';
  if (!seed) {
    return { status: 400, body: { error: 'Seed term is required' } };
  }
  if (seed.length > SEED_MAX_LENGTH) {
    return { status: 400, body: { error: `Seed term must be ${SEED_MAX_LENGTH} characters or fewer` } };
  }

  // Creativity (default 5, clamp to 1..10, integer)
  let creativity = 5;
  if (body.creativity !== undefined && body.creativity !== null) {
    if (typeof body.creativity !== 'number' || !Number.isFinite(body.creativity)) {
      return { status: 400, body: { error: 'Creativity must be a number' } };
    }
    const c = Math.round(body.creativity);
    if (c < 1 || c > 10) {
      return { status: 400, body: { error: 'Creativity must be between 1 and 10' } };
    }
    creativity = c;
  }

  // IP / rate limit. Fail-closed because each preview costs a Gemini call
  // and a Turso write; a transient DB outage should not open the door to
  // unlimited Gemini cost. See security-audit-2026-05-12 round 2 SEC2-007.
  if (!ip || ip === 'unknown') {
    return { status: 400, body: { error: 'Could not verify your request' } };
  }
  const rl = deps.rateLimit ?? rateLimitFn;
  // Pass failClosed=true via positional arg 4 of the production rateLimit
  // function. Tests pass a mock that ignores extra args.
  const hourOk = await (rl as (k: string, m: number, w: number, fc?: boolean) => Promise<boolean>)(
    `naming-preview:hour:${ip}`, HOURLY_LIMIT, HOUR_MS, true,
  );
  if (!hourOk) {
    return {
      status: 429,
      body: { error: "You've reached the hourly preview limit. Try again in an hour." },
    };
  }
  const dayOk = await (rl as (k: string, m: number, w: number, fc?: boolean) => Promise<boolean>)(
    `naming-preview:day:${ip}`, DAILY_LIMIT, DAY_MS, true,
  );
  if (!dayOk) {
    return {
      status: 429,
      body: { error: "You've reached the daily preview limit. Try again tomorrow." },
    };
  }

  // Storage and Gemini client
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

  // Cache adapter on top of storage's gemini cache
  const cache = {
    async get(key: string) {
      const entry = await storage.getCache(key);
      if (!entry) return null;
      return { value: entry.value as Awaited<ReturnType<typeof generate>>, expiresAt: entry.expiresAt };
    },
    async set(key: string, value: Awaited<ReturnType<typeof generate>>, ttlDays: number) {
      await storage.setCache(key, value, ttlDays);
    },
  };

  // Engine pipeline
  try {
    const generateFn = deps.generate ?? generate;
    const generation = await generateFn(
      { seed, creativity },
      { gemini, cache },
    );

    const allNames = generation.parents.flatMap((p) => p.variants.map((v) => v.name));

    const avFn = deps.checkAvailability ?? checkAvailabilityFn;
    const availability = await avFn(allNames, ['com']);

    const ranked = rankPhase1(generation, availability, {
      tlds: ['com'],
      includeUnavailable: true,
    });
    const top5 = ranked.slice(0, 5);

    const names: PreviewName[] = top5.map((r) => ({
      name: r.name,
      available: r.availabilityByTld.com ?? null,
      rationale: r.variantRationale,
    }));

    // Persist the run, names, and availability
    const runId = await storage.insertRun({
      seedTerm: seed,
      creativity,
      tlds: ['com'],
      source: 'preview',
    });
    const idMap = await storage.insertNames(runId, generation);
    await storage.insertAvailability(idMap, availability);

    return { status: 200, body: { runId: String(runId), names } };
  } catch (err) {
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
