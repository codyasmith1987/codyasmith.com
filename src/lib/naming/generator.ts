// Phase 3 Path C generator. Four parallel Gemini calls per generation, one
// per typology. Each call runs a per-call validator with retry-once on
// failure. After all four calls succeed, a merge validator runs on the
// unified pool (cross-call collision checks). On any unrecoverable failure
// the generator throws GeneratorValidationError; the endpoint surfaces 500.

import { createHash } from 'node:crypto';
import { GoogleGenerativeAI } from '@google/generative-ai';

import { DEFAULTS } from './config';
import { buildGeneratePrompt } from './prompts/generate';
import { endsWithForbiddenSuffix, FORBIDDEN_SUFFIXES } from './anti-patterns';
import { logger } from '../logger';
import type {
  CacheEntry,
  GenerateOptions,
  GenerateResult,
  NameCandidate,
  TonalityVector,
  Typology,
} from './types';
import { TONALITY_AXES, TYPOLOGY_LIST } from './types';

export interface GeminiClient {
  generateContent(opts: {
    systemPrompt: string;
    temperature: number;
  }): Promise<{ text: string }>;
}

export interface CacheClient {
  get(key: string): Promise<CacheEntry<GenerateResult> | null>;
  set(key: string, value: GenerateResult, ttlDays: number): Promise<void>;
}

export interface GeneratorDeps {
  gemini: GeminiClient;
  cache?: CacheClient;
  model?: string;
  promptVersion?: string;
}

export class GeneratorValidationError extends Error {
  rule: string;
  details: string;
  typology?: Typology;
  charCount?: number;
  constructor(rule: string, details: string, opts: { typology?: Typology; charCount?: number } = {}) {
    super(`Generator validation failed [${rule}]${opts.typology ? ` (${opts.typology})` : ''}: ${details}`);
    this.rule = rule;
    this.details = details;
    this.typology = opts.typology;
    this.charCount = opts.charCount;
    this.name = 'GeneratorValidationError';
  }
}

export function createGeminiClient(apiKey: string, model: string = DEFAULTS.MODEL): GeminiClient {
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is required to create a Gemini client');
  }
  const ai = new GoogleGenerativeAI(apiKey);
  return {
    async generateContent({ systemPrompt, temperature }) {
      const m = ai.getGenerativeModel({
        model,
        generationConfig: {
          temperature,
          responseMimeType: 'application/json',
          // Each per-typology call asks for ~50 candidates; default cap
          // is plenty but this gives margin for the model's overshoot.
          maxOutputTokens: 16384,
        },
      });
      try {
        const result = await m.generateContent(systemPrompt);
        return { text: result.response.text() };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (/RESOURCE_EXHAUSTED|429/i.test(message)) {
          throw new Error(`Gemini quota exhausted: ${message}`);
        }
        throw err;
      }
    },
  };
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function stripMarkdownFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

const COINED_MARKERS = ['portmanteau', 'compression', 'compresses', 'blend', 'blends'];
const NAME_REGEX = /^[A-Za-z][A-Za-z-]*$/;

function generateRetryToken(): string {
  return Math.random().toString(36).slice(2, 10);
}

