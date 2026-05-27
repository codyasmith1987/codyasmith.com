// Push the post-5/22 Fit Analysis architecture to the seeded
// raised-bar proposal row.
//
// The seeded config was on the pre-decision four-step shape (separate
// WM tier picker, site setup binary, MC yes/no, MC tier, plus two
// domain pickers). The 5/22 Fit Analysis settled a different shape:
// one bundled Good/Better/Best tier picker plus one optional Tailwater
// micro-site add-on. Buyer-visible content now matches Cody's authored
// HTML proposal. Pricing formula changes from raised_bar_v1 to
// raised_bar_v2 (a thin wrapper that maps v2 selections back to v1
// math, so the locked v1 math + tests are reused).

import turso from '../turso';
import type { Migration } from '../migrate';
import { RAISED_BAR_PROPOSAL_CONFIG } from '../proposal-configs/raised-bar';

const SLUG = 'raised-bar';

const migration: Migration = {
  id: '049-sync-raised-bar-v2',
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
