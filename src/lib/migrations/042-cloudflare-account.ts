// Account-level Cloudflare config. One token scoped to "All zones
// in account, Analytics: Read" replaces the per-site token paste so
// any new client_sites row whose hostname matches a zone in the
// account gets analytics automatically.
//
// Schema supports multiple rows for future multi-account scenarios
// (Cody also has access to a CF account he doesn't own). v1 uses one
// row with id='default'; the application enforces uniqueness, not the
// schema.
//
// Per-site cloudflare_api_token columns on client_sites stay as
// overrides for sites whose zones live in a different CF account from
// the one this token can see.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '042-cloudflare-account',
  async up() {
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS cloudflare_account_config (
        id TEXT PRIMARY KEY,
        label TEXT,
        api_token TEXT NOT NULL,
        last_zone_list_synced_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
  },
};

export default migration;
