// Per-link rows from Screaming Frog link-relationship exports.
//
// One row per (source -> destination) link. Covers all_inlinks,
// all_outlinks, all_anchor_text, and ~25 issue-context-filtered
// inlinks variants (blocked_by_robots_txt_inlinks, client_error_(4xx)_inlinks,
// self_referencing_inlinks, etc.).
//
// Powers the "what pages link to broken URLs" view on /portal/health
// and the anchor text quality work that needs source + destination +
// anchor in one row. Distinct from redirect_chains (which is one row
// per chain, not per link) and crawl_urls (one row per page, no
// link relationships).
//
// Per-source_file dedup: each file's rows live independently in
// link_graph so re-uploading all_inlinks.csv replaces just those rows,
// not all_outlinks.csv's rows. The links parser handles its own
// DELETE WHERE source_file = X before INSERT.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '041-link-graph',
  async up() {
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS link_graph (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        csv_upload_id TEXT REFERENCES csv_uploads(id),
        month TEXT NOT NULL,
        source_file TEXT NOT NULL,
        link_type TEXT,
        source_url TEXT NOT NULL,
        source_hostname TEXT,
        destination_url TEXT NOT NULL,
        destination_hostname TEXT,
        anchor_text TEXT,
        alt_text TEXT,
        status_code INTEGER,
        follow INTEGER NOT NULL DEFAULT 1,
        target TEXT,
        rel TEXT,
        link_position TEXT,
        link_origin TEXT,
        link_path TEXT,
        size_bytes INTEGER,
        anchor_length INTEGER,
        raw_json TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    await turso.execute(`
      CREATE INDEX IF NOT EXISTS idx_link_graph_client
      ON link_graph(client_id)
    `);
    await turso.execute(`
      CREATE INDEX IF NOT EXISTS idx_link_graph_source
      ON link_graph(client_id, source_url)
    `);
    await turso.execute(`
      CREATE INDEX IF NOT EXISTS idx_link_graph_destination
      ON link_graph(client_id, destination_url)
    `);
    await turso.execute(`
      CREATE INDEX IF NOT EXISTS idx_link_graph_status
      ON link_graph(client_id, status_code)
    `);
    await turso.execute(`
      CREATE INDEX IF NOT EXISTS idx_link_graph_source_file
      ON link_graph(client_id, source_file)
    `);
    await turso.execute(`
      CREATE INDEX IF NOT EXISTS idx_link_graph_upload
      ON link_graph(csv_upload_id)
    `);
  },
};

export default migration;
