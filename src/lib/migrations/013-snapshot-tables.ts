// Phase 1 Step 4a — canonical snapshot tables.
//
// Replaces `metrics`, `keyword_rankings`, `site_issues` as the read model
// for everything that hangs off a period. Legacy tables remain for
// backwards compatibility during the cutover in Step 4c.
//
// Every snapshot row is tied to a (period_id, import_id) and always
// carries a `source` string. The UNIQUE constraint per table is the
// actual idempotency guarantee the ingestion rewrite will rely on:
//
//   metric_snapshots: one row per (client_id, period_id, category, metric_key)
//   keyword_snapshots: one row per (client_id, period_id, source, keyword)
//   issue_snapshots:  one row per (client_id, period_id, source, issue_name)
//
// metric_snapshots intentionally omits `source` from the unique key to
// match the original `metrics` table semantics — only one source should
// ever write a given (category, metric_key).
//
// None of the existing data is moved by this migration; the applier
// script handles backfill so it can dry-run and report counts.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '013-snapshot-tables',
  async up() {
    await turso.batch(
      [
        `CREATE TABLE IF NOT EXISTS metric_snapshots (
          id TEXT PRIMARY KEY,
          client_id TEXT NOT NULL REFERENCES clients(id),
          period_id TEXT NOT NULL REFERENCES periods(id),
          import_id TEXT NOT NULL REFERENCES imports(id),
          category TEXT NOT NULL,
          metric_key TEXT NOT NULL,
          metric_value REAL NOT NULL,
          source TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now')),
          UNIQUE(client_id, period_id, category, metric_key)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_metric_snapshots_period ON metric_snapshots(client_id, period_id)`,
        `CREATE INDEX IF NOT EXISTS idx_metric_snapshots_cat ON metric_snapshots(client_id, period_id, category)`,
        `CREATE TABLE IF NOT EXISTS keyword_snapshots (
          id TEXT PRIMARY KEY,
          client_id TEXT NOT NULL REFERENCES clients(id),
          period_id TEXT NOT NULL REFERENCES periods(id),
          import_id TEXT NOT NULL REFERENCES imports(id),
          source TEXT NOT NULL,
          keyword TEXT NOT NULL,
          position INTEGER,
          search_volume INTEGER,
          url TEXT,
          change_val INTEGER,
          seo_difficulty INTEGER,
          created_at TEXT DEFAULT (datetime('now')),
          UNIQUE(client_id, period_id, source, keyword)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_keyword_snapshots_period ON keyword_snapshots(client_id, period_id)`,
        `CREATE INDEX IF NOT EXISTS idx_keyword_snapshots_source ON keyword_snapshots(client_id, period_id, source)`,
        `CREATE TABLE IF NOT EXISTS issue_snapshots (
          id TEXT PRIMARY KEY,
          client_id TEXT NOT NULL REFERENCES clients(id),
          period_id TEXT NOT NULL REFERENCES periods(id),
          import_id TEXT NOT NULL REFERENCES imports(id),
          source TEXT NOT NULL,
          issue_name TEXT NOT NULL,
          issue_type TEXT,
          priority TEXT,
          affected_urls INTEGER,
          pct_of_total REAL,
          description TEXT,
          how_to_fix TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          UNIQUE(client_id, period_id, source, issue_name)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_issue_snapshots_period ON issue_snapshots(client_id, period_id)`,
      ],
      'write'
    );
  },
};

export default migration;
