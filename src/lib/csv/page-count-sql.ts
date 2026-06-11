// THE single definition of a "real user page": a published destination a
// human navigates to. status 200 + text/html + indexable, minus taxonomy,
// utility/system, attachment, and pagination URLs. This is the count WM
// ecosystem routing / pricing MUST use (benchmarks: f3=5, zipkit=70; the
// earlier f3=6 double-counted an in-page #fragment, corrected 2026-06-02).
// Extracted so crawl-read.ts (dashboard/report) and client-sites.ts
// (pricing) cannot drift to different definitions.

// Row-level predicates. `prefix` is an optional table alias (e.g. 'cu').
export function realUserPageRowFilters(prefix = ''): string {
  const p = prefix ? `${prefix}.` : '';
  return `
    AND ${p}status_code = 200
    AND LOWER(IFNULL(${p}content_type, '')) LIKE '%html%'
    AND LOWER(IFNULL(${p}indexability, '')) != 'non-indexable'
  `;
}

// URL-pattern exclusions. `col` is the fully-qualified url column (e.g.
// 'url' or 'cu.url').
export function realUserPageUrlExclusions(col: string): string {
  return `
    AND ${col} NOT LIKE '%/tag/%'
    AND ${col} NOT LIKE '%/category/%'
    AND ${col} NOT LIKE '%/author/%'
    AND ${col} NOT LIKE '%/feed/%'
    AND ${col} NOT LIKE '%/feed'
    AND ${col} NOT LIKE '%/embed/%'
    AND ${col} NOT LIKE '%/embed'
    AND ${col} NOT LIKE '%/attachment/%'
    AND ${col} NOT LIKE '%/wp-content/%'
    AND ${col} NOT LIKE '%/wp-includes/%'
    AND ${col} NOT LIKE '%/wp-admin/%'
    AND ${col} NOT LIKE '%/wp-json/%'
    AND ${col} NOT LIKE '%/cdn-cgi/%'
    AND ${col} NOT LIKE '%?attachment_id=%'
    AND ${col} NOT LIKE '%?attachment=%'
    AND ${col} NOT LIKE '%?replytocom=%'
    AND ${col} NOT LIKE '%?p=%'
    AND ${col} NOT LIKE '%?paged=%'
    AND ${col} NOT GLOB '*/page/[0-9]*'
  `;
}
