// Pure helpers for the accessibility (WCAG) URL-insights aggregate.
// Extracted from the url-insights endpoint so the bucket-labeling and
// NULL-coalescing logic is unit-testable without a database.

// The seven per-URL WCAG count columns on accessibility_urls, mapped to
// the human labels shown in the client widget. Order = display order.
export const WCAG_BUCKETS: Array<{ column: string; label: string }> = [
  { column: 'wcag_20a_violations', label: 'WCAG 2.0 A' },
  { column: 'wcag_20aa_violations', label: 'WCAG 2.0 AA' },
  { column: 'wcag_20aaa_violations', label: 'WCAG 2.0 AAA' },
  { column: 'wcag_21a_violations', label: 'WCAG 2.1 A' },
  { column: 'wcag_21aa_violations', label: 'WCAG 2.1 AA' },
  { column: 'wcag_22a_violations', label: 'WCAG 2.2 A' },
  { column: 'wcag_22aa_violations', label: 'WCAG 2.2 AA' },
];

export interface AccessibilitySample {
  url: string;
  all_violations: number;
  status_code: number | null;
}

export interface AccessibilityInsights {
  pages_with_violations: number;
  total_violations: number;
  by_level: Record<string, number>;
  samples: AccessibilitySample[];
}

export function emptyAccessibility(): AccessibilityInsights {
  return { pages_with_violations: 0, total_violations: 0, by_level: {}, samples: [] };
}

// Given a map of { bucketColumn: pageCount }, return an ordered
// { label: count } object containing only buckets with a positive count.
// NULL / undefined / non-numeric counts coalesce to 0 and are dropped.
export function buildAccessibilityByLevel(
  counts: Record<string, number | null | undefined>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { column, label } of WCAG_BUCKETS) {
    const raw = counts[column];
    const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    if (n > 0) out[label] = n;
  }
  return out;
}
