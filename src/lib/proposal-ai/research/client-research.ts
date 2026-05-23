// Client research orchestrator.
//
// One entry point: researchClient({clientName, domain, ...}). It runs
// Serper queries about the client, scrapes the top hits, fetches the
// site's sitemap for an initial page count, then asks Gemini to
// synthesize a structured proposal-builder seed. The result is cached
// for 30 days, keyed on client + research version + model.
//
// All external dependencies (Gemini, cache, Serper, scraper, sitemap)
// are injected via the args so unit tests can mock them. The wizard
// endpoint constructs the production wiring; tests construct fakes.

import { scrapeAll } from '../../scraper';
import { fetchSitemapUrlCount } from './sitemap-fetch';
import {
  buildUserPrompt,
  SYSTEM_PROMPT,
  PROMPT_VERSION,
  RESPONSE_SCHEMA,
  type UserPromptInput,
} from './prompts/client-research';
import { deriveCacheKey } from '../cache';
import { stripFencesAndParse } from '../gemini-client';
import { logger } from '../../logger';
import type {
  ProposalGeminiClient,
  ProposalCacheClient,
  ClientResearchResult,
  RevenueBand,
  ConfidenceLevel,
  IndustryGuess,
  UrgencyGuess,
  FocusTag,
  DomainGuess,
} from '../types';

const VALID_REVENUE: ReadonlySet<RevenueBand> = new Set(['under-1m', '1m-to-10m', 'over-10m', 'unknown']);
const VALID_CONFIDENCE: ReadonlySet<ConfidenceLevel> = new Set(['low', 'medium', 'high']);
const VALID_INDUSTRY: ReadonlySet<IndustryGuess> = new Set([
  'solo', 'professional-services', 'contractor', 'ecommerce',
  'family-of-companies', 'nonprofit', 'other', 'unknown',
]);
const VALID_URGENCY: ReadonlySet<UrgencyGuess> = new Set(['tactical', 'growth', 'maintenance', 'unknown']);
const VALID_FOCUS: ReadonlySet<FocusTag> = new Set([
  'revenue', 'brand', 'takeover', 'search', 'pre-sell', 'hiring',
]);

export interface ResearchClientArgs {
  clientName: string;
  domain: string;
  cacheTtlDays?: number;
}

export interface ResearchClientDeps {
  gemini: ProposalGeminiClient;
  cache?: ProposalCacheClient;
  serperApiKey: string;
  model: string;
  serperSearch?: SerperSearchFn;          // tests inject a fake
  scrape?: ScrapeFn;                      // tests inject a fake
  sitemapFetch?: SitemapFetchFn;          // tests inject a fake
}

export type SerperSearchFn = (query: string, num: number) => Promise<Array<{ url: string; title: string; snippet: string }>>;
export type ScrapeFn = typeof scrapeAll;
export type SitemapFetchFn = typeof fetchSitemapUrlCount;

const DEFAULT_TTL_DAYS = 30;

