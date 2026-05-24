// Single source of truth for the child tables that hold per-CSV-upload
// data and need to be swept when a csv_uploads row is deleted.
//
// Whenever a new parser writes to a new table that FKs to
// csv_uploads.id, ADD IT HERE. Forgetting to update this list leaves
// orphan rows after a delete and shows up as duplicate counts on
// the next re-upload.
//
// Consumed by:
//   src/pages/portal/api/admin/csv/delete-upload.ts
//   src/pages/portal/api/admin/csv/clear-failed.ts
//   src/pages/portal/api/admin/csv/clear-all-for-client.ts

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
];
