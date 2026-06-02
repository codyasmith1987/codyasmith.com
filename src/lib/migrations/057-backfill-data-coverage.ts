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
import { nanoid } from 'nanoid';
import turso from '../turso';
import type { Migration } from '../migrate';
import { COVERAGE_CATEGORIES, FORMAT_TO_CATEGORY } from '../csv/coverage-signals';

// Invert FORMAT_TO_CATEGORY -> the set of detected_format values that feed each
// category, so the file-present csv_uploads UNION stays sourced from the one
// canonical matrix.
function formatsForCategory(category: string): string[] {
  return Object.entries(FORMAT_TO_CATEGORY)
    .filter(([, cat]) => cat === category)
    .map(([fmt]) => fmt);
}

// The backfill upsert. source = 'backfill', csv_upload_id = NULL. Same
// ON CONFLICT(client_id, month, category) clause as the ingest upsert, so the
// two paths reconcile to the same unique key.
const UPSERT_SQL = `INSERT INTO data_coverage
    (id, client_id, month, category, measured, rows_total, rows_measured, source, csv_upload_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'backfill', NULL)
    ON CONFLICT(client_id, month, category) DO UPDATE SET
      measured = excluded.measured, rows_total = excluded.rows_total,
      rows_measured = excluded.rows_measured, source = 'backfill',
      csv_upload_id = NULL, detected_at = datetime('now')`;

function upsertArgs(p: {
  clientId: string; month: string; category: string;
  measured: 0 | 1; rowsTotal: number; rowsMeasured: number;
}): any[] {
  return [nanoid(), p.clientId, p.month, p.category, p.measured, p.rowsTotal, p.rowsMeasured];
}

// Recompute coverage for every existing (client_id, month, category). Exported
// so the in-memory test can exercise the exact logic up() runs against turso.
export async function backfillCoverage(db: Client): Promise<void> {
  for (const cat of Object.values(COVERAGE_CATEGORIES)) {
    if (cat.kind === 'file-present') {
      // Union of (client, month) seen in the data table OR in a live upload for
      // any format feeding this category. LEFT JOIN the per-pair table count so
      // a 0-row upload yields rows_total = 0, measured = 1 still.
      const formats = formatsForCategory(cat.category);
      const placeholders = formats.map(() => '?').join(', ');
      const sql = `
        WITH pairs AS (
          SELECT DISTINCT client_id, month FROM ${cat.table}
          UNION
          SELECT DISTINCT client_id, month FROM csv_uploads
            WHERE error IS NULL AND detected_format IN (${placeholders})
        )
        SELECT p.client_id AS client_id, p.month AS month,
               (SELECT COUNT(*) FROM ${cat.table} t
                  WHERE t.client_id = p.client_id AND t.month = p.month) AS cnt
        FROM pairs p`;
      const res = await db.execute({ sql, args: formats });
      for (const row of res.rows) {
        const clientId = row.client_id as string;
        const month = row.month as string;
        const count = Number(row.cnt) || 0;
        await db.execute({
          sql: UPSERT_SQL,
          args: upsertArgs({
            clientId, month, category: cat.category,
            measured: 1, rowsTotal: count, rowsMeasured: count,
          }),
        });
      }
    } else {
      // Signal category: per (client, month) with rows in the table, count rows
      // with ANY real (non-NULL) signal value. measured = rows_measured > 0.
      const cols = cat.dbSignalColumns ?? [];
      const realPredicate = cols.map(c => `${c} IS NOT NULL`).join(' OR ');
      const sql = `
        SELECT client_id AS client_id, month AS month,
               COUNT(*) AS total,
               SUM(CASE WHEN ${realPredicate} THEN 1 ELSE 0 END) AS measured_rows
        FROM ${cat.table}
        GROUP BY client_id, month`;
      const res = await db.execute(sql);
      for (const row of res.rows) {
        const clientId = row.client_id as string;
        const month = row.month as string;
        const rowsTotal = Number(row.total) || 0;
        const rowsMeasured = Number(row.measured_rows) || 0;
        await db.execute({
          sql: UPSERT_SQL,
          args: upsertArgs({
            clientId, month, category: cat.category,
            measured: rowsMeasured > 0 ? 1 : 0, rowsTotal, rowsMeasured,
          }),
        });
      }
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
