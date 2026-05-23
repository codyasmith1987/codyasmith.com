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
export type IndustryGuess =
  | 'solo'
  | 'professional-services'
  | 'contractor'
  | 'ecommerce'
  | 'family-of-companies'
  | 'nonprofit'
  | 'other'
  | 'unknown';
export type UrgencyGuess = 'tactical' | 'growth' | 'maintenance' | 'unknown';
export type FocusTag =
  | 'revenue'
  | 'brand'
  | 'takeover'
  | 'search'
  | 'pre-sell'
  | 'hiring';

export interface DomainGuess {
  domain: string;
  role_guess: string;     // 'primary' | 'micro-site' | 'subsidiary' | 'other'
  confidence: ConfidenceLevel;
}

export interface ClientResearchResult {
  estimated_revenue_band: RevenueBand;
  revenue_evidence: string;
  revenue_confidence: ConfidenceLevel;

  inferred_industry: IndustryGuess;
  industry_evidence: string;

  inferred_urgency: UrgencyGuess;
  urgency_evidence: string;

  inferred_focus: FocusTag[];

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
