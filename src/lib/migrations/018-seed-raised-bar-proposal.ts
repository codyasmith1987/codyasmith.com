// Seed the Raised Bar proposal as a row in the generic proposals
// table. This row is the single source of truth for the proposal's
// config once Phase 2 swaps in the generic renderer.
//
// Idempotent on slug: if the row exists, the migration is a no-op.
// The config field stays in sync with src/lib/proposal-configs/raised-bar.ts;
// future config tweaks land via a new migration or via an admin edit
// flow that writes back to this row.

import { nanoid } from 'nanoid';
import turso from '../turso';
import type { Migration } from '../migrate';
import { RAISED_BAR_PROPOSAL_CONFIG } from '../proposal-configs/raised-bar';

const CLIENT_SLUG = 'raised-bar-group';
const PROPOSAL_SLUG = 'raised-bar';

const migration: Migration = {
  id: '018-seed-raised-bar-proposal',
  async up() {
    // Look up the client.
    const client = await turso.execute({
      sql: 'SELECT id FROM clients WHERE slug = ?',
      args: [CLIENT_SLUG],
    });
    if (client.rows.length === 0) {
      throw new Error(`Raised Bar Group client missing; migration 014 must run first.`);
    }
    const clientId = client.rows[0][0] as string;

    // Check for existing proposal row.
    const existing = await turso.execute({
      sql: 'SELECT id FROM proposals WHERE slug = ?',
      args: [PROPOSAL_SLUG],
    });
    if (existing.rows.length > 0) return;

    // Insert.
    const id = nanoid();
    await turso.execute({
      sql: `INSERT INTO proposals (id, slug, client_id, title, config, status, published_at)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
      args: [
        id,
        PROPOSAL_SLUG,
        clientId,
        RAISED_BAR_PROPOSAL_CONFIG.title,
        JSON.stringify(RAISED_BAR_PROPOSAL_CONFIG),
        'published',
      ],
    });
  },
};

export default migration;
