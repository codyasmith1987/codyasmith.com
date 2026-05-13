// Engine defaults. Phase 3 numbers reflect the broad-generate, aggressive-narrow
// pipeline established by the methodology synthesis: 200 candidates per call,
// 50 per typology, scored to top-25 visible in the slider, top-5 personalized
// post-quiz for the dashboard email.

export const DEFAULTS = {
  PROMPT_VERSION: 'v5',
  MODEL: 'gemini-2.5-flash-lite',
  CACHE_TTL_DAYS: 7,
  RDAP_CONCURRENCY: 20,
  RDAP_RATE_LIMIT_PER_SECOND: 10,
  RDAP_BOOTSTRAP_URL: 'https://data.iana.org/rdap/dns.json',
  TLDS_PREVIEW: ['com'],
  TLDS_FULL: ['com', 'net', 'co', 'io', 'ai', 'org'],
  TOTAL_CANDIDATES: 100,
  CANDIDATES_PER_TYPOLOGY: 25,
  // Floor rules. Validator enforces floors, not equality, so a successful
  // call can ship as long as it clears the per-typology and total floors.
  MIN_TOTAL_CANDIDATES: 75,
  MIN_PER_TYPOLOGY: 15,
  // Phase 3 Path C: four parallel calls, one per typology. Each call asks
  // for ~25 candidates and the per-call validator floors at 15.
  TARGET_PER_CALL: 25,
  MAX_PER_CALL: 30,
  TOP_K_FOR_SLIDER: 25,
  TOP_K_FOR_DASHBOARD: 5,
  RATIONALE_MIN_LENGTH: 30,
  RATIONALE_MAX_LENGTH: 240,
  NAME_MIN_LENGTH: 4,
  NAME_MAX_LENGTH: 15,
  SHARED_AFFIX_LENGTH: 4,
  SECONDARY_MARKET_CAP_USD: 10000,
  // Legacy Phase 1 constants retained for backward compatibility with old tests.
  PARENTS_PER_GENERATION: 10,
  VARIANTS_PER_PARENT: 10,
} as const;

// Tier 2 scoring weights. Tunable. Methodology-anchored: pronounceability and
// tonality-fit carry the highest weight per Task 1's processing-fluency
// finding and Task 2's tonality-axis convention.
export const SCORING_WEIGHTS = {
  pronounceability: 1.0,
  memorability: 0.8,
  length: 0.6,
  tonality_fit: 1.0,
  trademark: 0.4,
  domain_feasibility: 0.8,
} as const;

// Trademark proxy by typology. Abercrombie spectrum on a 0-10 scale.
export const TRADEMARK_BY_TYPOLOGY: Record<string, number> = {
  abstract: 10,
  associative: 7,
  suggestive: 5,
  descriptive: 3,
};

// Legacy: Phase 1/2 callers still pass a creativity parameter. Phase 3 ignores
// creativity in generation; the scorer uses the user's tonality vector
// against each candidate's vector instead.
export function temperatureForCreativity(creativity: number): number {
  const c = Math.min(10, Math.max(1, Math.round(creativity || 5)));
  if (c <= 5) return 0.3 + ((c - 1) * 0.4) / 4;
  return 0.7 + ((c - 5) * 0.3) / 5;
}

// Legacy export retained so old test imports do not break at parse time.
export const SCORING_WEIGHTS_PHASE3_PLACEHOLDER = SCORING_WEIGHTS;
