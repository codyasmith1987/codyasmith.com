// Pure helpers for the structured-data (schema markup) URL-insights
// aggregate. Extracted from the url-insights endpoint so the
// schema-type tallying is unit-testable without a database.

export interface StructuredDataSample {
  url: string;
  error_count: number;
  warning_count: number;
}

export interface StructuredDataInsights {
  pages_with_errors: number;
  pages_with_warnings: number;
  total_errors: number;
  total_warnings: number;
  // Most common schema types across sampled pages, label -> page count,
  // highest first, capped to a small list.
  top_types: Record<string, number>;
  samples: StructuredDataSample[];
}

export function emptyStructuredData(): StructuredDataInsights {
  return {
    pages_with_errors: 0,
    pages_with_warnings: 0,
    total_errors: 0,
    total_warnings: 0,
    top_types: {},
    samples: [],
  };
}

// Tally the most common schema types across a set of `types_list` values.
// Each input string is a comma-joined list of type names from one page
// (e.g. "Article, BreadcrumbList, Organization"). Counts how many pages
// use each distinct type, returns the top `limit` as an ordered
// { typeName: pageCount } object, highest count first. Type names are
// trimmed; blank/falsy entries are ignored; a type repeated within one
// page's list counts once for that page. Ties broken alphabetically for
// deterministic output.
export function topSchemaTypes(
  typesListValues: Array<string | null | undefined>,
  limit = 8,
): Record<string, number> {
  const counts = new Map<string, number>();
  for (const raw of typesListValues) {
    if (!raw) continue;
    const perPage = new Set(
      String(raw)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean),
    );
    for (const type of perPage) {
      counts.set(type, (counts.get(type) || 0) + 1);
    }
  }
  const sorted = [...counts.entries()].sort(
    (a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]),
  );
  const out: Record<string, number> = {};
  for (const [type, n] of sorted.slice(0, limit)) {
    out[type] = n;
  }
  return out;
}
