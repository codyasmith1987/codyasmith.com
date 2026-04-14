// Phase 1 Step 4b — snapshot-based ingestion.
//
// Replaces the old clearPreviousData + plain INSERT flow with a path that
// is idempotent by construction:
//
//   1. content_hash = sha256(raw)
//   2. Resolve or create the `periods` row for (client_id, month)
//   3. Detect format (dispatches to a staging parser that only parses)
//   4. INSERT imports row with status='pending'. If the UNIQUE
//      (client_id, period_id, source, content_hash) throws, the exact
//      same bytes were already applied — return a 'noop' result.
//   5. Open a transaction:
//        a. DELETE FROM <snapshot_table> WHERE (client_id, period_id, source)
//        b. INSERT staged rows with the new import_id
//        c. UPDATE imports SET status='applied', row_count=N, finished_at=now
//        d. COMMIT
//   6. On any failure, UPDATE imports SET status='failed', error=msg.
//
// This path is currently wired for position_tracking only. Other formats
// still go through the legacy src/lib/csv/index.ts path until Step 4b-ii
// converts them. The two paths are intentionally separate so the migration
// can be tested one format at a time.

import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import turso from '../turso';
import { detectFormat, type CsvFormat } from './detector';
import type { ParseResult } from './types';
import { csvFormatToDataSourceKind, touchBindingsForClient } from '../data-sources';
import { isPeriodLocked, getPeriodById } from '../periods';
import { logger } from '../logger';
import { parsePositionTrackingV2 } from './parsers/position-tracking';
import { parseKeywordResearchV2 } from './parsers/keyword-research';
import { parseKeywordSuggestionsV2 } from './parsers/keyword-suggestions';
import { parseIssuesOverviewV2 } from './parsers/issues-overview';
import { parseCrawlOverviewV2 } from './parsers/crawl-overview';
import { parseImageOptimizationV2 } from './parsers/image-optimization';
import { parseSiteAuditV2 } from './parsers/site-audit';
import { parseAccessibilityV2 } from './parsers/accessibility';

// Snapshot target per format. All 8 parsers now supported by ingest-v2.
const SNAPSHOT_TARGET: Partial<Record<CsvFormat, { tables: Array<'keyword_snapshots' | 'issue_snapshots' | 'metric_snapshots'> }>> = {
  position_tracking: { tables: ['keyword_snapshots'] },
  keyword_research: { tables: ['keyword_snapshots'] },
  keyword_suggestions: { tables: ['keyword_snapshots'] },
  issues_overview: { tables: ['issue_snapshots', 'metric_snapshots'] },
  crawl_overview: { tables: ['metric_snapshots'] },
  image_optimization: { tables: ['metric_snapshots'] },
  site_audit: { tables: ['issue_snapshots'] },
  accessibility: { tables: ['metric_snapshots'] },
};

// Which formats the v2 path owns today. Upload routing code can consult this.
export function isV2Format(format: string): boolean {
  return format in SNAPSHOT_TARGET;
}

export type IngestStatus = 'applied' | 'noop' | 'failed';

export interface IngestV2Result {
  importId: string;
  format: CsvFormat;
  status: IngestStatus;
  rowCount: number;
  contentHash: string;
  periodId: string;
  error?: string;
  headers?: string[];
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function monthToPeriodDates(month: string): { start: string; end: string } {
  const [y, m] = month.split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) throw new Error(`Invalid month: ${month}`);
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const end = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { start, end };
}

async function ensurePeriod(clientId: string, month: string): Promise<string> {
  const { start, end } = monthToPeriodDates(month);
  const existing = await turso.execute({
    sql: "SELECT id FROM periods WHERE client_id = ? AND period_type = 'month' AND period_start = ?",
    args: [clientId, start],
  });
  if (existing.rows.length > 0) return existing.rows[0][0] as string;
  const id = nanoid();
  await turso.execute({
    sql: `INSERT INTO periods (id, client_id, period_type, period_start, period_end)
          VALUES (?, ?, 'month', ?, ?)`,
    args: [id, clientId, start, end],
  });
  return id;
}

