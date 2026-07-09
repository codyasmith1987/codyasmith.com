// Push the updated raised-bar proposal config (selection-aware rollout)
// to the proposals row. Migration 024 already did the same for the
// domain-picker step additions, but a one-shot migration only fires
// once; this is a fresh one to land the rollout-scenarios refactor.

import turso from '../turso';
import type { Migration } from '../migrate';
import { RAISED_BAR_PROPOSAL_CONFIG } from '../proposal-configs/raised-bar';

const SLUG = 'raised-bar';

const migration: Migration = {
  id: '026-sync-raised-bar-rollout',
  async up() {
    const existing = await turso.execute({
      sql: `SELECT id FROM proposals WHERE slug = ? LIMIT 1`,
      args: [SLUG],
    });
    if (existing.rows.length === 0) return;
    await turso.execute({
      sql: `UPDATE proposals SET config = ? WHERE slug = ?`,
      args: [JSON.stringify(RAISED_BAR_PROPOSAL_CONFIG), SLUG],
    });
  },
};

export default migration;
