// Four new per-URL tables for Screaming Frog reports that currently
// land as "Unrecognized CSV format" in the upload output:
//
//   content_all.csv       -> content_urls       (readability + duplicates)
//   security_all.csv      -> security_urls      (per-URL HTTP + security headers)
//   structured_data_all   -> structured_data_urls (schema markup errors)
//   accessibility_all.csv -> accessibility_urls (per-URL WCAG violations)
//
// Same hot-columns + raw_json pattern as crawl_urls (migration 030)
// and image_urls / redirect_chains (migration 031). Each table is
// keyed by client_id + url with the source upload tracked for clean
// re-imports.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '034-per-url-tables',
  async up() {
    // ---- content_urls ----
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS content_urls (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        csv_upload_id TEXT REFERENCES csv_uploads(id),
        month TEXT NOT NULL,
        url TEXT NOT NULL,
        hostname TEXT NOT NULL,
        word_count INTEGER,
        sentence_count INTEGER,
        avg_words_per_sentence REAL,
        flesch_reading_ease REAL,
        readability_grade TEXT,
        closest_near_duplicate_url TEXT,
        near_duplicate_count INTEGER,
        closest_semantic_similar_url TEXT,
        semantic_similarity_score REAL,
        semantic_relevance_score REAL,
        spelling_errors INTEGER,
        grammar_errors INTEGER,
        language TEXT,
        raw_json TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_content_urls_client ON content_urls(client_id)`);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_content_urls_upload ON content_urls(csv_upload_id)`);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_content_urls_readability ON content_urls(client_id, flesch_reading_ease)`);

    // ---- security_urls ----
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS security_urls (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        csv_upload_id TEXT REFERENCES csv_uploads(id),
        month TEXT NOT NULL,
        url TEXT NOT NULL,
        hostname TEXT NOT NULL,
        status_code INTEGER,
        http_version TEXT,
        content_type TEXT,
        indexability TEXT,
        is_https INTEGER,
        has_hsts INTEGER,
        has_csp INTEGER,
        has_x_content_type_options INTEGER,
        has_x_frame_options INTEGER,
        has_referrer_policy INTEGER,
        meta_robots TEXT,
        x_robots_tag TEXT,
        canonical_link TEXT,
        raw_json TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_security_urls_client ON security_urls(client_id)`);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_security_urls_upload ON security_urls(csv_upload_id)`);

    // ---- structured_data_urls ----
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS structured_data_urls (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        csv_upload_id TEXT REFERENCES csv_uploads(id),
        month TEXT NOT NULL,
        url TEXT NOT NULL,
        hostname TEXT NOT NULL,
        error_count INTEGER,
        warning_count INTEGER,
        rich_result_errors INTEGER,
        rich_result_warnings INTEGER,
        total_types INTEGER,
        unique_types INTEGER,
        types_list TEXT,
        rich_result_features TEXT,
        indexability TEXT,
        raw_json TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_structured_data_client ON structured_data_urls(client_id)`);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_structured_data_upload ON structured_data_urls(csv_upload_id)`);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_structured_data_errors ON structured_data_urls(client_id, error_count)`);

    // ---- accessibility_urls ----
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS accessibility_urls (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        csv_upload_id TEXT REFERENCES csv_uploads(id),
        month TEXT NOT NULL,
        url TEXT NOT NULL,
        hostname TEXT NOT NULL,
        status_code INTEGER,
        content_type TEXT,
        indexability TEXT,
        all_violations INTEGER,
        best_practice_violations INTEGER,
        wcag_20a_violations INTEGER,
        wcag_20aa_violations INTEGER,
        wcag_20aaa_violations INTEGER,
        wcag_21a_violations INTEGER,
        wcag_21aa_violations INTEGER,
        wcag_22a_violations INTEGER,
        wcag_22aa_violations INTEGER,
        raw_json TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_accessibility_urls_client ON accessibility_urls(client_id)`);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_accessibility_urls_upload ON accessibility_urls(csv_upload_id)`);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_accessibility_urls_violations ON accessibility_urls(client_id, all_violations)`);
  },
};

export default migration;
