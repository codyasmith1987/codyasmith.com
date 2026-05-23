// Per-client legal/contact data for contract Schedule A.
//
// One row per client, 1:1 with clients.id. Captures the legal-entity and
// designated-contact fields that the clients table itself does not carry.
// The contract page's inline intake form upserts here as the prospect
// fills missing fields before signing.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '019-client-metadata',
  async up() {
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS client_metadata (
        client_id TEXT PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
        legal_entity_name TEXT,
        entity_type TEXT,
        state_of_organization TEXT,
        ein TEXT,
        principal_address TEXT,
        notice_address TEXT,
        primary_contact_name TEXT,
        primary_contact_title TEXT,
        primary_contact_email TEXT,
        primary_contact_phone TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
  },
};

export default migration;
