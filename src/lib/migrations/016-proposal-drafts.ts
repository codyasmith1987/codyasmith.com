// Proposal draft + countersign table.
//
// A client engagement might have multiple signers (Jason + Kevin on the
// Raised Bar proposal). They are unlikely to be at the same keyboard, so
// the proposal page persists selections + per-signer signatures on the
// server, letting the second signer log in later and find everything
// already chosen by the first.
//
// One row per (client_id, slug). Hardcoded jason_signature and
// kevin_signature columns for v1 since the Raised Bar engagement is the
// only proposal in play; if more proposals need a different signer set
// the schema can move to a separate signatures table later.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '016-proposal-drafts',
  async up() {
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS proposal_drafts (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        slug TEXT NOT NULL,
        mgmt_tier TEXT,
        option TEXT,
        consulting TEXT,
        consulting_tier TEXT,
        jason_signature TEXT,
        jason_signed_at TEXT,
        kevin_signature TEXT,
        kevin_signed_at TEXT,
        finalized_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(client_id, slug)
      )
    `);
    await turso.execute(`
      CREATE INDEX IF NOT EXISTS idx_proposal_drafts_client_slug
        ON proposal_drafts(client_id, slug)
    `);
  },
};

export default migration;
