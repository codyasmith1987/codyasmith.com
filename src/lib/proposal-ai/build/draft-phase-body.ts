// Move 6 orchestrator: drafts a single rollout phase paragraph.

import {
  buildUserPrompt,
  SYSTEM_PROMPT,
  PROMPT_VERSION,
  RESPONSE_SCHEMA,
  type UserPromptInput,
} from './prompts/phase-body';
import { deriveCacheKey } from '../cache';
import { stripFencesAndParse } from '../gemini-client';
import { lintSnippet } from '../voice-lint';
import { logger } from '../../logger';
import type { ProposalGeminiClient, ProposalCacheClient } from '../types';

export interface DraftPhaseBodyArgs {
  clientName: string;
  domain: string;
  phaseHeader: string;
  phaseIndex: number;
  totalPhases: number;
  optionName?: string | null;
  optionPitch?: string | null;
  buildDescription?: string | null;
  webManagementInScope?: boolean;
  adminHint?: string | null;
  currentSites?: Array<{ domain: string; label?: string | null; is_primary?: boolean; is_managed?: boolean; page_count?: number | null }>;
  cacheTtlDays?: number;
}

export interface DraftPhaseBodyDeps {
  gemini: ProposalGeminiClient;
  cache?: ProposalCacheClient;
  model: string;
}

export interface DraftPhaseBodyResult {
  html: string;
  evidence: string;
  voice_violations: Array<{ rule: string; matched: string }>;
}

const DEFAULT_TTL_DAYS = 7;

export async function draftPhaseBody(
  args: DraftPhaseBodyArgs,
  deps: DraftPhaseBodyDeps,
): Promise<DraftPhaseBodyResult> {
  const ttlDays = args.cacheTtlDays ?? DEFAULT_TTL_DAYS;

  const cacheKey = deriveCacheKey({
    promptVersion: PROMPT_VERSION,
    model: deps.model,
    feature: 'phase-body',
    inputs: [
      args.clientName.toLowerCase().trim(),
      args.domain.toLowerCase().trim(),
      args.phaseHeader.toLowerCase().trim(),
      String(args.phaseIndex),
      String(args.totalPhases),
      (args.optionName || '').toLowerCase().trim(),
      (args.optionPitch || '').toLowerCase().trim(),
      (args.buildDescription || '').toLowerCase().trim(),
      String(!!args.webManagementInScope),
      (args.currentSites || []).map(s => `${s.domain}:${s.is_primary ? 'p' : ''}:${s.is_managed ? 'm' : ''}:${s.page_count ?? ''}`).join(','),
    ].join('|'),
  });

  if (deps.cache && !args.adminHint?.trim()) {
    try {
      const cached = await deps.cache.get<DraftPhaseBodyResult>(cacheKey);
      if (cached) return cached.value;
    } catch (err) {
      logger.warn('proposal-ai phase-body: cache read failed', err);
    }
  }

  const promptInput: UserPromptInput = {
    client_name: args.clientName,
    domain: args.domain,
    phase_header: args.phaseHeader,
    phase_index: args.phaseIndex,
    total_phases: args.totalPhases,
    option_name: args.optionName ?? null,
    option_pitch: args.optionPitch ?? null,
    build_description: args.buildDescription ?? null,
    web_management_in_scope: args.webManagementInScope,
    admin_hint: args.adminHint ?? null,
    current_sites: args.currentSites ?? [],
  };
  const userPrompt = buildUserPrompt(promptInput);

  const { text } = await deps.gemini.generateJson({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    temperature: 0.4,
    responseSchema: RESPONSE_SCHEMA,
  });
  const parsed = stripFencesAndParse<any>(text, 'Phase body');

  const html = typeof parsed?.html === 'string' ? parsed.html.trim() : '';
  const evidence = typeof parsed?.evidence === 'string' ? parsed.evidence.trim() : '';
  if (!html) throw new Error('Phase body response was empty');

  // Voice-lint runs on the text content, not the HTML wrapper. Strip
  // <strong> tags before linting so they don't false-positive.
  const textOnly = html.replace(/<\/?strong>/g, '').replace(/<[^>]+>/g, '');
  const lint = lintSnippet(textOnly);
  const result: DraftPhaseBodyResult = {
    html,
    evidence,
    voice_violations: lint.ok ? [] : lint.violations,
  };

  if (deps.cache && !args.adminHint?.trim() && lint.ok) {
    try {
      await deps.cache.set(cacheKey, result, ttlDays, 'phase-body');
    } catch (err) {
      logger.warn('proposal-ai phase-body: cache write failed', err);
    }
  }

  return result;
}
