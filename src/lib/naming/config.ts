// Engine defaults. Override via dependency injection in tests.

export const DEFAULTS = {
  PROMPT_VERSION: 'v1',
  MODEL: 'gemini-2.5-flash-lite',
  CACHE_TTL_DAYS: 7,
  RDAP_CONCURRENCY: 20,
  RDAP_RATE_LIMIT_PER_SECOND: 10,
  RDAP_BOOTSTRAP_URL: 'https://data.iana.org/rdap/dns.json',
  TLDS_PREVIEW: ['com'],
  TLDS_FULL: ['com', 'net', 'co', 'io', 'ai', 'org'],
  PARENTS_PER_GENERATION: 10,
  VARIANTS_PER_PARENT: 10,
} as const;

// Maps creativity dial (1 to 10) to Gemini temperature.
// Anchor points per spec: 1 -> 0.3, 5 -> 0.7, 10 -> 1.0.
export function temperatureForCreativity(creativity: number): number {
  const c = Math.min(10, Math.max(1, Math.round(creativity)));
  if (c <= 5) {
    // Linear from (1, 0.3) to (5, 0.7)
    return 0.3 + ((c - 1) * 0.4) / 4;
  }
  // Linear from (5, 0.7) to (10, 1.0)
  return 0.7 + ((c - 5) * 0.3) / 5;
}

// Phase 1 simple-ranker has no scoring weights. Phase 3 fills these.
export const SCORING_WEIGHTS_PHASE3_PLACEHOLDER = {} as const;
