// Restore the raised-bar proposals row to the pre-5/27 hardcoded
// sample shape after the unauthorized v2 rewrite in PR #195. The
// code-level revert restores src/lib/proposal-configs/raised-bar.ts
// to the v1 sample content, but migration 049 had already mutated
// proposals.config in prod. This migration re-runs the same write
// pattern as migration 026 to push the now-restored v1 config back
// to the database row. The hardcoded sample is a reference for the
// wizard build, not a deliverable proposal.

import turso from '../turso';
import type { Migration } from '../migrate';
import { RAISED_BAR_PROPOSAL_CONFIG } from '../proposal-configs/raised-bar';

const SLUG = 'raised-bar';

const migration: Migration = {
  id: '050-restore-raised-bar-sample',
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
