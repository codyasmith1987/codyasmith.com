// Universal Screaming Frog export capture table.
//
// SF emits ~250 distinct report CSVs (every axe accessibility rule, every
// amp/hreflang/javascript/pagespeed/wcag issue slice, the per-URL "_all"
// reports, summaries, external-resource lists, etc.). Hand-writing a typed
// table per report type is the wrong unit of work, and letting them fall to
// unknown_stored (raw text, NOT queryable) is the failure state we are
// eliminating.
//
// sf_export_rows is the queryable floor: ANY CSV-shaped file that matches no
// specific signature is row-exploded into this table, keyed by report_type
// (derived from the filename), with the most common URL column hoisted for
// joins and the FULL row preserved as raw_json. Nothing is discarded; the
// whole superset is available to scoring/widgets/analysis. High-value report
// families can be promoted to bespoke typed tables later by reading raw_json.
//
// Self-dedup is by (client_id, month, report_type) inside the parser, so
// sf_generic is omitted from FORMAT_SOURCES (mirrors issue_urls / raw-csv).

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '060-sf-export-rows',
  async up() {
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS sf_export_rows (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        csv_upload_id TEXT REFERENCES csv_uploads(id),
        month TEXT NOT NULL,
        report_type TEXT NOT NULL,
        source_file TEXT NOT NULL,
        row_index INTEGER NOT NULL,
        url TEXT,
        raw_json TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    // Per-month reads + the per-(client,month,report_type) dedup delete.
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_sf_export_rows_client_month_type ON sf_export_rows(client_id, month, report_type)`);
    // URL joins (link a captured row back to a crawled page).
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_sf_export_rows_client_url ON sf_export_rows(client_id, url)`);
  },
};

export default migration;
