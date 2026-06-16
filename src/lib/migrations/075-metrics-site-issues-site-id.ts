// Per-site keying for the aggregate tables `metrics` and `site_issues`
// (multi-site Phase 1 completion, 2026-06-15).
//
// Problem proven on prod: both tables upsert on a (client_id, month, key) that
// has NO site dimension. metrics keys on (client_id, month, category,
// metric_key); site_issues on (client_id, month, issue_name). For a multi-site
// client (Zip Kit Homes = zipkithomes.com [primary] + mountainvalleyprefab.com
// [secondary]), the secondary site's crawl_overview writes the SAME generic
// metric_keys as the primary's, so its ON CONFLICT DO UPDATE OVERWRITES the
// primary's metric rows and re-points csv_upload_id to the secondary's upload.
// Because every read scopes by csv_upload_id -> site (site-scope.ts), the
// primary's overwritten metrics vanish from its own dashboard. Confirmed: ~35
// of ~36 ZipKit/2026-06 metric categories now belong to the MVP upload.
//
// Fix: add site_id to both tables and make uniqueness per-site via
// COALESCE(site_id,'') (the migration-070 trick so two NULL/primary rows still
// collide and supersede, while a secondary site's rows coexist instead of
// clobbering). After this deploys, re-uploading the primary's scrape restores
// its metrics under its own site_id with no collision.
//
// metrics carries an INLINE UNIQUE (migration 001) that cannot be dropped in
// place, so its table is rebuilt once (it is small and a leaf -- nothing
// FK-references it). site_issues has a NAMED unique index (migration 058), so
// it only needs a column + an index swap. Both steps are idempotent.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '075-metrics-site-issues-site-id',
  async up() {
    // ---- metrics: rebuild to add site_id + per-site uniqueness ----
    const cols = await turso.execute(`PRAGMA table_info(metrics)`);
    const hasSite = new Set((cols.rows as any[]).map(r => String(r[1]))).has('site_id');
    if (!hasSite) {
      // Clean any partial prior attempt, then rebuild atomically so no request
      // ever observes a missing metrics table mid-swap.
      await turso.execute(`DROP TABLE IF EXISTS metrics_rebuild`);
      await turso.batch([
        `CREATE TABLE metrics_rebuild (
          id TEXT PRIMARY KEY,
          client_id TEXT NOT NULL REFERENCES clients(id),
          month TEXT NOT NULL,
          category TEXT NOT NULL,
          metric_key TEXT NOT NULL,
          metric_value REAL NOT NULL,
          source TEXT,
          csv_upload_id TEXT REFERENCES csv_uploads(id),
          site_id TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )`,
        // Copy every row, backfilling site_id from the owning upload
        // (NULL = primary, consistent with csv_uploads / uploadScopeFragment).
        `INSERT INTO metrics_rebuild (id, client_id, month, category, metric_key, metric_value, source, csv_upload_id, site_id, created_at)
         SELECT m.id, m.client_id, m.month, m.category, m.metric_key, m.metric_value, m.source, m.csv_upload_id,
                (SELECT u.site_id FROM csv_uploads u WHERE u.id = m.csv_upload_id),
                m.created_at
         FROM metrics m`,
        `DROP TABLE metrics`,
        `ALTER TABLE metrics_rebuild RENAME TO metrics`,
        // Recreate the two non-unique read indexes (migration 002).
        `CREATE INDEX IF NOT EXISTS idx_metrics_client_month ON metrics(client_id, month)`,
        `CREATE INDEX IF NOT EXISTS idx_metrics_client_month_cat ON metrics(client_id, month, category)`,
        // The new per-site unique index backing the parsers' ON CONFLICT upsert.
        `CREATE UNIQUE INDEX IF NOT EXISTS ux_metrics_site ON metrics(client_id, month, category, metric_key, COALESCE(site_id, ''))`,
      ], 'write');
    }

    // ---- site_issues: add site_id + per-site uniqueness (no rebuild) ----
    const siCols = await turso.execute(`PRAGMA table_info(site_issues)`);
    if (!new Set((siCols.rows as any[]).map(r => String(r[1]))).has('site_id')) {
      await turso.execute(`ALTER TABLE site_issues ADD COLUMN site_id TEXT`);
      await turso.execute(
        `UPDATE site_issues
            SET site_id = (SELECT u.site_id FROM csv_uploads u WHERE u.id = site_issues.csv_upload_id)
          WHERE site_id IS NULL`,
      );
    }
    // Create the new per-site unique index BEFORE dropping the old one so the
    // parsers' ON CONFLICT upsert never has a window with no backing index.
    await turso.execute(
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_site_issues_name_site ON site_issues(client_id, month, issue_name, COALESCE(site_id, ''))`,
    );
    await turso.execute(`DROP INDEX IF EXISTS ux_site_issues_name`);
  },
};

export default migration;
