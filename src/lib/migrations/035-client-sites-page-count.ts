// Adds per-site page_count to client_sites.
//
// Phase 2 of Finding 1 in docs/audits/proposal-chain-audit-2026-05-24.md.
// Cody's locked multi-site pricing decision (2026-05-24) routes each
// managed site to its OWN ecosystem by its OWN page count. The pricing
// pipeline therefore needs per-site page counts, not the engagement-
// level aggregate.
//
// Backfill: any site whose hostname appears in crawl_urls gets its
// page count seeded from the most recent crawl. Sites without crawl
// data stay NULL; the wizard/admin captures them via the UI in Phase 4.
//
// The pricing functions fall back to the primary site's ecosystem for
// any additional site whose page_count is NULL, which preserves the
// pre-Phase-1 behavior when the data is not yet populated.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '035-client-sites-page-count',
  async up() {
    // Add column. SQLite tolerates ADD COLUMN without rewrite.
    await turso.execute(`
      ALTER TABLE client_sites ADD COLUMN page_count INTEGER
    `);

    // Backfill from crawl_urls where data exists. Each managed site's
    // page count = distinct URL count for that hostname in the most
    // recent crawl per client. crawl_urls.url stores the full URL; we
    // extract the hostname via a SQLite-friendly substring match against
    // the site's domain.
    //
    // SQLite cannot regex; the approach: count crawl_urls rows whose
    // host portion contains the client_sites.domain string. Safe
    // because client_sites.domain is the bare host (no protocol, no
    // path) and crawl_urls.url contains the host in the URL.
    await turso.execute(`
      UPDATE client_sites
      SET page_count = (
        SELECT COUNT(DISTINCT url)
        FROM crawl_urls
        WHERE crawl_urls.client_id = client_sites.client_id
          AND (
            crawl_urls.url LIKE '%://' || client_sites.domain || '/%'
            OR crawl_urls.url LIKE '%://' || client_sites.domain
            OR crawl_urls.url LIKE '%://www.' || client_sites.domain || '/%'
            OR crawl_urls.url LIKE '%://www.' || client_sites.domain
          )
      )
      WHERE EXISTS (
        SELECT 1
        FROM crawl_urls
        WHERE crawl_urls.client_id = client_sites.client_id
      )
    `);

    // Any row that the subquery left as 0 should be NULL — 0 is not a
    // valid page count, it just means "no crawl data found for this
    // host." Distinguishes "data missing" from "site has zero pages."
    await turso.execute(`
      UPDATE client_sites SET page_count = NULL WHERE page_count = 0
    `);
  },
};

export default migration;