function dispatchParser(format: CsvFormat, raw: string, filename: string): ParseResult {
  switch (format) {
    case 'position_tracking':
      return parsePositionTrackingV2(raw);
    case 'keyword_research':
      return parseKeywordResearchV2(raw);
    case 'keyword_suggestions':
      return parseKeywordSuggestionsV2(raw);
    case 'issues_overview':
      return parseIssuesOverviewV2(raw);
    case 'crawl_overview':
      return parseCrawlOverviewV2(raw);
    case 'image_optimization':
      return parseImageOptimizationV2(raw);
    case 'site_audit':
      return parseSiteAuditV2(raw, filename);
    case 'accessibility':
      return parseAccessibilityV2(raw);
    default:
      throw new Error(`ingest-v2 has no parser for format ${format}`);
  }
}

export async function ingestCSVViaSnapshots(
  raw: string,
  clientId: string,
  month: string,
  filename: string,
  uploadedBy: string
): Promise<IngestV2Result> {
  const { format, headers } = detectFormat(raw, filename);
  const contentHash = sha256Hex(raw);

  if (!SNAPSHOT_TARGET[format]) {
    // Caller should have routed to the legacy path; surface the error cleanly.
    return {
      importId: '',
      format,
      status: 'failed',
      rowCount: 0,
      contentHash,
      periodId: '',
      headers,
      error: `Format ${format} not supported by ingest-v2`,
    };
  }

  // Period must be resolved before we can look up / insert imports.
  const periodId = await ensurePeriod(clientId, month);

  // Slice 16 — period lock guard. Any write path that mutates
  // snapshots for this period must fail closed when the period is
  // locked, so mis-dated re-uploads can't silently change a month
  // that's already been reported. The import row IS still recorded
  // as 'failed' so the admin queue's "Failed imports" section
  // surfaces the attempt — zero silent drops.
  if (await isPeriodLocked(periodId)) {
    const period = await getPeriodById(periodId);
    const errorMsg = `period ${period?.period_start ?? periodId} is locked since ${period?.locked_at ?? 'unknown'}`;
    const importId = nanoid();
    try {
      await turso.execute({
        sql: `INSERT INTO imports
              (id, client_id, period_id, source, original_name, content_hash, status, row_count, uploaded_by, error, finished_at)
              VALUES (?, ?, ?, ?, ?, ?, 'failed', 0, ?, ?, datetime('now'))`,
        args: [
          importId,
          clientId,
          periodId,
          format,
          filename,
          contentHash,
          uploadedBy,
          errorMsg,
        ],
      });
    } catch (insertErr) {
      // If the failed-import row insert collides with an existing
      // (client, period, source, content_hash) it's a benign dupe —
      // someone tried the same locked attempt twice. Swallow and
      // continue returning the lock error.
      logger.warn('failed to record locked-period ingest attempt', {
        error: String((insertErr as Error)?.message ?? insertErr),
      });
    }
    return {
      importId,
      format,
      status: 'failed',
      rowCount: 0,
      contentHash,
      periodId,
      headers,
      error: errorMsg,
    };
  }

  // Check if this exact bytes/source/period combo has already been applied.
  const existing = await turso.execute({
    sql: `SELECT id, status FROM imports
          WHERE client_id = ? AND period_id = ? AND source = ? AND content_hash = ?`,
    args: [clientId, periodId, format, contentHash],
  });
  if (existing.rows.length > 0) {
    const existingImportId = existing.rows[0][0] as string;
    const existingStatus = existing.rows[0][1] as string;
    // Previous applied run of the same bytes → this is a no-op.
    if (existingStatus === 'applied') {
      return {
        importId: existingImportId,
        format,
        status: 'noop',
        rowCount: 0,
        contentHash,
        periodId,
        headers,
      };
    }
    // Any other prior status (failed, pending, superseded) — don't retry
    // automatically; a new attempt would race the stale row. Return failed.
    return {
      importId: existingImportId,
      format,
      status: 'failed',
      rowCount: 0,
      contentHash,
      periodId,
      headers,
      error: `An earlier import with the same content_hash exists in status "${existingStatus}". Resolve it before re-uploading.`,
    };
  }

  // Insert pending import.
  const importId = nanoid();
  await turso.execute({
    sql: `INSERT INTO imports
          (id, client_id, period_id, source, original_name, content_hash, status, row_count, uploaded_by)
          VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
    args: [importId, clientId, periodId, format, filename, contentHash, uploadedBy],
  });

  // Parse to staging.
  let staged: ParseResult;
  try {
    staged = dispatchParser(format, raw, filename);
  } catch (err: any) {
    await turso.execute({
      sql: `UPDATE imports SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?`,
      args: [String(err?.message ?? err), importId],
    });
    return { importId, format, status: 'failed', rowCount: 0, contentHash, periodId, headers, error: String(err?.message ?? err) };
  }

  const keywordRows = staged.keywords ?? [];
  const issueRows = staged.issues ?? [];
  const metricRows = staged.metrics ?? [];
  const rowCount = keywordRows.length + issueRows.length + metricRows.length;

  // Transactional replace.
  const tx = await turso.transaction('write');
  try {
    const target = SNAPSHOT_TARGET[format]!;

    if (target.tables.includes('keyword_snapshots')) {
      await tx.execute({
        sql: `DELETE FROM keyword_snapshots WHERE client_id = ? AND period_id = ? AND source = ?`,
        args: [clientId, periodId, format],
      });
      for (const k of keywordRows) {
        await tx.execute({
          sql: `INSERT INTO keyword_snapshots
                (id, client_id, period_id, import_id, source, keyword, position, search_volume, url, change_val, seo_difficulty)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            nanoid(),
            clientId,
            periodId,
            importId,
            format,
            k.keyword,
            k.position,
            k.search_volume,
            k.url,
            k.change_val,
            k.seo_difficulty,
          ],
        });
      }
    }

    if (target.tables.includes('issue_snapshots')) {
      await tx.execute({
        sql: `DELETE FROM issue_snapshots WHERE client_id = ? AND period_id = ? AND source = ?`,
        args: [clientId, periodId, format],
      });
      for (const i of issueRows) {
        await tx.execute({
          sql: `INSERT INTO issue_snapshots
                (id, client_id, period_id, import_id, source, issue_name, issue_type, priority, affected_urls, pct_of_total, description, how_to_fix)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            nanoid(),
            clientId,
            periodId,
            importId,
            format,
            i.issue_name,
            i.issue_type,
            i.priority,
            i.affected_urls,
            i.pct_of_total,
            i.description,
            i.how_to_fix,
          ],
        });
      }
    }

    if (target.tables.includes('metric_snapshots')) {
      // Metric replace is by (period, category, metric_key) — drop everything
      // from this (period, source) and re-insert.
      await tx.execute({
        sql: `DELETE FROM metric_snapshots WHERE client_id = ? AND period_id = ? AND source = ?`,
        args: [clientId, periodId, format],
      });
      for (const m of metricRows) {
        await tx.execute({
          sql: `INSERT INTO metric_snapshots
                (id, client_id, period_id, import_id, category, metric_key, metric_value, source)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [nanoid(), clientId, periodId, importId, m.category, m.metric_key, m.metric_value, format],
        });
      }
    }

    await tx.execute({
      sql: `UPDATE imports
            SET status = 'applied', row_count = ?, finished_at = datetime('now')
            WHERE id = ?`,
      args: [rowCount, importId],
    });
    await tx.commit();
  } catch (err: any) {
    await tx.rollback();
    await turso.execute({
      sql: `UPDATE imports SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?`,
      args: [String(err?.message ?? err), importId],
    });
    return { importId, format, status: 'failed', rowCount: 0, contentHash, periodId, headers, error: String(err?.message ?? err) };
  }

  // Post-commit: stamp the data_source_bindings heartbeat for every
  // contract under this client that declared the matching kind. This
  // deliberately runs OUTSIDE the ingest transaction — a touch failure
  // must not roll back a successful import, and a client with no
  // declared bindings is a completely valid state (touch count = 0).
  const boundKind = csvFormatToDataSourceKind(format);
  if (boundKind) {
    try {
      await touchBindingsForClient(clientId, boundKind);
    } catch (err) {
      logger.warn('touchBindingsForClient failed after successful ingest', {
        error: String((err as Error)?.message ?? err),
        clientId,
        format,
        kind: boundKind,
      });
    }
  }

  return { importId, format, status: 'applied', rowCount, contentHash, periodId, headers };
}
