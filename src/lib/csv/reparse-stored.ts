// Reparse-stored backfill (per
// docs/superpowers/plans/2026-06-02-reparse-stored-backfill.md).
//
// Moves data sitting in raw_csv_data — files uploaded as unknown_stored
// BEFORE a parser existed — into typed tables, for ALL clients/months,
// by re-running each stored file through the CURRENT detector + ingest.
// Non-destructive (raw rows are kept), idempotent (a re-run re-detects
// and re-ingests via the standard supersede-by-key path, and the
// unknown_stored UPDATE is a WHERE error IS NULL no-op the second time),
// and chunked (the endpoint loops in small pages so each request stays
// well under Cloudflare's 100s origin window).
//
// reparseStoredChunk takes db + ingestFn as injectable params (defaulting
// to the prod turso singleton + ingestCSV) so tests can drive it with an
// in-memory libsql db and a spy ingestFn — the real ingestCSV/turso read
// import.meta.env and would fail under tsx, so they are never invoked in
// tests.

import turso from '../turso';
import { detectFormat } from './detector';
import { ingestCSV } from './index';

export interface ReparseSummary {
  processed: number;
  retyped: Array<{ filename: string; format: string; rows: number }>;
  skippedUnknown: number;
  errors: Array<{ filename: string; error: string }>;
}

// The ingest signature reparse depends on: (raw, clientId, month, filename,
// uploadedBy) -> { format, rowCount, ... }. ingestCSV satisfies this; the
// test injects a spy of the same shape.
type IngestFn = (
  raw: string,
  clientId: string,
  month: string,
  filename: string,
  uploadedBy: string,
) => Promise<{ format: string; rowCount: number; [k: string]: any }>;

export async function reparseStoredChunk(
  db: typeof turso = turso,
  // uploadedBy MUST be a real users.id: csv_uploads.uploaded_by is
  // NOT NULL REFERENCES users(id), so any literal tag (the old
  // 'reparse-backfill') fails the FK on the csv_uploads insert and the
  // whole ingest rolls back. The endpoint threads locals.user.id here.
  opts: { limit?: number; offset?: number; uploadedBy: string },
  ingestFn: IngestFn = ingestCSV,
): Promise<ReparseSummary> {
  const limit = opts.limit ?? 25;
  const offset = opts.offset ?? 0;
  const uploadedBy = opts.uploadedBy;
  const summary: ReparseSummary = {
    processed: 0,
    retyped: [],
    skippedUnknown: 0,
    errors: [],
  };

  // Stable order so chunked paging (LIMIT/OFFSET) never skips or repeats a row
  // between requests.
  const chunk = await db.execute({
    sql: `SELECT id, client_id, month, filename, raw_text, csv_upload_id
          FROM raw_csv_data
          ORDER BY created_at
          LIMIT ? OFFSET ?`,
    args: [limit, offset],
  });

  for (const row of chunk.rows as any[]) {
    const clientId = String(row.client_id);
    const month = String(row.month);
    const filename = String(row.filename);
    const rawText = String(row.raw_text ?? '');
    const csvUploadId = row.csv_upload_id == null ? null : String(row.csv_upload_id);

    summary.processed++;

    // Per-row try/catch: one bad row never stops the chunk.
    try {
      const { format } = detectFormat(rawText, filename);

      if (format === 'unknown') {
        // Still no parser for this shape — leave it in raw storage as-is.
        summary.skippedUnknown++;
        continue;
      }

      // Now typed. Run it through the standard ingest path, which writes
      // the typed table + a new csv_uploads row of the real format and
      // recomputes coverage — and self-supersedes its own prior upload by
      // key, so a re-run produces no dupes. The 'reparse-backfill' tag
      // records provenance in csv_uploads.uploaded_by.
      const result = await ingestFn(rawText, clientId, month, filename, uploadedBy);

      // ingestCSV CATCHES its own DB errors and RETURNS { error } instead of
      // throwing (FK violation, racing unique index, parser failure). If we
      // don't check this, a failed ingest gets counted as "retyped" AND the
      // raw row is superseded — the tally lies and the file vanishes from
      // unknown without its data ever landing. This is exactly what hid the
      // uploaded_by FK bug. Treat a returned error as a real failure.
      if (result.error) {
        summary.errors.push({ filename, error: result.error });
        continue;
      }

      // Supersede the OLD unknown_stored upload row so it stops showing as
      // "Stored, not yet visualized." WHERE error IS NULL makes this a
      // no-op on a re-run (the row was already marked the first time).
      if (csvUploadId) {
        await db.execute({
          sql: `UPDATE csv_uploads SET error = ? WHERE id = ? AND error IS NULL`,
          args: [`Reparsed into ${result.format}`, csvUploadId],
        });
      }

      summary.retyped.push({ filename, format: result.format, rows: result.rowCount });
    } catch (err: any) {
      summary.errors.push({ filename, error: err?.message || String(err) });
    }
  }

  return summary;
}
