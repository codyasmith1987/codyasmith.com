// Phase 1 simple ranker: sort by percent of TLDs available DESC, name length ASC.
// Phase 3 swaps this for the full composite scoring across 10 axes.

import type {
  AvailabilityResult,
  GenerateResult,
  RankOptions,
  RankedName,
} from './types';

export function rankPhase1(
  generation: GenerateResult,
  availability: AvailabilityResult[],
  options: RankOptions,
): RankedName[] {
  const { tlds, includeUnavailable = false } = options;

  // Build availability lookup: name -> tld -> available.
  const availMap = new Map<string, Map<string, boolean | null>>();
  for (const a of availability) {
    if (!availMap.has(a.name)) availMap.set(a.name, new Map());
    availMap.get(a.name)!.set(a.tld, a.available);
  }

  // Flatten variants. Phase 1 ranks variants only, parents are kept for context.
  const ranked: RankedName[] = [];
  for (const parent of generation.parents) {
    for (const variant of parent.variants) {
      const tldMap = availMap.get(variant.name) ?? new Map<string, boolean | null>();
      const availabilityByTld: Record<string, boolean | null> = {};
      let availableCount = 0;
      for (const tld of tlds) {
        const v = tldMap.get(tld) ?? null;
        availabilityByTld[tld] = v;
        if (v === true) availableCount += 1;
      }
      ranked.push({
        name: variant.name,
        parentName: parent.name,
        parentRationale: parent.rationale,
        variantRationale: variant.rationale,
        availabilityByTld,
        availableTldCount: availableCount,
        totalTldCount: tlds.length,
      });
    }
  }

  const filtered = includeUnavailable
    ? ranked
    : ranked.filter((r) => r.availableTldCount > 0);

  filtered.sort((a, b) => {
    const pctA = a.availableTldCount / Math.max(1, a.totalTldCount);
    const pctB = b.availableTldCount / Math.max(1, b.totalTldCount);
    if (pctA !== pctB) return pctB - pctA;
    return a.name.length - b.name.length;
  });

  return filtered;
}
