// Move 6 orchestrator: drafts a 1-2 sentence pitch for a Build option.
//
// Lighter than draft-build-description: no scrape. The relevant
// context lives in the wizard's adjacent fields (option name, the
// other option's pitch, the overall build description). The
// orchestrator passes those through and lets Gemini synthesize.

import {
  buildUserPrompt,
  SYSTEM_PROMPT,
  PROMPT_VERSION,
  RESPONSE_SCHEMA,
  type UserPromptInput,
} from './prompts/option-pitch';
import { deriveCacheKey } from '../cache';
import { stripFencesAndParse } from '../gemini-client';
import { lintSnippet } from '../voice-lint';
import { logger } from '../../logger';
import type { ProposalGeminiClient, ProposalCacheClient } from '../types';

export interface DraftOptionPitchArgs {
  clientName: string;
  domain: string;
  optionName: string;
  otherOptionName?: string | null;
  otherOptionPitch?: string | null;
  buildDescription?: string | null;
  inferredIndustry?: string | null;
  adminHint?: string | null;
  cacheTtlDays?: number;
}

export interface DraftOptionPitchDeps {
  gemini: ProposalGeminiClient;
  cache?: ProposalCacheClient;
  model: string;
}

export interface DraftOptionPitchResult {
  sentence: string;
  evidence: string;
  voice_violations: Array<{ rule: string; matched: string }>;
}

const DEFAULT_TTL_DAYS = 7;

export async function draftOptionPitch(
  args: DraftOptionPitchArgs,
  deps: DraftOptionPitchDeps,
): Promise<DraftOptionPitchResult> {
  const ttlDays = args.cacheTtlDays ?? DEFAULT_TTL_DAYS;

  // Cache key includes the inputs that meaningfully shape the
  // sentence. Admin hint is NOT in the key (treated as a steer
  // not a hard input). The other option's pitch IS in the key
  // because changing it changes what THIS pitch needs to contrast.
  const cacheKey = deriveCacheKey({
    promptVersion: PROMPT_VERSION,
    model: deps.model,
    feature: 'option-pitch',
    inputs: [
      args.clientName.toLowerCase().trim(),
      args.domain.toLowerCase().trim(),
      args.optionName.toLowerCase().trim(),
      (args.otherOptionName || '').toLowerCase().trim(),
      (args.otherOptionPitch || '').toLowerCase().trim(),
      (args.buildDescription || '').toLowerCase().trim(),
      (args.inferredIndustry || '').toLowerCase(),
    ].join('|'),
  });

  if (deps.cache && !args.adminHint?.trim()) {
    try {
      const cached = await deps.cache.get<DraftOptionPitchResult>(cacheKey);
      if (cached) return cached.value;
    } catch (err) {
      logger.warn('proposal-ai option-pitch: cache read failed', err);
    }
  }

  const promptInput: UserPromptInput = {
    client_name: args.clientName,
    domain: args.domain,
    option_name: args.optionName,
    other_option_name: args.otherOptionName ?? null,
    other_option_pitch: args.otherOptionPitch ?? null,
    build_description: args.buildDescription ?? null,
    inferred_industry: args.inferredIndustry ?? null,
    admin_hint: args.adminHint ?? null,
  };
  const userPrompt = buildUserPrompt(promptInput);

  const { text } = await deps.gemini.generateJson({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    temperature: 0.5,
    responseSchema: RESPONSE_SCHEMA,
  });
  const parsed = stripFencesAndParse<any>(text, 'Option pitch');

  const sentence = typeof parsed?.sentence === 'string' ? parsed.sentence.trim() : '';
  const evidence = typeof parsed?.evidence === 'string' ? parsed.evidence.trim() : '';
  if (!sentence) throw new Error('Option pitch response was empty');

  const lint = lintSnippet(sentence);
  const result: DraftOptionPitchResult = {
    sentence,
    evidence,
    voice_violations: lint.ok ? [] : lint.violations,
  };

  if (deps.cache && !args.adminHint?.trim() && lint.ok) {
    try {
      await deps.cache.set(cacheKey, result, ttlDays, 'option-pitch');
    } catch (err) {
      logger.warn('proposal-ai option-pitch: cache write failed', err);
    }
  }

  return result;
}
