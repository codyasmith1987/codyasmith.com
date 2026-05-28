// Slice 3 orchestrator: drafts a one-sentence description of a Build
// engagement for the proposal builder.
//
// Reuses the client research scrape (same primary-domain homepage
// scrape + Serper queries) when the cached research blob is
// available. When it is not, the call falls back to scraping just
// the homepage so the model has at least one source for brand
// extraction.

import { scrapeAll } from '../../scraper';
import {
  buildUserPrompt,
  SYSTEM_PROMPT,
  PROMPT_VERSION,
  RESPONSE_SCHEMA,
  type UserPromptInput,
} from './prompts/build-description';
import { deriveCacheKey } from '../cache';
import { stripFencesAndParse } from '../gemini-client';
import { lintSnippet } from '../voice-lint';
import { logger } from '../../logger';
import type { ProposalGeminiClient, ProposalCacheClient } from '../types';

export interface DraftBuildDescriptionArgs {
  clientName: string;
  domain: string;
  buildSize: 'small' | 'mid' | 'large';
  inferredIndustry?: string | null;
  inferredUrgency?: string | null;
  adminHint?: string | null;
  currentSites?: Array<{ domain: string; label?: string | null; is_primary?: boolean; is_managed?: boolean; page_count?: number | null }>;
  cacheTtlDays?: number;
}

export interface DraftBuildDescriptionDeps {
  gemini: ProposalGeminiClient;
  cache?: ProposalCacheClient;
  model: string;
  scrape?: typeof scrapeAll;
}

export interface DraftBuildDescriptionResult {
  sentence: string;
  evidence: string;
  voice_violations: Array<{ rule: string; matched: string }>;
}

const DEFAULT_TTL_DAYS = 7;

export async function draftBuildDescription(
  args: DraftBuildDescriptionArgs,
  deps: DraftBuildDescriptionDeps,
): Promise<DraftBuildDescriptionResult> {
  const ttlDays = args.cacheTtlDays ?? DEFAULT_TTL_DAYS;

  // Cache key incorporates inputs that affect the output. Admin hint
  // is intentionally NOT in the key so iterating the hint without
  // re-spending Gemini calls is possible (admin hint is treated as
  // a steer, not a hard input). Industry / urgency are part of the
  // sentence direction so they ARE part of the key.
  const cacheKey = deriveCacheKey({
    promptVersion: PROMPT_VERSION,
    model: deps.model,
    feature: 'build-description',
    inputs: [
      args.clientName.toLowerCase().trim(),
      args.domain.toLowerCase().trim(),
      args.buildSize,
      (args.inferredIndustry || '').toLowerCase(),
      (args.inferredUrgency || '').toLowerCase(),
      (args.currentSites || []).map(s => `${s.domain}:${s.is_primary ? 'p' : ''}:${s.is_managed ? 'm' : ''}:${s.page_count ?? ''}`).join(','),
    ].join('|'),
  });

  // Try cache (skip when admin supplied a hint, since the model may
  // use it to shape output and a cached generic sentence won't
  // reflect the hint).
  if (deps.cache && !args.adminHint?.trim()) {
    try {
      const cached = await deps.cache.get<DraftBuildDescriptionResult>(cacheKey);
      if (cached) return cached.value;
    } catch (err) {
      logger.warn('proposal-ai build-description: cache read failed', err);
    }
  }

  // Scrape the homepage for brand grounding. Single page; this is
  // a per-field call, not a full research run.
  const scrapeFn = deps.scrape ?? scrapeAll;
  const homepageUrl = `https://${args.domain}/`;
  let scraped: Array<{ url: string; text: string }> = [];
  try {
    const result = await scrapeFn([{ url: homepageUrl, query_type: 'homepage' }]);
    scraped = result.map(s => ({ url: s.url, text: s.full_text || s.snippet || '' }));
  } catch (err) {
    logger.warn('proposal-ai build-description: homepage scrape failed, continuing', err);
  }

  const promptInput: UserPromptInput = {
    client_name: args.clientName,
    domain: args.domain,
    build_size: args.buildSize,
    inferred_industry: args.inferredIndustry ?? null,
    inferred_urgency: args.inferredUrgency ?? null,
    admin_hint: args.adminHint ?? null,
    current_sites: args.currentSites ?? [],
    scraped_excerpts: scraped,
  };
  const userPrompt = buildUserPrompt(promptInput);

  const { text } = await deps.gemini.generateJson({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    temperature: 0.4,
    responseSchema: RESPONSE_SCHEMA,
  });
  const parsed = stripFencesAndParse<any>(text, 'Build description');

  const sentence = typeof parsed?.sentence === 'string' ? parsed.sentence.trim() : '';
  const evidence = typeof parsed?.evidence === 'string' ? parsed.evidence.trim() : '';
  if (!sentence) throw new Error('Build description response was empty');

  // Voice lint. Returned to the caller so the wizard can surface
  // violations inline. We do NOT auto-reject; admin sees the draft
  // and decides whether to apply it.
  const lint = lintSnippet(sentence);
  const result: DraftBuildDescriptionResult = {
    sentence,
    evidence,
    voice_violations: lint.ok ? [] : lint.violations,
  };

  if (deps.cache && !args.adminHint?.trim() && lint.ok) {
    try {
      await deps.cache.set(cacheKey, result, ttlDays, 'build-description');
    } catch (err) {
      logger.warn('proposal-ai build-description: cache write failed', err);
    }
  }

  return result;
}
