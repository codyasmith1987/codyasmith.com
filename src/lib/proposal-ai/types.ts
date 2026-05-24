// Shared types for the Gemini-assisted proposal builder.
//
// One file per feature lives under src/lib/proposal-ai/, each
// orchestrating Serper + scrape + Gemini for a specific suggestion.
// All features share the wrapper, cache, voice lint, and these types.

// =========================================================================
// Gemini client wrapper (matches the naming/sentiment pattern)
// =========================================================================

export interface ProposalGeminiClient {
  generateJson(opts: {
    systemPrompt: string;
    userPrompt: string;
    temperature: number;
    responseSchema?: any;
  }): Promise<{ text: string }>;
}

// =========================================================================
// Cache abstraction
// =========================================================================

export interface ProposalCacheEntry<T> {
  value: T;
  expiresAt: string;
}

export interface ProposalCacheClient {
  get<T = unknown>(key: string): Promise<ProposalCacheEntry<T> | null>;
  set<T = unknown>(key: string, value: T, ttlDays: number, feature: string): Promise<void>;
}

// =========================================================================
// Client research response shape
// =========================================================================

export type RevenueBand = 'under-1m' | '1m-to-10m' | 'over-10m' | 'unknown';
export type ConfidenceLevel = 'low' | 'medium' | 'high';
// Industry buckets calibrated to Cody's actual ICP per
// 04-CONSOLIDATED-LESSONS-MASTER + 05-BUSINESS-RULES-AND-STRUCTURE:
// modular/prefab construction (ZipKit, MVP), construction-adjacent
// trades (Builders under Raised Bar), professional services, family
// of companies (Raised Bar's group structure). "ecommerce" stays
// removed (no ecommerce in his book). "manufacturing" was a stretch
// for a single test fixture (MCM, switchgear); the real ICP is not
// heavy industrial manufacturing, so the bucket is removed too.
// Construction / trades fit under "contractor."
export type IndustryGuess =
  | 'solo'
  | 'professional-services'
  | 'contractor'
  | 'family-of-companies'
  | 'nonprofit'
  | 'other'
  | 'unknown';
export type UrgencyGuess = 'tactical' | 'growth' | 'maintenance' | 'unknown';
// 'hiring' was intentionally removed: it is a future Marketing
// Consulting operations-domain add-on (see ClickUp 86ba34x8k), not a
// standalone narrative focus.
//
// 'revenue' was also removed: it conflicts with the no-overclaim
// rule on WM copy (the voice lint catches "revenue growth" /
// "drive revenue" downstream anyway, but pre-loading the AI with
// "revenue" as a valid focus tag invites copy that lint then rejects).
// Re-add only when ecosystem routing is fully built AND there is a
// product slice that legitimately promises revenue movement.
export type FocusTag =
  | 'brand'
  | 'takeover'
  | 'search'
  | 'pre-sell';

export interface DomainGuess {
  domain: string;
  role_guess: string;     // 'primary' | 'micro-site' | 'subsidiary' | 'other'
  confidence: ConfidenceLevel;
}

export type CmsGuess =
  | 'wordpress'
  | 'squarespace'
  | 'wix'
  | 'shopify'
  | 'webflow'
  | 'duda'
  | 'godaddy-builder'
  | 'custom'
  | 'unknown';

export interface ClientResearchResult {
  estimated_revenue_band: RevenueBand;
  revenue_evidence: string;
  revenue_confidence: ConfidenceLevel;

  inferred_industry: IndustryGuess;
  industry_evidence: string;

  inferred_urgency: UrgencyGuess;
  urgency_evidence: string;

  inferred_focus: FocusTag[];

  // CMS detected from the scraped homepage HTML. WordPress is the
  // most common in Cody's ICP; the others are real possibilities for
  // prospects coming from less technical builders. Drives the
  // build vs takeover recommendation.
  detected_cms: CmsGuess;
  cms_evidence: string;

  domains_found: DomainGuess[];
  estimated_page_count: number | null;
  page_count_source: string;

  notes: string;
}

// =========================================================================
// Voice-lint result
// =========================================================================

export interface VoiceLintResult {
  ok: boolean;
  violations: Array<{ rule: string; matched: string }>;
}
