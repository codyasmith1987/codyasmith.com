// Explicit per-(client, month, category) record of what the portal actually
// measured vs what is merely present-but-blank. The portal cannot otherwise
// tell "we measured this and it is clean (0)" apart from "we never measured
// this": free Screaming Frog exports the page list but leaves analysis columns
// blank, and the read layer collapses those NULLs into a measured zero.
//
// One row per (client_id, month, category). `measured = 1` means the
// measurement ran and produced values; `measured = 0` means present-but-
// unmeasured OR not provided. rows_total / rows_measured preserve the internal
// distinction (file present-but-blank has rows_total > 0, never provided is
// absent) and let surfaces say "measured 3 of 5 pages."
//
// Written at ingest (folded into the atomic batch for Class-A formats, on the
// standalone write path for Class-B) and reconciled by a backfill migration.
// The category matrix lives in src/lib/csv/coverage-signals.ts so ingest,
// backfill, and every reader share one definition.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '056-data-coverage',
  async up() {
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS data_coverage (
        id            TEXT PRIMARY KEY,
        client_id     TEXT NOT NULL,
        month         TEXT NOT NULL,
        category      TEXT NOT NULL,
        measured      INTEGER NOT NULL,
        rows_total    INTEGER,
        rows_measured INTEGER,
        source        TEXT,
        csv_upload_id TEXT REFERENCES csv_uploads(id),
        detected_at   TEXT DEFAULT (datetime('now')),
        UNIQUE(client_id, month, category)
      )
    `);
    await turso.execute(`
      CREATE INDEX IF NOT EXISTS idx_data_coverage_client_month
      ON data_coverage(client_id, month)
    `);
  },
};

export default migration;
