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
  CmsGuess,
  DomainGuess,
  CodyProductId,
  TierLevel,
  ProductMixRecommendation,
  TierRecommendation,
  ClvHorizon,
  ClvHorizonSignal,
  TimeIntensityLevel,
  CodyTimeIntensitySignal,
  SalesAngle,
  InternalGap,
  InternalGapSeverity,
  RiskSeverity,
  RiskSignal,
} from '../types';

const VALID_REVENUE: ReadonlySet<RevenueBand> = new Set(['under-1m', '1m-to-10m', 'over-10m', 'unknown']);
const VALID_CONFIDENCE: ReadonlySet<ConfidenceLevel> = new Set(['low', 'medium', 'high']);
const VALID_INDUSTRY: ReadonlySet<IndustryGuess> = new Set([
  'solo', 'professional-services', 'contractor',
  'family-of-companies', 'nonprofit', 'other', 'unknown',
]);
const VALID_URGENCY: ReadonlySet<UrgencyGuess> = new Set(['tactical', 'growth', 'maintenance', 'unknown']);
const VALID_FOCUS: ReadonlySet<FocusTag> = new Set([
  'brand', 'takeover', 'search', 'pre-sell',
]);
const VALID_CMS: ReadonlySet<CmsGuess> = new Set([
  'wordpress', 'squarespace', 'wix', 'shopify', 'webflow',
  'duda', 'godaddy-builder', 'custom', 'unknown',
]);
const VALID_PRODUCT_IDS: ReadonlySet<CodyProductId> = new Set([
  'web_management', 'marketing_consulting', 'build', 'training',
]);
const VALID_TIER: ReadonlySet<TierLevel> = new Set(['good', 'better', 'best']);
const VALID_CLV: ReadonlySet<ClvHorizon> = new Set([
  'long-term-stable', 'medium-term', 'churn-risk', 'unknown',
]);
const VALID_INTENSITY: ReadonlySet<TimeIntensityLevel> = new Set(['low', 'medium', 'high']);
const VALID_SEVERITY: ReadonlySet<RiskSeverity> = new Set(['low', 'medium', 'high']);

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

  // Step 1: brand discovery. Domain-anchored queries alone miss
  // entities whose Google footprint is indexed against the brand
  // name (e.g., site at mcmeng2.com, brand "MCM Engineering II", real
  // revenue records on RocketReach / ZoomInfo / PitchBook). The fix
  // is a two-phase Serper run:
  //
  //   Phase 1: site:${domain} returns Google's title for the site,
  //            which almost always contains the brand. Extract brand
  //            candidates from those titles.
  //   Phase 2: brand-anchored queries ("BRAND" revenue, "BRAND"
  //            industry). These are where the real public-record
  //            data actually lives.
  //
  // Domain-anchored queries remain as a fallback so weakly-known
  // brands still have a chance.
  const searchFn = deps.serperSearch ?? defaultSerperSearch(deps.serperApiKey);
  const searchHits: Array<{ url: string; query_type: string; snippet: string }> = [];
  const brandCandidates: string[] = [];

  // Phase 1: site: query for brand discovery.
  try {
    const siteHits = await searchFn(`site:${args.domain}`, 5);
    for (const h of siteHits) {
      searchHits.push({ url: h.url, query_type: 'site', snippet: h.snippet });
      const brand = extractBrandFromTitle(h.title || '', args.domain);
      if (brand && !brandCandidates.includes(brand)) brandCandidates.push(brand);
    }
  } catch (err) {
    logger.warn('proposal-ai research site: query failed', err);
  }

  // Add the database client name as a brand candidate when it looks
  // like a real entity (not a test placeholder).
  const looksLikeRealName = args.clientName
    && !/^(test|cody[\s_-]?test|sample|fixture|demo)/i.test(args.clientName.trim())
    && args.clientName.trim().length > 4;
  if (looksLikeRealName && !brandCandidates.includes(args.clientName.trim())) {
    brandCandidates.push(args.clientName.trim());
  }

  // Phase 2: brand-anchored queries for each candidate (cap at 2 to
  // keep the Serper budget reasonable).
  const brandsToQuery = brandCandidates.slice(0, 2);
  for (const brand of brandsToQuery) {
    const escaped = brand.replace(/"/g, '');
    const brandQueries: Array<{ q: string; tag: string }> = [
      { q: `"${escaped}" revenue OR employees OR annual sales OR funding`, tag: 'revenue' },
      { q: `"${escaped}" industry OR services OR team OR about`, tag: 'industry' },
    ];
    for (const { q, tag } of brandQueries) {
      try {
        const hits = await searchFn(q, 5);
        for (const h of hits) {
          searchHits.push({ url: h.url, query_type: tag, snippet: h.snippet });
        }
      } catch (err) {
        logger.warn(`proposal-ai research brand query failed: ${q}`, err);
      }
    }
  }

  // Domain-anchored fallback. Runs in addition to brand queries
  // because some brand-anchored searches return nothing for newer
  // or smaller entities.
  const domainFallback: Array<{ q: string; tag: string }> = [
    { q: `"${args.domain}" revenue OR employees OR annual sales OR funding`, tag: 'revenue-domain' },
  ];
  for (const { q, tag } of domainFallback) {
    try {
      const hits = await searchFn(q, 5);
      for (const h of hits) {
        searchHits.push({ url: h.url, query_type: tag, snippet: h.snippet });
      }
    } catch (err) {
      logger.warn(`proposal-ai research domain query failed: ${q}`, err);
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

  // Step 2a: always fetch the site's homepage directly. Even if no
  // Serper query returned it, scraping the homepage gives Gemini the
  // most authoritative source for the brand name, what the company
  // actually does, and which other domains the site links to as
  // owned properties (parent corp, subsidiaries). This is the single
  // most useful page in the whole research call.
  const homepageUrl = `https://${args.domain}/`;
  const hasHomepage = dedup.some(h => {
    try { return new URL(h.url).hostname.replace(/^www\./, '') === args.domain; }
    catch { return false; }
  });
  const toScrape = hasHomepage
    ? dedup
    : [{ url: homepageUrl, query_type: 'homepage', snippet: '' }, ...dedup];

  // Step 2b: scrape.
  const scrapeFn = deps.scrape ?? scrapeAll;
  const scraped = await scrapeFn(toScrape.map(h => ({ url: h.url, query_type: h.query_type, fallback_snippet: h.snippet })));

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
    brand_candidates: brandsToQuery,
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
// Brand discovery
// =========================================================================

// Extract a brand candidate from a Serper result title. Google's title
// for a site: query is the homepage title from the actual site, which
// almost always contains the business name. Common separators are
// pipe, dash, en-dash, em-dash, colon. Reject generic page names and
// the bare domain. Prefer the longest non-generic candidate.
export function extractBrandFromTitle(title: string, domain: string): string | null {
  if (!title) return null;
  const parts = title.split(/\s*[|\-–—:]+\s*/);
  const candidates: string[] = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    if (part.length < 3 || part.length > 80) continue;
    const lower = part.toLowerCase();
    const domainLower = domain.toLowerCase();
    // Reject only the exact-match domain. Stem matches ("Acme" vs
    // "acme.com") would over-reject real brands that happen to share
    // the domain stem; let those through.
    if (lower === domainLower) continue;
    if (/^(home|about|contact|services|products|welcome|page|home page|index|landing|main)$/i.test(part)) continue;
    const stripped = part.replace(/^welcome\s+to\s+/i, '').trim();
    if (stripped.length >= 3) candidates.push(stripped);
  }
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0] || null;
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
  // Hosting-platform suffixes that are NEVER a separate site. If the
  // model returns one of these, it's a deployment artifact of the
  // primary site (WP Engine staging, Netlify preview, Vercel preview,
  // etc.). Drop them silently — they should never surface as a domain
  // the client owns. Audit 2026-05-25.
  const HOSTING_PLATFORM_SUFFIXES = [
    '.wpenginepowered.com',
    '.netlify.app',
    '.vercel.app',
    '.pages.dev',
    '.fly.dev',
    '.herokuapp.com',
    '.azurewebsites.net',
    '.github.io',
    '.cloudfront.net',
    '.amazonaws.com',
    '.web.app',                // Firebase Hosting
    '.firebaseapp.com',
  ];
  const VALID_ROLES = new Set([
    'primary',
    'possibly-related',
    'same-business-alt-domain',
    'staging-of-primary',
    'other',
  ]);
  const domains: DomainGuess[] = [];
  for (const d of o.domains_found) {
    if (!d || typeof d !== 'object') continue;
    const obj = d as Record<string, unknown>;
    const domain = typeof obj.domain === 'string' ? obj.domain.trim().toLowerCase() : '';
    if (!domain) continue;
    // Filter hosting-platform suffixes regardless of what the model
    // said about them.
    const isHostingPlatform = HOSTING_PLATFORM_SUFFIXES.some(suffix =>
      domain.endsWith(suffix) || domain === suffix.replace(/^\./, '')
    );
    if (isHostingPlatform) continue;
    // Validate role_guess against the tightened vocabulary; fall back
    // to 'other' rather than letting the model invent labels.
    const rawRole = typeof obj.role_guess === 'string' ? obj.role_guess : 'other';
    const role_guess = (VALID_ROLES.has(rawRole) ? rawRole : 'other') as DomainGuess['role_guess'];
    const confidence = typeof obj.confidence === 'string' && VALID_CONFIDENCE.has(obj.confidence as ConfidenceLevel)
      ? obj.confidence as ConfidenceLevel
      : 'low';
    const evidence = typeof obj.evidence === 'string' ? obj.evidence.trim() : '';
    // High-confidence entries without evidence are demoted to low.
    // We're not going to bless a strong claim that has nothing to back
    // it up; admin should see the demotion as a signal to confirm
    // manually.
    const effectiveConfidence: ConfidenceLevel = (confidence === 'high' && evidence.length === 0)
      ? 'low'
      : confidence;
    domains.push({ domain, role_guess, confidence: effectiveConfidence, evidence });
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

    detected_cms: (typeof o.detected_cms === 'string' && VALID_CMS.has(o.detected_cms as CmsGuess))
      ? (o.detected_cms as CmsGuess)
      : 'unknown',
    cms_evidence: typeof o.cms_evidence === 'string' ? o.cms_evidence : '',

    domains_found: domains,
    estimated_page_count: pageCount,
    page_count_source: strField(o.page_count_source, 'page_count_source'),

    recommended_product_mix: validateProductMix(o.recommended_product_mix),
    recommended_tier_per_product: validateTierMap(o.recommended_tier_per_product),
    clv_horizon: validateClvHorizon(o.clv_horizon),
    cody_time_intensity: validateTimeIntensity(o.cody_time_intensity),
    sales_angles: validateSalesAngles(o.sales_angles),
    internal_gaps: validateInternalGaps(o.internal_gaps),
    risk_signals: validateRiskSignals(o.risk_signals),

    notes: strField(o.notes, 'notes'),
  };
}

function strField(v: unknown, name: string): string {
  if (typeof v !== 'string') throw new Error(`${name} must be a string`);
  return v;
}

// -------------------------------------------------------------------------
// Engagement-strategy field validators
// -------------------------------------------------------------------------
// Each is permissive on shape (returns safe defaults) but strict on enum
// values. The wizard renders the strategy panel from these structures.

function validateProductMix(raw: unknown): Record<CodyProductId, ProductMixRecommendation> {
  const empty: ProductMixRecommendation = { recommended: false, rationale: '', confidence: 'low' };
  const out: Record<CodyProductId, ProductMixRecommendation> = {
    web_management: { ...empty },
    marketing_consulting: { ...empty },
    build: { ...empty },
    training: { ...empty },
  };
  if (!raw || typeof raw !== 'object') return out;
  const o = raw as Record<string, unknown>;
  for (const id of VALID_PRODUCT_IDS) {
    const slot = o[id];
    if (!slot || typeof slot !== 'object') continue;
    const s = slot as Record<string, unknown>;
    out[id] = {
      recommended: s.recommended === true,
      rationale: typeof s.rationale === 'string' ? s.rationale : '',
      confidence: typeof s.confidence === 'string' && VALID_CONFIDENCE.has(s.confidence as ConfidenceLevel)
        ? (s.confidence as ConfidenceLevel)
        : 'low',
    };
  }
  return out;
}

function validateTierMap(raw: unknown): Partial<Record<CodyProductId, TierRecommendation>> {
  const out: Partial<Record<CodyProductId, TierRecommendation>> = {};
  if (!raw || typeof raw !== 'object') return out;
  const o = raw as Record<string, unknown>;
  for (const id of VALID_PRODUCT_IDS) {
    const slot = o[id];
    if (!slot || typeof slot !== 'object') continue;
    const s = slot as Record<string, unknown>;
    if (typeof s.tier !== 'string' || !VALID_TIER.has(s.tier as TierLevel)) continue;
    out[id] = {
      tier: s.tier as TierLevel,
      rationale: typeof s.rationale === 'string' ? s.rationale : '',
    };
  }
  return out;
}

function validateClvHorizon(raw: unknown): ClvHorizonSignal {
  if (!raw || typeof raw !== 'object') return { signal: 'unknown', rationale: '' };
  const o = raw as Record<string, unknown>;
  const signal = typeof o.signal === 'string' && VALID_CLV.has(o.signal as ClvHorizon)
    ? (o.signal as ClvHorizon)
    : 'unknown';
  const rationale = typeof o.rationale === 'string' ? o.rationale : '';
  return { signal, rationale };
}

function validateTimeIntensity(raw: unknown): CodyTimeIntensitySignal {
  if (!raw || typeof raw !== 'object') return { level: 'medium', rationale: '' };
  const o = raw as Record<string, unknown>;
  const level = typeof o.level === 'string' && VALID_INTENSITY.has(o.level as TimeIntensityLevel)
    ? (o.level as TimeIntensityLevel)
    : 'medium';
  const rationale = typeof o.rationale === 'string' ? o.rationale : '';
  return { level, rationale };
}

function validateSalesAngles(raw: unknown): SalesAngle[] {
  if (!Array.isArray(raw)) return [];
  const VALID_IMPL = new Set([
    'web_management', 'marketing_consulting', 'build', 'training', 'none',
  ]);
  const out: SalesAngle[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const angle = typeof o.angle === 'string' ? o.angle.trim() : '';
    const evidence = typeof o.supporting_evidence === 'string' ? o.supporting_evidence.trim() : '';
    // Drop angles without evidence per the no-fabrication rule.
    if (!angle || !evidence) continue;
    const impl = typeof o.product_implication === 'string' && VALID_IMPL.has(o.product_implication)
      ? (o.product_implication as SalesAngle['product_implication'])
      : undefined;
    out.push({ angle, supporting_evidence: evidence, product_implication: impl });
  }
  return out;
}

function validateInternalGaps(raw: unknown): InternalGap[] {
  if (!Array.isArray(raw)) return [];
  const VALID_GAP_IMPL = new Set([
    'web_management', 'marketing_consulting', 'build', 'training', 'none',
  ]);
  const VALID_GAP_SEV: ReadonlySet<InternalGapSeverity> = new Set(['low', 'medium', 'high']);
  const out: InternalGap[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const gap = typeof o.gap === 'string' ? o.gap.trim() : '';
    const evidence = typeof o.evidence === 'string' ? o.evidence.trim() : '';
    // No-fabrication rule: drop gaps without evidence.
    if (!gap || !evidence) continue;
    const severity = typeof o.severity === 'string' && VALID_GAP_SEV.has(o.severity as InternalGapSeverity)
      ? (o.severity as InternalGapSeverity)
      : 'medium';
    const impl = typeof o.product_implication === 'string' && VALID_GAP_IMPL.has(o.product_implication)
      ? (o.product_implication as InternalGap['product_implication'])
      : undefined;
    out.push({ gap, evidence, severity, product_implication: impl });
  }
  return out;
}

function validateRiskSignals(raw: unknown): RiskSignal[] {
  if (!Array.isArray(raw)) return [];
  const out: RiskSignal[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const risk = typeof o.risk === 'string' ? o.risk.trim() : '';
    if (!risk) continue;
    const severity = typeof o.severity === 'string' && VALID_SEVERITY.has(o.severity as RiskSeverity)
      ? (o.severity as RiskSeverity)
      : 'medium';
    out.push({ risk, severity });
  }
  return out;
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
