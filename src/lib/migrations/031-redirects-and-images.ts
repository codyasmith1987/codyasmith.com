// Per-URL redirect chains and image-specific data from Screaming Frog
// bulk exports. Two new tables, mirrored to the wide hot-columns +
// raw_json catch-all pattern from crawl_urls.
//
// redirect_chains: one row per chain (source URL -> final URL),
// with hop count, loop flag, and the first 5 hops materialized for
// quick reads. Beyond 5 hops, the raw_json catch-all carries the
// full chain.
//
// image_urls: one row per image asset, with size, alt-text presence,
// dimensions, and inlink count. Distinct from crawl_urls because
// internal_html only covers HTML pages; images come from a different
// SF export and warrant per-image queries.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '031-redirects-and-images',
  async up() {
    // ---- redirect_chains ----
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS redirect_chains (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        csv_upload_id TEXT REFERENCES csv_uploads(id),
        month TEXT NOT NULL,
        chain_type TEXT,
        source_url TEXT NOT NULL,
        source_hostname TEXT NOT NULL,
        final_url TEXT,
        final_status_code INTEGER,
        final_indexability TEXT,
        hop_count INTEGER NOT NULL DEFAULT 0,
        is_loop INTEGER NOT NULL DEFAULT 0,
        temp_redirect_in_chain INTEGER NOT NULL DEFAULT 0,
        anchor_text TEXT,
        link_path TEXT,
        hop1_url TEXT,
        hop1_status INTEGER,
        hop2_url TEXT,
        hop2_status INTEGER,
        hop3_url TEXT,
        hop3_status INTEGER,
        hop4_url TEXT,
        hop4_status INTEGER,
        hop5_url TEXT,
        hop5_status INTEGER,
        raw_json TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    await turso.execute(`
      CREATE INDEX IF NOT EXISTS idx_redirect_chains_client
      ON redirect_chains(client_id)
    `);
    await turso.execute(`
      CREATE INDEX IF NOT EXISTS idx_redirect_chains_source_host
      ON redirect_chains(client_id, source_hostname)
    `);
    await turso.execute(`
      CREATE INDEX IF NOT EXISTS idx_redirect_chains_upload
      ON redirect_chains(csv_upload_id)
    `);
    await turso.execute(`
      CREATE INDEX IF NOT EXISTS idx_redirect_chains_loop
      ON redirect_chains(client_id, is_loop)
    `);

    // ---- image_urls ----
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS image_urls (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        csv_upload_id TEXT REFERENCES csv_uploads(id),
        month TEXT NOT NULL,
        url TEXT NOT NULL,
        hostname TEXT NOT NULL,
        content_type TEXT,
        size_bytes INTEGER,
        inlinks_count INTEGER,
        indexability TEXT,
        dimensions TEXT,
        raw_json TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    await turso.execute(`
      CREATE INDEX IF NOT EXISTS idx_image_urls_client
      ON image_urls(client_id)
    `);
    await turso.execute(`
      CREATE INDEX IF NOT EXISTS idx_image_urls_hostname
      ON image_urls(client_id, hostname)
    `);
    await turso.execute(`
      CREATE INDEX IF NOT EXISTS idx_image_urls_size
      ON image_urls(client_id, size_bytes)
    `);
    await turso.execute(`
      CREATE INDEX IF NOT EXISTS idx_image_urls_upload
      ON image_urls(csv_upload_id)
    `);
  },
};

export default migration;