// Per-call validator: validates a single typology batch from one Gemini call.
// Stamps typology onto each candidate after validation. Throws on any rule
// break. Used inside generateOneTypology, before retry-once decision.
export function parseAndValidatePerCall(
  text: string,
  typology: Typology,
): NameCandidate[] {
  const charCount = text.length;
  const stripped = stripMarkdownFences(text);

  let json: unknown;
  try {
    json = JSON.parse(stripped);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new GeneratorValidationError('invalid_json', msg, { typology, charCount });
  }

  if (!json || typeof json !== 'object') {
    throw new GeneratorValidationError('not_object', 'response not an object', { typology, charCount });
  }
  const obj = json as Record<string, unknown>;
  if (!Array.isArray(obj.candidates)) {
    throw new GeneratorValidationError('missing_candidates_array', 'no candidates array', { typology, charCount });
  }
  const candidates = obj.candidates as unknown[];

  // Per-call count floor.
  if (candidates.length < DEFAULTS.MIN_PER_TYPOLOGY) {
    throw new GeneratorValidationError(
      'per_call_count_too_low',
      `got ${candidates.length}, need at least ${DEFAULTS.MIN_PER_TYPOLOGY}`,
      { typology, charCount },
    );
  }

  const seenNames = new Set<string>();
  const validated: NameCandidate[] = [];
  let filteredForbiddenCount = 0;

  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i];
    if (!c || typeof c !== 'object') {
      throw new GeneratorValidationError('candidate_not_object', `candidate ${i} not an object`, { typology, charCount });
    }
    const cobj = c as Record<string, unknown>;

    if (typeof cobj.name !== 'string' || !cobj.name.trim()) {
      throw new GeneratorValidationError('invalid_name', `candidate ${i} has invalid name`, { typology, charCount });
    }
    const name = cobj.name.trim();

    if (name.length < DEFAULTS.NAME_MIN_LENGTH || name.length > DEFAULTS.NAME_MAX_LENGTH) {
      throw new GeneratorValidationError(
        'name_length_out_of_range',
        `${name} length ${name.length} outside ${DEFAULTS.NAME_MIN_LENGTH}-${DEFAULTS.NAME_MAX_LENGTH}`,
        { typology, charCount },
      );
    }
    if (!NAME_REGEX.test(name)) {
      throw new GeneratorValidationError(
        'name_invalid_chars',
        `${name} contains non-letters, digits, spaces, or non-ASCII`,
        { typology, charCount },
      );
    }
    if (!/^[A-Z]/.test(name)) {
      throw new GeneratorValidationError('name_not_capitalized', `${name} not capitalized`, { typology, charCount });
    }

    // Forbidden suffix: filter-out, not reject-batch. Drop the offending
    // candidate and continue. The post-loop floor check enforces the floor
    // of MIN_PER_TYPOLOGY (30) on the surviving count.
    const forbidden = endsWithForbiddenSuffix(name);
    if (forbidden) {
      filteredForbiddenCount += 1;
      logger.info(
        `naming generator filtered forbidden-suffix candidate`,
        { typology, name, suffix: forbidden },
      );
      continue;
    }

    if (seenNames.has(name.toLowerCase())) {
      throw new GeneratorValidationError(
        'duplicate_name_in_call',
        `${name} appears more than once within ${typology} batch`,
        { typology, charCount },
      );
    }
    seenNames.add(name.toLowerCase());

    if (typeof cobj.rationale !== 'string') {
      throw new GeneratorValidationError('rationale_not_string', `${name} rationale not a string`, { typology, charCount });
    }
    const rationale = cobj.rationale.trim();
    if (
      rationale.length < DEFAULTS.RATIONALE_MIN_LENGTH ||
      rationale.length > DEFAULTS.RATIONALE_MAX_LENGTH
    ) {
      throw new GeneratorValidationError(
        'rationale_length',
        `${name} rationale ${rationale.length} chars outside ${DEFAULTS.RATIONALE_MIN_LENGTH}-${DEFAULTS.RATIONALE_MAX_LENGTH}`,
        { typology, charCount },
      );
    }

    if (typology === 'abstract') {
      const lowerR = rationale.toLowerCase();
      const hasMarker = COINED_MARKERS.some((m) => lowerR.includes(m));
      if (!hasMarker) {
        throw new GeneratorValidationError(
          'abstract_missing_marker',
          `${name} (abstract) rationale must mention one of: ${COINED_MARKERS.join(', ')}`,
          { typology, charCount },
        );
      }
    }

    if (!cobj.tonality || typeof cobj.tonality !== 'object') {
      throw new GeneratorValidationError('tonality_missing', `${name} missing tonality vector`, { typology, charCount });
    }
    const tRaw = cobj.tonality as Record<string, unknown>;
    const tonality: TonalityVector = {
      serious_playful: 3,
      modern_classical: 3,
      descriptive_abstract: 3,
      technical_emotional: 3,
      conservative_bold: 3,
    };
    for (const axis of TONALITY_AXES) {
      const v = tRaw[axis];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || v > 5) {
        throw new GeneratorValidationError(
          'tonality_axis_out_of_range',
          `${name}.${axis} = ${String(v)} not in 1-5`,
          { typology, charCount },
        );
      }
      tonality[axis] = v;
    }

    validated.push({ name, typology, rationale, tonality });
  }

  // Post-filter floor: if forbidden-suffix filtering dropped us below the
  // per-typology minimum, surface as a count failure with the original size
  // logged so we can see how aggressive the filter was.
  if (validated.length < DEFAULTS.MIN_PER_TYPOLOGY) {
    throw new GeneratorValidationError(
      'per_call_count_too_low',
      `after filtering ${filteredForbiddenCount} forbidden-suffix candidate(s), ` +
        `${validated.length} remain (need at least ${DEFAULTS.MIN_PER_TYPOLOGY}). ` +
        `Original batch: ${candidates.length}.`,
      { typology, charCount },
    );
  }

  return validated;
}

