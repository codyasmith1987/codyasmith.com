// Gemini call wrapper with response validation and a Turso-backed cache layer.
// Cache keys are SHA-256 of (promptVersion + model + creativity + seed).
// Cache TTL is 7 days. Quota fallback to Anthropic Haiku is a Phase 5 concern;
// here, RESOURCE_EXHAUSTED bubbles up with a clear message.

import { createHash } from 'node:crypto';
import { GoogleGenerativeAI } from '@google/generative-ai';

import { DEFAULTS, temperatureForCreativity } from './config';
import { antiPatternsForCreativity } from './anti-patterns';
import { buildGeneratePrompt } from './prompts/generate';
import type { GenerateOptions, GenerateResult, CacheEntry } from './types';

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
        },
      });
      try {
        const result = await m.generateContent(systemPrompt);
        const text = result.response.text();
        return { text };
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

export async function generate(
  options: GenerateOptions,
  deps: GeneratorDeps,
): Promise<GenerateResult> {
  const { seed, creativity, cache: useCache = true } = options;
  const promptVersion = options.promptVersion ?? deps.promptVersion ?? DEFAULTS.PROMPT_VERSION;
  const model = deps.model ?? DEFAULTS.MODEL;

  const cacheKey = sha256(`${promptVersion}|${model}|${creativity}|${seed}`);

  if (useCache && deps.cache) {
    const cached = await deps.cache.get(cacheKey);
    if (cached) return cached.value;
  }

  const antiPatterns = antiPatternsForCreativity(creativity);
  const prompt = buildGeneratePrompt(seed, creativity, antiPatterns);
  const temperature = temperatureForCreativity(creativity);

  const result = await deps.gemini.generateContent({
    systemPrompt: prompt,
    temperature,
  });

  const parsed = parseAndValidate(result.text);

  if (useCache && deps.cache) {
    await deps.cache.set(cacheKey, parsed, DEFAULTS.CACHE_TTL_DAYS);
  }

  return parsed;
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

// Strip markdown fences defensively. Gemini occasionally adds them even with
// responseMimeType=application/json set.
function stripMarkdownFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

export function parseAndValidate(text: string): GenerateResult {
  const stripped = stripMarkdownFences(text);

  let json: unknown;
  try {
    json = JSON.parse(stripped);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Generator returned invalid JSON: ${msg}`);
  }

  if (!json || typeof json !== 'object') {
    throw new Error('Generator response is not an object');
  }
  const obj = json as Record<string, unknown>;
  if (!Array.isArray(obj.parents)) {
    throw new Error('Generator response missing parents array');
  }
  const parents = obj.parents as unknown[];
  if (parents.length !== DEFAULTS.PARENTS_PER_GENERATION) {
    throw new Error(
      `Generator returned ${parents.length} parents, expected ${DEFAULTS.PARENTS_PER_GENERATION}`,
    );
  }

  for (let i = 0; i < parents.length; i += 1) {
    const parent = parents[i];
    if (!parent || typeof parent !== 'object') {
      throw new Error(`Parent ${i} is not an object`);
    }
    const p = parent as Record<string, unknown>;
    if (typeof p.name !== 'string' || !p.name.trim()) {
      throw new Error(`Parent ${i} has invalid name`);
    }
    if (typeof p.rationale !== 'string') {
      throw new Error(`Parent ${i} has invalid rationale`);
    }
    if (!Array.isArray(p.variants)) {
      throw new Error(`Parent ${i} missing variants array`);
    }
    const variants = p.variants as unknown[];
    if (variants.length !== DEFAULTS.VARIANTS_PER_PARENT) {
      throw new Error(
        `Parent ${i} returned ${variants.length} variants, expected ${DEFAULTS.VARIANTS_PER_PARENT}`,
      );
    }
    for (let j = 0; j < variants.length; j += 1) {
      const variant = variants[j];
      if (!variant || typeof variant !== 'object') {
        throw new Error(`Parent ${i} variant ${j} is not an object`);
      }
      const v = variant as Record<string, unknown>;
      if (typeof v.name !== 'string' || !v.name.trim()) {
        throw new Error(`Parent ${i} variant ${j} has invalid name`);
      }
      if (typeof v.rationale !== 'string') {
        throw new Error(`Parent ${i} variant ${j} has invalid rationale`);
      }
    }
  }

  return json as GenerateResult;
}
