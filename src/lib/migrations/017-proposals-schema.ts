// Generic proposals schema.
//
// Phase 1 of the proposal-builder refactor. Adds:
//   - proposals table: one row per proposal, holds a config JSON blob
//     that describes its narrative, interactive steps, signers, and
//     pricing formula. Lets the admin spin up new proposals without
//     code changes.
//   - proposal_drafts.selections and proposal_drafts.signatures JSON
//     columns: generic per-step state and per-signer state, replacing
//     the Raised-Bar-specific typed columns. The old columns stay for
//     one release window so the existing renderer keeps working until
//     Phase 2 swaps it for the generic renderer.
//
// Pure schema; no behavior change. Existing Raised Bar code keeps
// reading and writing the typed columns as it did before this migration.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '017-proposals-schema',
  async up() {
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        config TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        created_by TEXT REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now')),
        published_at TEXT,
        finalized_at TEXT
      )
    `);

    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_proposals_client ON proposals(client_id)`);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status)`);

    // Generic per-step selections and per-signer signatures on the
    // existing proposal_drafts table. SQLite ADD COLUMN is safe with
    // IF NOT EXISTS-style idempotency via a try/catch on the second
    // run.
    async function addColumnIfMissing(name: string, type: string) {
      try {
        await turso.execute(`ALTER TABLE proposal_drafts ADD COLUMN ${name} ${type}`);
      } catch (err: any) {
        const msg = err?.message || String(err);
        if (!msg.includes('duplicate column name')) throw err;
      }
    }
    await addColumnIfMissing('selections', 'TEXT');
    await addColumnIfMissing('signatures', 'TEXT');
  },
};

export default migration;
