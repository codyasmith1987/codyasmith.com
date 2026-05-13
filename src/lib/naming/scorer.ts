// Phase 3 two-tier scoring rubric. Replaces the Phase 1 simple ranker.
//
// Tier 1 (gates): a candidate must have an available .com OR a documented
// secondary-market price under SECONDARY_MARKET_CAP_USD. Failing the gate
// excludes the candidate from the scored pool. Phase 3 ships without
// secondary-market pricing API integration (Namecheap requires IP whitelist
// on App Platform's dynamic egress; Sedo requires partner approval), so
// failing-.com candidates with unknown price are excluded from scoring but
// retained in the full result for the post-gate PDF as "owned, price unknown".
//
// Tier 2 (scoring): six dimensions, weighted sum, top-K by score advances.
// Methodology-anchored: pronounceability and tonality-fit carry the highest
// weight per Task 1's processing-fluency finding and Task 2's tonality-axis
// convention. All weights are constants in config.ts; tunable.

import { DEFAULTS, SCORING_WEIGHTS, TRADEMARK_BY_TYPOLOGY } from './config';
import { TONALITY_AXES } from './types';
import type {
  AvailabilityResult,
  DomainStatus,
  GenerateResult,
  NameCandidate,
  ScoreBreakdown,
  ScoredCandidate,
  TonalityVector,
} from './types';

export interface ScoreOptions {
  userTonality?: TonalityVector;
  secondaryPriceLookup?: (name: string) => Promise<number | null>;
  secondaryPriceCapUsd?: number;
}

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'y']);

function isVowel(ch: string): boolean {
  return VOWELS.has(ch.toLowerCase());
}

// ---- Pronounceability ----
// Heuristic: penalize consonant clusters > 3, penalize unusual sequences,
// reward CV alternation, reward common English bigrams.
const COMMON_BIGRAMS = new Set([
  'th', 'he', 'in', 'er', 'an', 're', 'on', 'at', 'en', 'nd',
  'ti', 'es', 'or', 'te', 'of', 'ed', 'is', 'it', 'al', 'ar',
  'st', 'to', 'nt', 'ng', 'se', 'ha', 've', 'le', 'me', 'de',
  'sa', 'co', 'pr', 'ra', 'ro', 'li', 'ic', 'el', 'ne', 'la',
]);
const RARE_DIGRAMS = new Set([
  'qx', 'vk', 'xj', 'zx', 'jq', 'wx', 'fq', 'pq', 'jx', 'qj',
  'kx', 'qz', 'xz',
]);

export function pronounceabilityScore(name: string): number {
  const lower = name.toLowerCase().replace(/-/g, '');
  if (lower.length === 0) return 0;

  let consonantRun = 0;
  let maxConsonantRun = 0;
  let cvAlternations = 0;
  let lastWasVowel: boolean | null = null;
  for (const ch of lower) {
    const v = isVowel(ch);
    if (lastWasVowel !== null && lastWasVowel !== v) cvAlternations += 1;
    lastWasVowel = v;
    if (!v) {
      consonantRun += 1;
      if (consonantRun > maxConsonantRun) maxConsonantRun = consonantRun;
    } else {
      consonantRun = 0;
    }
  }

  // Bigram pass
  let commonBigrams = 0;
  let rareBigrams = 0;
  for (let i = 0; i < lower.length - 1; i += 1) {
    const big = lower.slice(i, i + 2);
    if (COMMON_BIGRAMS.has(big)) commonBigrams += 1;
    if (RARE_DIGRAMS.has(big)) rareBigrams += 1;
  }

  // Score: start at 5, adjust
  let score = 5;
  if (maxConsonantRun > 3) score -= 2;
  if (maxConsonantRun > 4) score -= 1;
  score += Math.min(2, cvAlternations * 0.4);
  score += Math.min(2, commonBigrams * 0.5);
  score -= Math.min(3, rareBigrams * 1.5);

  // Vowel presence (no vowel = unpronounceable)
  const hasVowel = [...lower].some(isVowel);
  if (!hasVowel) score = 0;

  return Math.max(0, Math.min(10, score));
}

// ---- Memorability ----
// Heuristic: distinctiveness (unusual letter patterns), imageability bonus
// for associative/metaphoric typology, shorter syllable count rewards.
const UNCOMMON_LETTERS = new Set(['q', 'x', 'z', 'j', 'k']);

function approxSyllables(name: string): number {
  const lower = name.toLowerCase().replace(/-/g, '');
  let syllables = 0;
  let prevVowel = false;
  for (const ch of lower) {
    const v = isVowel(ch);
    if (v && !prevVowel) syllables += 1;
    prevVowel = v;
  }
  return Math.max(1, syllables);
}

export function memorabilityScore(candidate: NameCandidate): number {
  const lower = candidate.name.toLowerCase();
  let score = 5;

  // Distinctiveness via uncommon letters
  const uncommonCount = [...lower].filter((ch) => UNCOMMON_LETTERS.has(ch)).length;
  score += Math.min(3, uncommonCount * 1.5);

  // Imageability bonus for associative typology
  if (candidate.typology === 'associative') score += 1.5;

  // Syllable count: 2-3 ideal
  const syl = approxSyllables(candidate.name);
  if (syl >= 2 && syl <= 3) score += 1;
  if (syl >= 5) score -= 2;

  // Tiny names (< 5 chars) often lack memorability anchor
  if (candidate.name.length < 5) score -= 1;

  return Math.max(0, Math.min(10, score));
}

// ---- Length efficiency ----
// Reward 5-9 chars, penalize 4 and 12-15.
export function lengthScore(name: string): number {
  const len = name.length;
  if (len >= 5 && len <= 9) return 10;
  if (len === 10 || len === 11) return 8;
  if (len === 4) return 5;
  if (len === 12) return 6;
  if (len === 13) return 4;
  if (len === 14) return 3;
  if (len === 15) return 2;
  return 0;
}

