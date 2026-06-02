// Backfill data_coverage for every existing (client_id, month, category).
//
// data_coverage (migration 056) is written at ingest going forward, but
// historical uploads predate it. This migration reconstructs an honest
// coverage record for them using the SAME matrix as ingest
// (src/lib/csv/coverage-signals.ts), so the definition never drifts:
//
//   file-present categories: the set of (client_id, month) is the rows present
//     in the table UNION the live csv_uploads rows whose detected_format feeds
//     the category — so a clean 0-row upload still records measured = 1 ("we
//     looked, there was nothing," not "not measured"). rows_total =
//     rows_measured = COUNT(*) in the table; measured = 1.
//
//   signal categories: for each (client_id, month) with rows in the table,
//     rows_total = COUNT(*), rows_measured = COUNT(*) WHERE any signal column
//     IS NOT NULL, measured = rows_measured > 0. This is what corrects F3's
//     free-Screaming-Frog accessibility from a fabricated "0 violations" to an
//     honest "not measured."
//
// Idempotent: upsert on UNIQUE(client_id, month, category), so re-running the
// migration recomputes in place rather than duplicating. Rows written here
// carry source = 'backfill' and csv_upload_id = NULL (no single originating
// upload), distinct from the ingest path's source = 'csv_upload'.

import type { Client } from '@libsql/client';
import turso from '../turso';
import type { Migration } from '../migrate';
import {
  COVERAGE_CATEGORIES,
  FORMAT_TO_CATEGORY,
  recomputeCategoryCoverage,
} from '../csv/coverage-signals';

// Invert FORMAT_TO_CATEGORY -> the set of detected_format values that feed each
// category, so the file-present csv_uploads UNION stays sourced from the one
// canonical matrix.
function formatsForCategory(category: string): string[] {
  return Object.entries(FORMAT_TO_CATEGORY)
    .filter(([, cat]) => cat === category)
    .map(([fmt]) => fmt);
}

// Recompute coverage for every existing (client_id, month, category). Exported
// so the in-memory test can exercise the exact logic up() runs against turso.
//
// The per-(client, month, category) count + upsert is delegated to the shared
// recomputeCategoryCoverage helper so the coverage DEFINITION lives in exactly
// one place (the same single-sourcing lesson as the page-count SQL). This
// migration only enumerates which (client, month) pairs to recompute for each
// category; recomputeCategoryCoverage does the table-state aggregate and the
// upsert. Rows written here carry source = 'backfill', csv_upload_id = NULL.
export async function backfillCoverage(db: Client): Promise<void> {
  for (const cat of Object.values(COVERAGE_CATEGORIES)) {
    let pairs: Array<{ clientId: string; month: string }>;

    if (cat.kind === 'file-present') {
      // Union of (client, month) seen in the data table OR in a live upload for
      // any format feeding this category, so a 0-row upload still records
      // measured = 1 ("we looked, there was nothing").
      const formats = formatsForCategory(cat.category);
      const placeholders = formats.map(() => '?').join(', ');
      const sql = `
        SELECT DISTINCT client_id AS client_id, month AS month FROM ${cat.table}
        UNION
        SELECT DISTINCT client_id AS client_id, month AS month FROM csv_uploads
          WHERE error IS NULL AND detected_format IN (${placeholders})`;
      const res = await db.execute({ sql, args: formats });
      pairs = res.rows.map(r => ({ clientId: r.client_id as string, month: r.month as string }));
    } else {
      // Signal category: only (client, month) pairs that actually have rows in
      // the table (absence of rows == not provided -> no coverage row).
      const sql = `SELECT DISTINCT client_id AS client_id, month AS month FROM ${cat.table}`;
      const res = await db.execute(sql);
      pairs = res.rows.map(r => ({ clientId: r.client_id as string, month: r.month as string }));
    }

    for (const { clientId, month } of pairs) {
      await recomputeCategoryCoverage(db, clientId, month, cat.category, 'backfill', null);
    }
  }
}

const migration: Migration = {
  id: '057-backfill-data-coverage',
  async up() {
    await backfillCoverage(turso);
  },
};

export default migration;
