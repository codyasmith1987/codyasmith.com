// Per-issue URL lists from Screaming Frog per-issue CSV exports.
//
// SF generates one CSV per issue category (h1_missing.csv,
// page_titles_below_30_characters.csv, meta_description_over_155_characters.csv,
// etc.). Each lists the URLs that have that issue. The current ingestion
// pipeline reads issues_overview.csv for the COUNTS but throws away the
// URL lists. That makes the per-issue pop-out impossible without
// re-deriving from crawl_urls (which only covers issues with hot columns).
//
// This table holds one row per (client, month, issue, url). The
// per-issue CSV parser (src/lib/csv/parsers/issue-urls.ts) populates
// it during upload. The health page's expandable per-issue card and
// the /portal/api/dashboard/issue-urls endpoint read it.
//
// `extras` is a JSON catch-all for issue-specific columns from the
// CSV (e.g., the current title for "Page Titles: Below 30 Characters"
// rows so the popout can show "Title: X (29 chars)" next to the URL).
//
// Per audit + health-page-trust work, 2026-05-24.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '036-site-issue-urls',
  async up() {
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS site_issue_urls (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        csv_upload_id TEXT REFERENCES csv_uploads(id),
        month TEXT NOT NULL,
        issue_name TEXT NOT NULL,
        url TEXT NOT NULL,
        extras TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // Lookup pattern: health page + endpoint query by
    // (client_id, month, issue_name) to render the pop-out for one
    // issue at the latest month. Composite index serves this directly.
    await turso.execute(`
      CREATE INDEX IF NOT EXISTS idx_siu_client_month_issue
      ON site_issue_urls(client_id, month, issue_name)
    `);

    // CSV-upload-tied cleanup pattern: when an upload is deleted /
    // re-imported, wipe its rows by csv_upload_id.
    await turso.execute(`
      CREATE INDEX IF NOT EXISTS idx_siu_upload
      ON site_issue_urls(csv_upload_id)
    `);
  },
};

export default migration;
