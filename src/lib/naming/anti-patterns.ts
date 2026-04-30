// Forbidden suffixes scaled by creativity dial.
// Lower creativity = more conservative, more suffixes excluded.
// Higher creativity = looser constraints, fewer exclusions.

export const ANTI_PATTERNS = {
  // Creativity 1 to 3: exclude tired startup-ese
  basic: ['ly', 'ify', 'er', 'io', 'app', 'hub', 'box', 'kit', 'lab', 'works'],
  // Creativity 4 to 7: relax most, keep the worst offenders
  mid: ['ly', 'ify'],
  // Creativity 8 to 10: minimal restrictions
  high: [] as string[],
} as const;

export function antiPatternsForCreativity(creativity: number): readonly string[] {
  const c = Math.min(10, Math.max(1, Math.round(creativity)));
  if (c <= 3) return ANTI_PATTERNS.basic;
  if (c <= 7) return ANTI_PATTERNS.mid;
  return ANTI_PATTERNS.high;
}
