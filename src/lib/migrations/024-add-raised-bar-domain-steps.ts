// Push the updated raised-bar proposal config to the proposals table.
//
// The source of truth is src/lib/proposal-configs/raised-bar.ts. This
// migration overwrites the existing proposals.config JSON for the
// raised-bar slug so the new builders_domain + tailwater_domain steps
// land in production. The consulting step numbering shifts from 3/4
// to 5/6 in the same update.

import turso from '../turso';
import type { Migration } from '../migrate';
import { RAISED_BAR_PROPOSAL_CONFIG } from '../proposal-configs/raised-bar';

const SLUG = 'raised-bar';

const migration: Migration = {
  id: '024-add-raised-bar-domain-steps',
  async up() {
    const existing = await turso.execute({
      sql: `SELECT id FROM proposals WHERE slug = ? LIMIT 1`,
      args: [SLUG],
    });
    if (existing.rows.length === 0) {
      // Nothing to update; migration 018 should have seeded it. Skip
      // quietly rather than crashing the migration runner.
      return;
    }
    await turso.execute({
      sql: `UPDATE proposals SET config = ? WHERE slug = ?`,
      args: [JSON.stringify(RAISED_BAR_PROPOSAL_CONFIG), SLUG],
    });
  },
};

export default migration;
