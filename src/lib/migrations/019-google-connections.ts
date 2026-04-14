// Slice 18 — Google Search Console + Google Analytics connections.
//
// One row per (admin user, Google account). The agency workflow is
// that Cody has Google Search Console access to many client
// properties through a single Google account; connecting once gives
// the portal long-lived OAuth refresh tokens that the sync handler
// uses to pull data for any property the admin is entitled to.
//
// Refresh tokens are stored encrypted with AES-256-GCM keyed on the
// GOOGLE_TOKEN_KEY env var. See src/lib/google/crypto.ts. Access
// tokens are cached in-row with their expiry so the sync handler
// can refresh lazily on demand.
//
// data_source_bindings.config_json will carry
//   { connection_id: '<google_connections.id>', property: '<site_url>' }
// to point a specific binding at a specific GSC/GA4 property under
// this connection.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '019-google-connections',
  async up() {
    await turso.batch(
      [
        `CREATE TABLE IF NOT EXISTS google_connections (
          id TEXT PRIMARY KEY,
          admin_user_id TEXT NOT NULL REFERENCES users(id),
          google_account_email TEXT NOT NULL,
          refresh_token_encrypted TEXT NOT NULL,
          access_token TEXT,
          access_token_expires_at TEXT,
          scopes_json TEXT NOT NULL,
          connected_at TEXT DEFAULT (datetime('now')),
          last_refresh_at TEXT,
          last_refresh_error TEXT,
          UNIQUE(admin_user_id, google_account_email)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_google_connections_admin
         ON google_connections(admin_user_id)`,
      ],
      'write'
    );
  },
};

export default migration;
