// Per-client snippet overrides. Move 7.
//
// Migration 043 created snippet_overrides keyed only by
// ${combo}::${eco}::${urgency}, meaning a Cody-authored snippet
// became the default for EVERY proposal that matched the key.
// There was no way to say "this snippet is just for ZKH" without
// the snippet then leaking into every other client's proposals.
//
// This adds a client_id column. NULL is encoded as the literal '*'
// string (sentinel for "global / no client scope") because SQLite
// treats NULL as distinct in UNIQUE constraints, which would
// otherwise allow multiple global snippets per key. The composer
// resolves at lookup time: try (key, client_id) first, fall back
// to (key, '*'). When the prospect's client_id matches a stored
// per-client snippet, it wins; otherwise the global snippet fires
// as before.
//
// Existing rows migrate as client_id = '*' (all were global).
// SQLite requires table recreation to drop the column-level UNIQUE
// constraint on `key`; using the standard rename-copy-drop pattern.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '045-snippet-per-client',
  async up() {
    // Create the new table shape.
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS snippet_overrides_v2 (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        client_id TEXT NOT NULL DEFAULT '*',
        intro_lines TEXT,
        what_i_see_paragraphs TEXT,
        what_i_recommend_paragraphs TEXT,
        rollout_scenarios TEXT,
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        created_by TEXT,
        UNIQUE(key, client_id)
      )
    `);
    // Copy existing rows. All previous overrides were global by
    // design (no client_id column existed), so they map to '*'.
    await turso.execute(`
      INSERT INTO snippet_overrides_v2 (id, key, client_id, intro_lines, what_i_see_paragraphs, what_i_recommend_paragraphs, rollout_scenarios, notes, created_at, updated_at, created_by)
      SELECT id, key, '*', intro_lines, what_i_see_paragraphs, what_i_recommend_paragraphs, rollout_scenarios, notes, created_at, updated_at, created_by
      FROM snippet_overrides
    `);
    // Swap. SQLite does not allow DROP CONSTRAINT, so the table
    // rename is the safe way to retire the old schema.
    await turso.execute(`DROP TABLE snippet_overrides`);
    await turso.execute(`ALTER TABLE snippet_overrides_v2 RENAME TO snippet_overrides`);
    // Recreate the existing lookup index plus a key+client_id index.
    await turso.execute(`
      CREATE INDEX IF NOT EXISTS idx_snippet_overrides_key
      ON snippet_overrides(key)
    `);
    await turso.execute(`
      CREATE INDEX IF NOT EXISTS idx_snippet_overrides_key_client
      ON snippet_overrides(key, client_id)
    `);
  },
};

export default migration;
