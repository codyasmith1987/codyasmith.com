// Pure helpers for the content-quality URL-insights aggregate.
// Extracted from the url-insights endpoint so the readability banding
// is unit-testable without a database. The three surfaced signals are
// near-duplicate content, spelling/grammar errors, and (soft, advisory)
// readability. Readability uses the Flesch reading-ease score: HIGHER is
// easier to read; technical/legal content scores low without being wrong,
// so the band is framed neutrally and never as a defect.

export interface ContentQualitySample {
  url: string;
  detail: string;
}

export interface ContentQualityInsights {
  // Near-duplicate content: pages whose content closely matches another page.
  near_duplicate_count: number;
  near_duplicate_samples: ContentQualitySample[];
  // Spelling / grammar: pages with at least one spelling or grammar error.
  spelling_grammar_count: number;
  spelling_grammar_samples: ContentQualitySample[];
  // Readability (soft/advisory): pages scoring low on Flesch reading ease.
  hard_to_read_count: number;
  hard_to_read_samples: ContentQualitySample[];
  // Per-sub-metric coverage. A content_urls month can be measured overall
  // while one sub-metric column is entirely blank (the paid analysis populated
  // some columns but not others). Each sub-metric is `measured` only when at
  // least one row has a real (non-NULL) value in its source column(s); when no
  // row carries the value, the sub-metric is { measured: false }, NEVER a
  // misleading clean 0. Counts above are computed only over the non-NULL rows.
  measured: {
    near_duplicate: boolean;
    spelling_grammar: boolean;
    readability: boolean;
  };
}

export function emptyContentQuality(): ContentQualityInsights {
  return {
    near_duplicate_count: 0,
    near_duplicate_samples: [],
    spelling_grammar_count: 0,
    spelling_grammar_samples: [],
    hard_to_read_count: 0,
    hard_to_read_samples: [],
    measured: {
      near_duplicate: false,
      spelling_grammar: false,
      readability: false,
    },
  };
}

// Pages with flesch_reading_ease STRICTLY BELOW this threshold are counted
// "hard to read" (advisory only). Use strict less-than (<): score 50 itself
// maps to 'fairly difficult' and is NOT included. 50 is the conventional
// boundary between "fairly difficult" and easier bands; the existing
// issue-urls.ts readability filter uses the same `< 50`. Exported so the
// endpoint query and any test share one number.
export const HARD_TO_READ_FLESCH_THRESHOLD = 50;

// Map a Flesch reading-ease score to a short, neutral band label.
// Returns null for null/undefined/non-finite input (no data -> no claim).
// Bands follow the conventional Flesch ranges; labels are plain and
// non-judgmental (a low score is "dense", not "bad").
export function readabilityBand(flesch: number | null | undefined): string | null {
  if (typeof flesch !== 'number' || !Number.isFinite(flesch)) return null;
  if (flesch >= 80) return 'very easy';
  if (flesch >= 60) return 'easy';
  if (flesch >= 50) return 'fairly difficult';
  if (flesch >= 30) return 'difficult';
  return 'very dense';
}
