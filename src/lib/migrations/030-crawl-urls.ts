// Per-URL crawl data from Screaming Frog Internal HTML / Internal All
// exports. The per-URL master table for the portal.
//
// Until now the CSV pipeline only stored aggregate metrics from
// Screaming Frog crawl-overview uploads (total_urls, response code
// counts) plus filtered site_audit row counts. The actual URLs and
// per-page detail were thrown away. That left every per-URL insight
// (title quality, thin content, indexability blocks, response-time
// outliers, deep-buried pages, orphan candidates) impossible to
// compute from uploaded data.
//
// This table holds one row per crawled URL per upload. It captures
// the most commonly queried Screaming Frog Internal columns as hot
// columns plus a raw_json catch-all for any future insight that
// needs a column we did not pre-index. Future insights (canonical
// chains, hreflang, link graph) get their own tables or are read
// straight out of raw_json depending on shape.
//
// Indexed lookups:
//   - by client_id (for the wizard's domain auto-detect)
//   - by (client_id, hostname) for per-site filters
//   - by csv_upload_id for re-import cleanup
//   - by (client_id, status_code) for "all 404s on the site" queries
//   - by (client_id, indexability) for "what's blocked from indexing"
//
// Lighter columns (canonical_url, response_time, etc.) live as hot
// columns because they are commonly read. Other SF columns (Hreflang,
// X-Robots-Tag, individual H2-1 through H2-10, etc.) live in
// raw_json and can be promoted to hot columns later without a data
// migration.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '030-crawl-urls',
  async up() {
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS crawl_urls (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        csv_upload_id TEXT REFERENCES csv_uploads(id),
        month TEXT NOT NULL,
        url TEXT NOT NULL,
        hostname TEXT NOT NULL,

        -- Hot columns: indexed or read often by portal insights.
        status_code INTEGER,
        content_type TEXT,
        indexability TEXT,
        indexability_status TEXT,
        title TEXT,
        title_length INTEGER,
        meta_description TEXT,
        meta_description_length INTEGER,
        h1 TEXT,
        h2 TEXT,
        word_count INTEGER,
        crawl_depth INTEGER,
        inlinks_count INTEGER,
        outlinks_count INTEGER,
        canonical_url TEXT,
        response_time_ms INTEGER,
        size_bytes INTEGER,
        last_modified TEXT,

        -- Catch-all: full SF row as JSON. Any column not in the hot
        -- list above can still be queried via json_extract; once a
        -- column becomes hot, promote it without re-ingesting data.
        raw_json TEXT,

        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    await turso.execute(`
      CREATE INDEX IF NOT EXISTS idx_crawl_urls_client
      ON crawl_urls(client_id)
    `);
    await turso.execute(`
      CREATE INDEX IF NOT EXISTS idx_crawl_urls_hostname
      ON crawl_urls(client_id, hostname)
    `);
    await turso.execute(`
      CREATE INDEX IF NOT EXISTS idx_crawl_urls_upload
      ON crawl_urls(csv_upload_id)
    `);
    await turso.execute(`
      CREATE INDEX IF NOT EXISTS idx_crawl_urls_status
      ON crawl_urls(client_id, status_code)
    `);
    await turso.execute(`
      CREATE INDEX IF NOT EXISTS idx_crawl_urls_indexability
      ON crawl_urls(client_id, indexability)
    `);
  },
};

export default migration;