export async function researchClient(
  args: ResearchClientArgs,
  deps: ResearchClientDeps,
): Promise<ClientResearchResult> {
  const ttlDays = args.cacheTtlDays ?? DEFAULT_TTL_DAYS;

  // Cache lookup. Key includes name + domain so the same client gets a
  // single entry; promptVersion / model bust the cache when either
  // changes.
  const cacheKey = deriveCacheKey({
    promptVersion: PROMPT_VERSION,
    model: deps.model,
    feature: 'client-research',
    inputs: `${args.clientName.toLowerCase().trim()}|${args.domain.toLowerCase().trim()}`,
  });

  if (deps.cache) {
    try {
      const cached = await deps.cache.get<ClientResearchResult>(cacheKey);
      if (cached) return cached.value;
    } catch (err) {
      logger.warn('proposal-ai client research: cache read failed, continuing', err);
    }
  }

  // Step 1: Serper queries.
  const searchFn = deps.serperSearch ?? defaultSerperSearch(deps.serperApiKey);
  const queries = [
    `"${args.clientName}" revenue OR employees OR annual sales`,
    `"${args.clientName}" industry "${args.domain}"`,
    `"${args.clientName}" about OR services OR team`,
  ];
  const searchHits: Array<{ url: string; query_type: string; snippet: string }> = [];
  for (const q of queries) {
    try {
      const hits = await searchFn(q, 5);
      for (const h of hits) {
        searchHits.push({ url: h.url, query_type: 'research', snippet: h.snippet });
      }
    } catch (err) {
      logger.warn(`proposal-ai research Serper query failed: ${q}`, err);
    }
  }

  // De-dup URLs.
  const seen = new Set<string>();
  const dedup = searchHits.filter(h => {
    const key = h.url.split('?')[0].toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 12); // cap fetch budget

  // Step 2: scrape.
  const scrapeFn = deps.scrape ?? scrapeAll;
  const scraped = await scrapeFn(dedup.map(h => ({ url: h.url, query_type: h.query_type, fallback_snippet: h.snippet })));

  // Step 3: sitemap fetch for the primary domain.
  const sitemapFn = deps.sitemapFetch ?? fetchSitemapUrlCount;
  const sitemap = await sitemapFn(args.domain);

  // Step 4: Gemini synthesis.
  const promptInput: UserPromptInput = {
    client_name: args.clientName,
    domain: args.domain,
    sitemap_url_count: sitemap.url_count,
    sitemap_source: sitemap.source,
    scraped_excerpts: scraped.map(s => ({ url: s.url, text: s.full_text || s.snippet || '' })),
  };
  const userPrompt = buildUserPrompt(promptInput);

  const { text } = await deps.gemini.generateJson({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    temperature: 0.3,
    responseSchema: RESPONSE_SCHEMA,
  });
  const parsed = stripFencesAndParse<unknown>(text, 'Client research');
  const validated = validateClientResearch(parsed);

  // Step 5: cache write. Cache failures do not block the return.
  if (deps.cache) {
    try {
      await deps.cache.set(cacheKey, validated, ttlDays, 'client-research');
    } catch (err) {
      logger.warn('proposal-ai client research: cache write failed, continuing', err);
    }
  }

  return validated;
}

// =========================================================================
// Validation
// =========================================================================

export function validateClientResearch(raw: unknown): ClientResearchResult {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Client research response is not an object');
  }
  const o = raw as Record<string, unknown>;

  const revenue = strField(o.estimated_revenue_band, 'estimated_revenue_band');
  if (!VALID_REVENUE.has(revenue as RevenueBand)) {
    throw new Error(`Invalid estimated_revenue_band: ${revenue}`);
  }
  const revConf = strField(o.revenue_confidence, 'revenue_confidence');
  if (!VALID_CONFIDENCE.has(revConf as ConfidenceLevel)) {
    throw new Error(`Invalid revenue_confidence: ${revConf}`);
  }
  const industry = strField(o.inferred_industry, 'inferred_industry');
  if (!VALID_INDUSTRY.has(industry as IndustryGuess)) {
    throw new Error(`Invalid inferred_industry: ${industry}`);
  }
  const urgency = strField(o.inferred_urgency, 'inferred_urgency');
  if (!VALID_URGENCY.has(urgency as UrgencyGuess)) {
    throw new Error(`Invalid inferred_urgency: ${urgency}`);
  }

  if (!Array.isArray(o.inferred_focus)) {
    throw new Error('inferred_focus must be an array');
  }
  const focus: FocusTag[] = [];
  for (const f of o.inferred_focus) {
    if (typeof f === 'string' && VALID_FOCUS.has(f as FocusTag)) {
      focus.push(f as FocusTag);
    }
  }

  if (!Array.isArray(o.domains_found)) {
    throw new Error('domains_found must be an array');
  }
  const domains: DomainGuess[] = [];
  for (const d of o.domains_found) {
    if (!d || typeof d !== 'object') continue;
    const obj = d as Record<string, unknown>;
    const domain = typeof obj.domain === 'string' ? obj.domain.trim() : '';
    const role_guess = typeof obj.role_guess === 'string' ? obj.role_guess : 'other';
    const confidence = typeof obj.confidence === 'string' && VALID_CONFIDENCE.has(obj.confidence as ConfidenceLevel)
      ? obj.confidence as ConfidenceLevel
      : 'low';
    if (domain) {
      domains.push({ domain, role_guess, confidence });
    }
  }

  let pageCount: number | null = null;
  if (typeof o.estimated_page_count === 'number' && Number.isFinite(o.estimated_page_count) && o.estimated_page_count > 0) {
    pageCount = Math.round(o.estimated_page_count);
  } else if (o.estimated_page_count !== null && o.estimated_page_count !== undefined) {
    // Model returned non-numeric; coerce to null.
    pageCount = null;
  }

  return {
    estimated_revenue_band: revenue as RevenueBand,
    revenue_evidence: strField(o.revenue_evidence, 'revenue_evidence'),
    revenue_confidence: revConf as ConfidenceLevel,

    inferred_industry: industry as IndustryGuess,
    industry_evidence: strField(o.industry_evidence, 'industry_evidence'),

    inferred_urgency: urgency as UrgencyGuess,
    urgency_evidence: strField(o.urgency_evidence, 'urgency_evidence'),

    inferred_focus: focus,

    domains_found: domains,
    estimated_page_count: pageCount,
    page_count_source: strField(o.page_count_source, 'page_count_source'),

    notes: strField(o.notes, 'notes'),
  };
}

function strField(v: unknown, name: string): string {
  if (typeof v !== 'string') throw new Error(`${name} must be a string`);
  return v;
}

// =========================================================================
// Default Serper search wrapper
// =========================================================================

function defaultSerperSearch(apiKey: string): SerperSearchFn {
  if (!apiKey) {
    return async () => [];
  }
  return async (query, num) => {
    try {
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, num }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return [];
      const data: any = await res.json();
      const organic = Array.isArray(data?.organic) ? data.organic : [];
      return organic.map((h: any) => ({
        url: h.link || '',
        title: h.title || '',
        snippet: h.snippet || '',
      })).filter((h: any) => h.url);
    } catch {
      return [];
    }
  };
}
