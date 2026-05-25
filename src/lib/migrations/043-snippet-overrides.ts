// DB-backed snippet overrides. Slice 4 v1.
//
// Original Slice 4 plan called for either (a) writing to
// narrative-snippets.ts via a server endpoint so snippets stay
// version-controlled, or (b) a snippet_overrides table that decouples
// snippet edits from deploys. Picking (b) for v1 because runtime
// file-writes from inside a deployed Astro server are awkward and
// risk corruption. We can add a one-time "export overrides to file"
// admin tool later that promotes DB entries into the registry.
//
// The composer reads file registry + DB overrides at lookup time
// (DB wins; falls back to file). Changes saved via the matrix editor
// take effect on the next request without a redeploy.
//
// Key format matches the file registry exactly:
// `${product_combo}::${ecosystem}::${urgency}` where any segment
// may be '*' for "any value." See narrative-snippets.ts for the
// full convention.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '043-snippet-overrides',
  async up() {
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS snippet_overrides (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        intro_lines TEXT,
        what_i_see_paragraphs TEXT,
        what_i_recommend_paragraphs TEXT,
        rollout_scenarios TEXT,
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        created_by TEXT
      )
    `);
    await turso.execute(`
      CREATE INDEX IF NOT EXISTS idx_snippet_overrides_key
      ON snippet_overrides(key)
    `);
  },
};

export default migration;
