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

// =========================================================================
// Engagement-strategy synthesis fields
// =========================================================================
//
// The research call is a sales tool. It gathers raw signals from public
// info and scrape data, then synthesizes them into an engagement-strategy
// briefing for Cody: which products to pitch, which tier per product,
// likely CLV horizon, expected hands-on time, sales angles to lead with,
// risks to watch.
//
// All of these are ADMIN-FACING. The "no dangling tier references" rule
// (feedback_no_dangling_tier_references) keeps tier names out of client-
// facing copy while ecosystem routing is unbuilt. The wizard renders the
// strategy as an admin briefing; the client never sees these fields.

export type CodyProductId =
  | 'web_management'
  | 'marketing_consulting'
  | 'build'
  | 'training';

export type TierLevel = 'good' | 'better' | 'best';

export interface ProductMixRecommendation {
  recommended: boolean;
  rationale: string;
  confidence: ConfidenceLevel;
}

export interface TierRecommendation {
  tier: TierLevel;
  rationale: string;
}

export type ClvHorizon = 'long-term-stable' | 'medium-term' | 'churn-risk' | 'unknown';

export interface ClvHorizonSignal {
  signal: ClvHorizon;
  rationale: string;
}

export type TimeIntensityLevel = 'low' | 'medium' | 'high';

export interface CodyTimeIntensitySignal {
  level: TimeIntensityLevel;
  rationale: string;
}

export interface SalesAngle {
  angle: string;                          // one short phrase to lead with
  supporting_evidence: string;             // quote or paraphrase from scraped content
}

// Concrete things broken or under-served on the prospect's site or
// in their stated story. Drives the strategy panel's product-mix
// recommendation (these are what Cody can FIX) and the onboarding
// month-one focus. Distinct from sales_angles (which is what the
// prospect tells THEIR customers); internal_gaps is what they
// haven't said out loud but the data reveals.
//
// Per audit finding 2 (docs/audits/proposal-chain-audit-2026-05-24.md).
export type InternalGapSeverity = 'low' | 'medium' | 'high';
export interface InternalGap {
  gap: string;                            // one short phrase, e.g., "Site title still 2022 copyright"
  evidence: string;                       // scraped-content quote or paraphrase
  severity: InternalGapSeverity;
  product_implication?: 'web_management' | 'marketing_consulting' | 'build' | 'training' | 'none';
}

export type RiskSeverity = 'low' | 'medium' | 'high';

export interface RiskSignal {
  risk: string;
  severity: RiskSeverity;
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

  // CMS detected from the scraped homepage HTML. WordPress is the
  // most common in Cody's ICP; the others are real possibilities for
  // prospects coming from less technical builders. Drives the
  // build vs takeover recommendation.
  detected_cms: CmsGuess;
  cms_evidence: string;

  domains_found: DomainGuess[];
  estimated_page_count: number | null;
  page_count_source: string;

  // -----------------------------------------------------------------
  // Engagement-strategy synthesis. Admin-facing only.
  // -----------------------------------------------------------------

  // Which products to pitch. Each product gets a yes/no with rationale
  // and confidence so the admin can sanity-check the call.
  recommended_product_mix: Record<CodyProductId, ProductMixRecommendation>;

  // Tier per product the mix recommended. Products not in the mix
  // are absent from this map.
  recommended_tier_per_product: Partial<Record<CodyProductId, TierRecommendation>>;

  // Likely engagement-length signal. Drives whether to invest in
  // structural improvements (long-term) or quick wins (churn-risk).
  clv_horizon: ClvHorizonSignal;

  // Expected ongoing hands-on time per cycle. Low = mostly advisory.
  // High = heavy execution, multi-site, low decision velocity.
  cody_time_intensity: CodyTimeIntensitySignal;

  // Three to five sales angles, each backed by scraped-content evidence.
  // These are what the prospect tells their customers (their pitch).
  // Used in the proposal opener to echo their language back.
  sales_angles: SalesAngle[];

  // Two to five internal gaps -- things broken or under-served that
  // Cody can fix. Distinct from sales_angles. Each is concrete:
  // "site title still says 2022," "no analytics installed," "magazine
  // feature buried in the file directory." Each has a product_implication
  // tying it to one of Cody's products so the admin sees which gap maps
  // to which product. Per finding 2.
  internal_gaps: InternalGap[];

  // Sponsor-style risks, organizational gaps, decision-velocity warnings.
  risk_signals: RiskSignal[];

  notes: string;
}

// =========================================================================
// Voice-lint result
// =========================================================================

export interface VoiceLintResult {
  ok: boolean;
  violations: Array<{ rule: string; matched: string }>;
}