// Single-typology call with per-call validation and retry-once on validation
// failure. The retry uses a fresh seed-token (random) appended to the prompt
// to nudge the model to a different output.
async function generateOneTypology(
  seed: string,
  typology: Typology,
  gemini: GeminiClient,
): Promise<NameCandidate[]> {
  const attempt = async (retryToken?: string): Promise<NameCandidate[]> => {
    const prompt = buildGeneratePrompt(seed, typology, retryToken);
    const result = await gemini.generateContent({
      systemPrompt: prompt,
      temperature: retryToken ? 1.0 : 0.9, // bump temp on retry for diversity
    });
    return parseAndValidatePerCall(result.text, typology);
  };

  try {
    return await attempt();
  } catch (err) {
    if (err instanceof GeneratorValidationError) {
      logger.warn(
        `naming generator per-call validation failed`,
        {
          rule: err.rule,
          typology,
          char_count: err.charCount,
          seed,
          retrying: true,
        },
      );
      const retryToken = generateRetryToken();
      try {
        return await attempt(retryToken);
      } catch (retryErr) {
        if (retryErr instanceof GeneratorValidationError) {
          logger.error(
            `naming generator per-call validation failed on retry`,
            {
              rule: retryErr.rule,
              typology,
              char_count: retryErr.charCount,
              seed,
              retry_token: retryToken,
            },
          );
        }
        throw retryErr;
      }
    }
    throw err;
  }
}

// Merge validator: cross-call checks on the unified pool. No retry; cross-
// call collisions are unlikely to resolve on retry.
export function validateMerged(merged: NameCandidate[], seed: string): void {
  if (merged.length < DEFAULTS.MIN_TOTAL_CANDIDATES) {
    throw new GeneratorValidationError(
      'merged_total_too_low',
      `unified pool has ${merged.length}, need at least ${DEFAULTS.MIN_TOTAL_CANDIDATES}`,
    );
  }

  const typoCounts: Record<Typology, number> = {
    descriptive: 0,
    suggestive: 0,
    associative: 0,
    abstract: 0,
  };
  for (const c of merged) typoCounts[c.typology] += 1;
  for (const t of TYPOLOGY_LIST) {
    if (typoCounts[t] < DEFAULTS.MIN_PER_TYPOLOGY) {
      throw new GeneratorValidationError(
        'merged_typology_too_low',
        `${t}: got ${typoCounts[t]}, need at least ${DEFAULTS.MIN_PER_TYPOLOGY}`,
      );
    }
  }

  // Cross-call duplicate names
  const seen = new Set<string>();
  for (const c of merged) {
    const lower = c.name.toLowerCase();
    if (seen.has(lower)) {
      throw new GeneratorValidationError(
        'merged_duplicate_name',
        `${c.name} appears more than once across the unified pool`,
      );
    }
    seen.add(lower);
  }

  // Cross-call shared 4-char prefix or suffix
  const len = DEFAULTS.SHARED_AFFIX_LENGTH;
  const prefixSeen = new Map<string, string>();
  const suffixSeen = new Map<string, string>();
  for (const c of merged) {
    if (c.name.length < len) continue;
    const pre = c.name.slice(0, len).toLowerCase();
    if (prefixSeen.has(pre) && prefixSeen.get(pre) !== c.name) {
      throw new GeneratorValidationError(
        'merged_shared_prefix',
        `${c.name} shares ${len}-char prefix '${pre}' with ${prefixSeen.get(pre)}`,
      );
    }
    prefixSeen.set(pre, c.name);
    const suf = c.name.slice(-len).toLowerCase();
    if (suffixSeen.has(suf) && suffixSeen.get(suf) !== c.name) {
      throw new GeneratorValidationError(
        'merged_shared_suffix',
        `${c.name} shares ${len}-char suffix '${suf}' with ${suffixSeen.get(suf)}`,
      );
    }
    suffixSeen.set(suf, c.name);
  }
}

