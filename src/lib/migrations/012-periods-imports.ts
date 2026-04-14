// Phase 1 Step 3 — first-class history objects.
//
// Introduces `periods` and `imports` as the real unit of historical truth,
// replacing the free-text `month` column that currently scopes everything.
//
// periods  — one row per (client_id, period_type, period_start). A period
//            is a named window of time that metrics/rankings/issues hang
//            off of. locked_at, when set, prevents further mutation of
//            data rows tied to this period (future "close the books").
//
// imports  — one row per ingestion attempt. Ties a source+file+hash to a
//            period. The UNIQUE (client_id, period_id, source, content_hash)
//            is the replay guard: the same bytes on the same period+source
//            can never apply twice.
//
// Legacy data tables (metrics, keyword_rankings, site_issues) get nullable
// period_id and import_id columns. Step 4's snapshot tables will be the
// terminal home; these nullable columns exist only for the transition.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '012-periods-imports',
  async up() {
    await turso.batch(
      [
        `CREATE TABLE IF NOT EXISTS periods (
          id TEXT PRIMARY KEY,
          client_id TEXT NOT NULL REFERENCES clients(id),
          period_type TEXT NOT NULL DEFAULT 'month',
          period_start TEXT NOT NULL,
          period_end TEXT NOT NULL,
          locked_at TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          UNIQUE(client_id, period_type, period_start)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_periods_client ON periods(client_id, period_start)`,
        `CREATE TABLE IF NOT EXISTS imports (
          id TEXT PRIMARY KEY,
          client_id TEXT NOT NULL REFERENCES clients(id),
          period_id TEXT NOT NULL REFERENCES periods(id),
          source TEXT NOT NULL,
          original_name TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          status TEXT NOT NULL,
          row_count INTEGER NOT NULL DEFAULT 0,
          uploaded_by TEXT NOT NULL REFERENCES users(id),
          started_at TEXT DEFAULT (datetime('now')),
          finished_at TEXT,
          error TEXT,
          UNIQUE(client_id, period_id, source, content_hash)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_imports_period ON imports(period_id)`,
        `CREATE INDEX IF NOT EXISTS idx_imports_client_status ON imports(client_id, status)`,
      ],
      'write'
    );

    // Add nullable period_id / import_id columns to legacy data tables.
    // Wrapped in try/catch per ALTER because re-running against an
    // already-partially-migrated DB should be safe.
    const alters: Array<[string, string]> = [
      ['metrics', 'period_id TEXT REFERENCES periods(id)'],
      ['metrics', 'import_id TEXT REFERENCES imports(id)'],
      ['keyword_rankings', 'period_id TEXT REFERENCES periods(id)'],
      ['keyword_rankings', 'import_id TEXT REFERENCES imports(id)'],
      ['site_issues', 'period_id TEXT REFERENCES periods(id)'],
      ['site_issues', 'import_id TEXT REFERENCES imports(id)'],
    ];
    for (const [table, col] of alters) {
      try {
        await turso.execute(`ALTER TABLE ${table} ADD COLUMN ${col}`);
      } catch {
        // column already exists — fine
      }
    }
  },
};

export default migration;
