// Child tables that hold per-CSV-upload data and must be swept when a
// csv_uploads row is deleted.
//
// PREFER getCsvUploadChildTables() (below) over this static list. The list
// silently drifted once — data_coverage and the "parse everything" tables
// (canonical_urls, directive_urls, page_weight_urls, sitemap_urls,
// sf_export_rows, javascript_urls, url_structure_urls, hreflang_urls) were
// never added, so deleting any upload whose data landed there FK-failed on
// the parent delete. The dynamic resolver removes the need to remember.
// This list stays complete as a documented FLOOR / fallback if discovery
// ever returns nothing.
//
// Consumed by:
//   src/pages/portal/api/admin/csv/delete-upload.ts
//   src/pages/portal/api/admin/csv/clear-failed.ts
//   src/pages/portal/api/admin/csv/clear-superseded.ts
//   src/pages/portal/api/admin/csv/clear-all-for-client.ts

import turso from './turso';

export const CSV_CHILD_TABLES: string[] = [
  'metrics',
  'site_issues',
  'site_issue_urls',
  'keyword_rankings',
  'crawl_urls',
  'redirect_chains',
  'image_urls',
  'content_urls',
  'security_urls',
  'structured_data_urls',
  'accessibility_urls',
  // Catch-all storage for uploads the portal accepted but does not
  // yet have a typed parser for. Swept on re-upload + delete so the
  // same filename can't accumulate raw copies.
  'raw_csv_data',
  // GA4 tables — per Slice B of the data-ingestion overhaul. One
  // GA4 file maps to multiple tables (Reports snapshot fans out to
  // topline + source_medium + campaigns), so all of them need to
  // be on the sweep list.
  'ga4_topline',
  'ga4_channels',
  'ga4_source_medium',
  'ga4_pages',
  'ga4_tech',
  'ga4_geography',
  'ga4_campaigns',
  // GSC tables — per Slice C of the data-ingestion overhaul.
  'gsc_dimensions',
  'gsc_chart',
  'gsc_filters',
  // Link relationship rows from Screaming Frog *_inlinks, *_outlinks,
  // all_anchor_text variants. Per-source_file dedup is handled inside
  // the parser, but the full-client sweep still needs this table on
  // the list so deleting an upload row removes its link rows too.
  'link_graph',
  // Per-upload coverage signal rows (migration 056). EVERY upload writes
  // one, so omitting this was the FK that blocked deleting any upload.
  'data_coverage',
  // "Parse everything" typed tables (migrations 059-061).
  'canonical_urls',
  'directive_urls',
  'page_weight_urls',
  'sitemap_urls',
  'javascript_urls',
  'url_structure_urls',
  'hreflang_urls',
  // Universal row-exploded floor for CSVs with no dedicated parser (060).
  'sf_export_rows',
];

// Discover every EXISTING table that carries a csv_upload_id column — i.e.
// every per-upload child table — so deleting an upload clears ALL of its
// rows regardless of whether someone remembered to update the list above.
// This is the recurrence-proof source of truth: a new parser table is swept
// automatically. Returns only tables that exist AND have the column, so the
// callers' DELETEs can never hit a missing table/column. Falls back to the
// static floor if introspection yields nothing. Cached per process (the
// schema is fixed once migrations have run at cold start).
let _childTablesCache: string[] | null = null;
export async function getCsvUploadChildTables(): Promise<string[]> {
  if (_childTablesCache) return _childTablesCache;
  try {
    const tablesRes = await turso.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'csv_uploads'`,
    );
    const found: string[] = [];
    for (const r of tablesRes.rows as any[]) {
      const name = String(r[0]);
      try {
        const cols = await turso.execute(`PRAGMA table_info("${name}")`);
        if ((cols.rows as any[]).some(c => String(c[1]) === 'csv_upload_id')) found.push(name);
      } catch {
        // Can't introspect this table; skip rather than fail the whole sweep.
      }
    }
    if (found.length > 0) {
      _childTablesCache = found;
      return found;
    }
  } catch {
    // Introspection unavailable; fall through to the static floor.
  }
  return CSV_CHILD_TABLES;
}
