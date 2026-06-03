// Three more per-URL typed tables for the rich Screaming Frog "_all" exports
// that carry non-redundant structured data (the rest are sparse/redundant and
// stay in the sf_export_rows floor):
//
//   javascript_all.csv -> javascript_urls    (HTML-vs-rendered delta: word
//                                              count, title, H1, canonical)
//   url_all.csv        -> url_structure_urls  (Hash dup-content fingerprint,
//                                              URL length, encoding)
//   hreflang_all.csv   -> hreflang_urls       (per-URL hreflang annotations)
//
// Same hot-columns + raw_json pattern as migration 034/059. Each keyed by
// client_id + url with the source upload tracked for clean re-imports.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '061-more-sf-typed-tables',
  async up() {
    // ---- javascript_urls (HTML vs rendered) ----
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS javascript_urls (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        csv_upload_id TEXT REFERENCES csv_uploads(id),
        month TEXT NOT NULL,
        url TEXT NOT NULL,
        hostname TEXT NOT NULL,
        status_code INTEGER,
        html_word_count INTEGER,
        rendered_word_count INTEGER,
        word_count_change INTEGER,
        js_word_count_pct REAL,
        html_title TEXT,
        rendered_title TEXT,
        html_h1 TEXT,
        rendered_h1 TEXT,
        html_meta_description TEXT,
        rendered_meta_description TEXT,
        html_canonical TEXT,
        rendered_canonical TEXT,
        unique_inlinks INTEGER,
        unique_js_inlinks INTEGER,
        unique_outlinks INTEGER,
        unique_js_outlinks INTEGER,
        html_meta_robots TEXT,
        rendered_meta_robots TEXT,
        raw_json TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_javascript_urls_client_month ON javascript_urls(client_id, month)`);

    // ---- url_structure_urls ----
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS url_structure_urls (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        csv_upload_id TEXT REFERENCES csv_uploads(id),
        month TEXT NOT NULL,
        url TEXT NOT NULL,
        hostname TEXT NOT NULL,
        content_type TEXT,
        status_code INTEGER,
        status TEXT,
        indexability TEXT,
        indexability_status TEXT,
        content_hash TEXT,
        url_length INTEGER,
        canonical_link_element TEXT,
        url_encoded_address TEXT,
        raw_json TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_url_structure_urls_client_month ON url_structure_urls(client_id, month)`);
    // Hash index for the duplicate-content widget (group URLs by identical Hash).
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_url_structure_urls_hash ON url_structure_urls(client_id, content_hash)`);

    // ---- hreflang_urls ----
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS hreflang_urls (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        csv_upload_id TEXT REFERENCES csv_uploads(id),
        month TEXT NOT NULL,
        url TEXT NOT NULL,
        hostname TEXT NOT NULL,
        title TEXT,
        occurrences INTEGER,
        indexability TEXT,
        indexability_status TEXT,
        hreflang_count INTEGER,
        html_hreflang_1 TEXT,
        html_hreflang_1_url TEXT,
        http_hreflang_1 TEXT,
        http_hreflang_1_url TEXT,
        sitemap_hreflang_1 TEXT,
        sitemap_hreflang_1_url TEXT,
        raw_json TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_hreflang_urls_client_month ON hreflang_urls(client_id, month)`);
  },
};

export default migration;
