// Phase 3 forbidden-suffix list. Hard rejection at validation time.
// Diagnosed in Phase 2: the model rotates through a small pool of generic
// startup-ese suffixes, producing names like StratoFlow, CatalystEdge, NexusCore.
// The structural fix is a flat hard-reject list applied at validation, not a
// soft creativity-conditioned hint inside the prompt.

export const FORBIDDEN_SUFFIXES: readonly string[] = [
  'Lab',
  'HQ',
  'Studio',
  'Works',
  'Co',
  'Hub',
  'Pro',
  'Plus',
  'Apex',
  'Edge',
  'Core',
  'Mark',
  'Flow',
  'Forge',
  'Sync',
  'Wave',
  'Sphere',
  'Logic',
  'Sense',
  'Path',
  'Drive',
  'Shift',
  'ly',
  'ify',
] as const;

const FORBIDDEN_LOWER = new Set(FORBIDDEN_SUFFIXES.map((s) => s.toLowerCase()));

export function endsWithForbiddenSuffix(name: string): string | null {
  const lower = name.toLowerCase();
  for (const suffix of FORBIDDEN_LOWER) {
    if (lower.endsWith(suffix)) return suffix;
  }
  return null;
}

// Legacy exports kept for backward compatibility with Phase 1 test runners.
// Phase 3 does not use these; the prompt embeds the suffix list and the
// validator rejects against FORBIDDEN_SUFFIXES.
export const ANTI_PATTERNS = {
  basic: ['ly', 'ify', 'er', 'io', 'app', 'hub', 'box', 'kit', 'lab', 'works'],
  mid: ['ly', 'ify'],
  high: [] as string[],
} as const;

export function antiPatternsForCreativity(creativity: number): readonly string[] {
  const c = Math.min(10, Math.max(1, Math.round(creativity)));
  if (c <= 3) return ANTI_PATTERNS.basic;
  if (c <= 7) return ANTI_PATTERNS.mid;
  return ANTI_PATTERNS.high;
}
