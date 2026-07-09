// One row per managed domain per client. Replaces the single
// clients.domain column for clients that manage more than one site.
//
// is_managed defaults to 1: any domain that shows up in the client's
// uploaded data (Screaming Frog Internal HTML, keyword rankings)
// is assumed managed because the admin uploaded data for it. Admin
// can flip is_managed = 0 for the rare case where an SF crawl
// picked up a non-managed domain.
//
// is_primary marks the single domain used as the research target
// and as clients.domain's cached value. Only one row per client may
// be primary. The application layer enforces uniqueness (no DB
// constraint because SQLite partial unique indexes are awkward).
//
// label is admin-overridable display text (defaults to the domain).
// sort_order lets admin reorder the sites in Schedule A and in the
// wizard chip list.
//
// clients.domain stays as a denormalized cache of the primary site
// for backward compat with the research endpoint and the proposal
// title pre-fill. Updates to is_primary keep clients.domain in
// sync.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '033-client-sites',
  async up() {
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS client_sites (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        domain TEXT NOT NULL,
        is_primary INTEGER NOT NULL DEFAULT 0,
        is_managed INTEGER NOT NULL DEFAULT 1,
        label TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    await turso.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_client_sites_unique
      ON client_sites(client_id, domain)
    `);
    await turso.execute(`
      CREATE INDEX IF NOT EXISTS idx_client_sites_managed
      ON client_sites(client_id, is_managed)
    `);
    await turso.execute(`
      CREATE INDEX IF NOT EXISTS idx_client_sites_primary
      ON client_sites(client_id, is_primary)
    `);

    // Backfill: any client that already has clients.domain set gets
    // a primary, managed row in client_sites.
    await turso.execute(`
      INSERT OR IGNORE INTO client_sites (id, client_id, domain, is_primary, is_managed, label, sort_order)
      SELECT
        lower(hex(randomblob(8))) as id,
        id as client_id,
        domain,
        1 as is_primary,
        1 as is_managed,
        domain as label,
        0 as sort_order
      FROM clients
      WHERE domain IS NOT NULL AND domain != ''
    `);
  },
};

export default migration;
