// Four more per-URL tables for the unique-data Screaming Frog exports
// that otherwise land as "Unrecognized CSV format" (unknown_stored):
//
//   canonicals_all.csv  -> canonical_urls   (canonical + pagination posture)
//   directives_all.csv  -> directive_urls   (robots / refresh directives)
//   validation_all.csv  -> page_weight_urls (page size + carbon footprint)
//   sitemaps_all.csv     -> sitemap_urls     (URLs found in the sitemap crawl)
//
// Same hot-columns + raw_json pattern as the per-URL tables in
// migration 034 (content_urls / security_urls / structured_data_urls /
// accessibility_urls). Each is keyed by client_id + url with the source
// upload tracked for clean re-imports, plus a (client_id, month) index
// for the per-month reads. Schemas mirror
// docs/superpowers/plans/2026-06-02-unique-data-parsers.md.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '059-extra-per-url-tables',
  async up() {
    // ---- canonical_urls ----
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS canonical_urls (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        csv_upload_id TEXT REFERENCES csv_uploads(id),
        month TEXT NOT NULL,
        url TEXT NOT NULL,
        hostname TEXT NOT NULL,
        occurrences INTEGER,
        indexability TEXT,
        indexability_status TEXT,
        canonical_link_element TEXT,
        http_canonical TEXT,
        meta_robots TEXT,
        x_robots_tag TEXT,
        rel_next TEXT,
        rel_prev TEXT,
        http_rel_next TEXT,
        http_rel_prev TEXT,
        raw_json TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_canonical_urls_client_month ON canonical_urls(client_id, month)`);

    // ---- directive_urls ----
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS directive_urls (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        csv_upload_id TEXT REFERENCES csv_uploads(id),
        month TEXT NOT NULL,
        url TEXT NOT NULL,
        hostname TEXT NOT NULL,
        occurrences INTEGER,
        meta_robots TEXT,
        x_robots_tag TEXT,
        meta_refresh TEXT,
        canonical_link_element TEXT,
        http_canonical TEXT,
        indexability TEXT,
        indexability_status TEXT,
        raw_json TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_directive_urls_client_month ON directive_urls(client_id, month)`);

    // ---- page_weight_urls ----
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS page_weight_urls (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        csv_upload_id TEXT REFERENCES csv_uploads(id),
        month TEXT NOT NULL,
        url TEXT NOT NULL,
        hostname TEXT NOT NULL,
        content_type TEXT,
        status_code INTEGER,
        indexability TEXT,
        size_bytes INTEGER,
        transferred_bytes INTEGER,
        total_transferred_bytes INTEGER,
        co2_mg REAL,
        carbon_rating TEXT,
        raw_json TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_page_weight_urls_client_month ON page_weight_urls(client_id, month)`);

    // ---- sitemap_urls ----
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS sitemap_urls (
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
        raw_json TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_sitemap_urls_client_month ON sitemap_urls(client_id, month)`);
  },
};

export default migration;
