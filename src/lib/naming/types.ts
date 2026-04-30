// Shared types for the naming pipeline engine.
// Public-brand identifier is intentionally `naming` until Phase 4 rename.

export interface ParentName {
  name: string;
  rationale: string;
  variants: VariantName[];
}

export interface VariantName {
  name: string;
  rationale: string;
}

export interface GenerateResult {
  parents: ParentName[];
}

export interface GenerateOptions {
  seed: string;
  creativity: number;
  promptVersion?: string;
  cache?: boolean;
}

export interface AvailabilityResult {
  name: string;
  tld: string;
  available: boolean | null;
  checkedAt: string;
}

export interface RankedName {
  name: string;
  parentName: string;
  parentRationale: string;
  variantRationale: string;
  availabilityByTld: Record<string, boolean | null>;
  availableTldCount: number;
  totalTldCount: number;
}

export interface RankOptions {
  tlds: string[];
  includeUnavailable?: boolean;
}

export type RunSource = 'preview' | 'report';

export interface InsertRunOptions {
  seedTerm: string;
  creativity: number;
  tlds: string[];
  source: RunSource;
  leadId?: number | null;
  configSnapshot?: string | null;
}

export interface CacheEntry<T = unknown> {
  value: T;
  expiresAt: string;
}