// ---- Tonality fit ----
// Euclidean distance between candidate tonality and user tonality.
// Distance 0 = perfect fit = score 10. Max distance is sqrt(5*16) ~= 8.94
// (if all axes are at opposite extremes 1 vs 5). Map [0, max] to [10, 0].
const MAX_TONALITY_DISTANCE = Math.sqrt(5 * 16);

export function tonalityFitScore(
  candidate: NameCandidate,
  user: TonalityVector,
): number {
  let sumSq = 0;
  for (const axis of TONALITY_AXES) {
    const d = candidate.tonality[axis] - user[axis];
    sumSq += d * d;
  }
  const distance = Math.sqrt(sumSq);
  return Math.max(0, Math.min(10, 10 * (1 - distance / MAX_TONALITY_DISTANCE)));
}

// ---- Trademark proxy ----
// Abercrombie spectrum on a 0-10 scale, by typology.
export function trademarkScore(candidate: NameCandidate): number {
  return TRADEMARK_BY_TYPOLOGY[candidate.typology] ?? 5;
}

// ---- Domain feasibility score ----
// Free .com = 10, owned with low price = 8 (under $1k), 6 ($1-3k),
// 4 ($3-10k), 0 (over cap or unknown owned).
export function domainFeasibilityScore(domain: DomainStatus, capUsd: number): number {
  if (domain.available === true) return 10;
  if (domain.available === false) {
    if (domain.secondaryPriceUsd === null) return 0; // owned, price unknown
    if (domain.secondaryPriceUsd > capUsd) return 0;
    if (domain.secondaryPriceUsd < 1000) return 8;
    if (domain.secondaryPriceUsd <= 3000) return 6;
    if (domain.secondaryPriceUsd <= 10000) return 4;
    return 0;
  }
  // null = unknown availability, treat as 0 (excluded from scored pool by gate)
  return 0;
}

// ---- Composite ----
function compositeScore(breakdown: ScoreBreakdown): number {
  return (
    breakdown.pronounceability * SCORING_WEIGHTS.pronounceability +
    breakdown.memorability * SCORING_WEIGHTS.memorability +
    breakdown.length * SCORING_WEIGHTS.length +
    breakdown.tonality_fit * SCORING_WEIGHTS.tonality_fit +
    breakdown.trademark * SCORING_WEIGHTS.trademark +
    breakdown.domain_feasibility * SCORING_WEIGHTS.domain_feasibility
  );
}

// ---- Top-level scoring entry ----
// Returns ALL candidates with their score and Tier 1 gate status, sorted by
// composite score descending. The endpoint takes the top-K from the
// non-excluded subset for the slider; the full set is persisted so the PDF
// can reference Tier-1-excluded names as "owned, price unknown".
export async function scoreAllCandidates(
  generation: GenerateResult,
  availability: AvailabilityResult[],
  options: ScoreOptions = {},
): Promise<ScoredCandidate[]> {
  const userTonality = options.userTonality ?? {
    serious_playful: 3,
    modern_classical: 3,
    descriptive_abstract: 3,
    technical_emotional: 3,
    conservative_bold: 3,
  };
  const cap = options.secondaryPriceCapUsd ?? DEFAULTS.SECONDARY_MARKET_CAP_USD;
  const priceLookup = options.secondaryPriceLookup ?? (async () => null);

  // Build availability map for .com only.
  const availMap = new Map<string, boolean | null>();
  for (const a of availability) {
    if (a.tld === 'com') availMap.set(a.name, a.available);
  }

  const scored: ScoredCandidate[] = [];
  for (const candidate of generation.candidates) {
    const comAvailable = availMap.get(candidate.name) ?? null;
    let secondaryPrice: number | null = null;
    if (comAvailable === false) {
      // Try secondary-market price lookup; null fallback when not integrated.
      try {
        secondaryPrice = await priceLookup(candidate.name);
      } catch {
        secondaryPrice = null;
      }
    }
    const domain: DomainStatus = {
      available: comAvailable,
      secondaryPriceUsd: secondaryPrice,
    };

    // Tier 1 gate: must have available .com OR price under cap.
    let excluded: ScoredCandidate['excluded'];
    if (comAvailable === null) {
      // Unknown availability: exclude conservatively.
      excluded = 'no_domain_path';
    } else if (comAvailable === false) {
      if (secondaryPrice === null) excluded = 'no_domain_path';
      else if (secondaryPrice > cap) excluded = 'price_over_cap';
    }

    const breakdown: ScoreBreakdown = {
      pronounceability: pronounceabilityScore(candidate.name),
      memorability: memorabilityScore(candidate),
      length: lengthScore(candidate.name),
      tonality_fit: tonalityFitScore(candidate, userTonality),
      trademark: trademarkScore(candidate),
      domain_feasibility: domainFeasibilityScore(domain, cap),
    };

    scored.push({
      candidate,
      score: compositeScore(breakdown),
      breakdown,
      domain,
      excluded,
    });
  }

  // Sort by score desc; excluded candidates land at the bottom regardless of
  // raw score (they will be filtered out for the slider but kept in the PDF).
  scored.sort((a, b) => {
    if (a.excluded && !b.excluded) return 1;
    if (!a.excluded && b.excluded) return -1;
    return b.score - a.score;
  });

  return scored;
}

export function topK(scored: ScoredCandidate[], k: number = DEFAULTS.TOP_K_FOR_SLIDER): ScoredCandidate[] {
  return scored.filter((s) => !s.excluded).slice(0, k);
}
