// Shared types for the naming pipeline engine.
// Phase 3 shape: 200 candidates per generation, 50 per typological position,
// each with its own tonality vector. The Phase 1 parents-and-variants shape
// is gone; the broad-generate, aggressive-narrow pipeline replaces it.

export type Typology = 'descriptive' | 'suggestive' | 'associative' | 'abstract';

export const TYPOLOGY_LIST: readonly Typology[] = [
  'descriptive',
  'suggestive',
  'associative',
  'abstract',
] as const;

export interface TonalityVector {
  serious_playful: number;       // 1-5: 1 = serious, 5 = playful
  modern_classical: number;      // 1-5: 1 = modern, 5 = classical
  descriptive_abstract: number;  // 1-5: 1 = descriptive, 5 = abstract
  technical_emotional: number;   // 1-5: 1 = technical, 5 = emotional
  conservative_bold: number;     // 1-5: 1 = conservative, 5 = bold
}

export type TonalityAxis = keyof TonalityVector;

export const TONALITY_AXES: readonly TonalityAxis[] = [
  'serious_playful',
  'modern_classical',
  'descriptive_abstract',
  'technical_emotional',
  'conservative_bold',
] as const;

export const DEFAULT_TONALITY: TonalityVector = {
  serious_playful: 3,
  modern_classical: 3,
  descriptive_abstract: 3,
  technical_emotional: 3,
  conservative_bold: 3,
};

export interface NameCandidate {
  name: string;
  typology: Typology;
  rationale: string;
  tonality: TonalityVector;
}

export interface GenerateResult {
  candidates: NameCandidate[]; // exactly 200, 50 per typology
}

export interface GenerateOptions {
  seed: string;
  promptVersion?: string;
  cache?: boolean;
}

export interface AvailabilityResult {
  name: string;
  tld: string;
  available: boolean | null;
  checkedAt: string;
}

export interface DomainStatus {
  available: boolean | null;       // true = .com available; false = owned; null = unknown
  secondaryPriceUsd: number | null; // null when not surfaced or unknown
}

export interface ScoreBreakdown {
  pronounceability: number;
  memorability: number;
  length: number;
  tonality_fit: number;
  trademark: number;
  domain_feasibility: number;
}

export interface ScoredCandidate {
  candidate: NameCandidate;
  score: number;
  breakdown: ScoreBreakdown;
  domain: DomainStatus;
  excluded?: 'no_domain_path' | 'price_over_cap';
}

export type RunSource = 'preview' | 'report';

export interface InsertRunOptions {
  seedTerm: string;
  creativity: number; // legacy field, kept for schema compat; default 5
  tlds: string[];
  source: RunSource;
  leadId?: number | null;
  configSnapshot?: string | null;
}

export interface CacheEntry<T = unknown> {
  value: T;
  expiresAt: string;
}

// Quiz response shape persisted to naming_quiz_responses.
export interface QuizResponse {
  runId: number;
  selectedNames: string[];   // exactly 3 names from the top-25 the user chose
  audience: string;          // free text, min 10 chars
  density: 'crowded' | 'moderate' | 'open';
  brandKind: 'premium' | 'mainstream' | 'utilitarian';
  email: string;
}