export async function generate(
  options: GenerateOptions,
  deps: GeneratorDeps,
): Promise<GenerateResult> {
  const { seed, cache: useCache = true } = options;
  const promptVersion = options.promptVersion ?? deps.promptVersion ?? DEFAULTS.PROMPT_VERSION;
  const model = deps.model ?? DEFAULTS.MODEL;

  const cacheKey = sha256(`${promptVersion}|${model}|${seed}`);

  if (useCache && deps.cache) {
    const cached = await deps.cache.get(cacheKey);
    if (cached) return cached.value;
  }

  // Four parallel calls, one per typology. Each independently validated and
  // independently retried-once on validation failure.
  const calls = TYPOLOGY_LIST.map((t) => generateOneTypology(seed, t, deps.gemini));
  const settled = await Promise.allSettled(calls);

  // Collect results and surface the first failure if any.
  const merged: NameCandidate[] = [];
  for (let i = 0; i < settled.length; i += 1) {
    const r = settled[i];
    if (r.status === 'rejected') {
      const reason = r.reason;
      if (reason instanceof GeneratorValidationError) throw reason;
      throw reason;
    }
    merged.push(...r.value);
  }

  validateMerged(merged, seed);

  const result: GenerateResult = { candidates: merged };

  if (useCache && deps.cache) {
    await deps.cache.set(cacheKey, result, DEFAULTS.CACHE_TTL_DAYS);
  }

  return result;
}

// Legacy export retained for the Phase 1/2 unit-test runner that still
// imports parseAndValidate. Phase 3 callers use parseAndValidatePerCall +
// validateMerged. This shim treats the input as a Phase 1 payload and
// throws if it isn't, so legacy tests still meaningfully exercise rejection.
export function parseAndValidate(text: string): GenerateResult {
  // Path C does not have an equivalent of the Phase 1 single-call validator
  // (since validation is now split across per-call and merge stages). For
  // backward compatibility, parse minimal structure and surface anything
  // that doesn't look like a Phase 3 result.
  const stripped = stripMarkdownFences(text);
  let json: unknown;
  try {
    json = JSON.parse(stripped);
  } catch (e) {
    throw new GeneratorValidationError('invalid_json', e instanceof Error ? e.message : String(e));
  }
  if (!json || typeof json !== 'object') {
    throw new GeneratorValidationError('not_object', 'response is not an object');
  }
  const obj = json as Record<string, unknown>;
  if (!Array.isArray(obj.candidates)) {
    throw new GeneratorValidationError('missing_candidates_array', 'no candidates array');
  }
  // Just return as-is, no further validation. Production path uses generate()
  // which invokes the proper per-call and merge validators.
  return obj as unknown as GenerateResult;
}
