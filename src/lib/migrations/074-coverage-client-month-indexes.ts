// (client_id, month) covering indexes for the coverage-recompute hot path
// (2026-06-15).
//
// recomputeCategoryCoverage runs `SELECT COUNT(*) [/ SUM(...)] FROM <table>
// WHERE client_id = ? AND month = ?` after every ingested file. The two
// highest-cardinality tables -- link_graph (one row per link) and crawl_urls
// (one row per URL) -- had ONLY a leading-client_id index (migrations 041 /
// 030), with no month component and no site_id column. So for a client whose
// data has accumulated across months and sites (ZipKit = ZKH + MVP merged
// under one client_id), each COUNT seeked client_id then SCANNED every row
// that client owns, filtering month as a residual. An SF export fans out to
// ~25-30 link files, each firing a full link_graph scan inside Cloudflare's
// ~100s origin window -> 524 timeouts that grow with the client's history,
// which is exactly why a data-heavy client times out while a fresh one is
// instant.
//
// These indexes turn each scan into a tight (client_id, month) range count.
// Pure DDL, additive: the query plan changes, the results never do. The same
// (client_id, month) shape that canonical_urls / directive_urls / page_weight /
// sitemap_urls / keyword_rankings already carry. The signal-kind tables
// (content_urls, accessibility_urls, structured_data_urls) benefit too -- the
// index bounds the rows their SUM(CASE WHEN col IS NOT NULL) predicate walks.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '074-coverage-client-month-indexes',
  async up() {
    // Highest-cardinality first -- these two are the timeout drivers.
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_link_graph_client_month ON link_graph(client_id, month)`);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_crawl_urls_client_month ON crawl_urls(client_id, month)`);
    // The rest of the coverage family with the same missing-index defect.
    // Page/resource-bounded today, but they share the pattern and the index is
    // cheap + additive, so close the whole family in one pass. image_urls is
    // the next to grow (many images per page).
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_image_urls_client_month ON image_urls(client_id, month)`);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_redirect_chains_client_month ON redirect_chains(client_id, month)`);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_security_urls_client_month ON security_urls(client_id, month)`);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_content_urls_client_month ON content_urls(client_id, month)`);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_accessibility_urls_client_month ON accessibility_urls(client_id, month)`);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_structured_data_urls_client_month ON structured_data_urls(client_id, month)`);
  },
};

export default migration;
