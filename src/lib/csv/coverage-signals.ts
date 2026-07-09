// Single source of truth for data-coverage tracking.
//
// The portal must distinguish "we measured this and it is clean (0)" from
// "we never measured this." That distinction is stored explicitly per
// (client_id, month, category) in the data_coverage table, written at
// ingest and reconstructed by the backfill migration — never re-derived
// from NULLs at read time.
//
// This module holds the canonical matrix (category -> table, kind, signal
// columns) plus the pure helpers that compute coverage counts and build the
// upsert. Ingest, backfill, and every reader import from here so the
// definition never drifts (same lesson as the page-count SQL consolidation).
//
// Two families:
//   file-present — measured = 1 whenever the file/format was ingested this
//     month, even with zero data rows (a redirect export with no rows means
//     "we looked, there are no redirects," not "not measured").
//   signal — the file rows can be present while the actual measurement did
//     NOT run (free Screaming Frog exports the page list but leaves the
//     analysis columns blank). measured = 1 only if >=1 row has a real
//     (non-null) value in the signal column(s).

import type { Client } from '@libsql/client';
import { nanoid } from 'nanoid';

export type CoverageKind = 'file-present' | 'signal';

export interface CoverageCategory {
  category: string;
  table: string;
  kind: CoverageKind;
  dbSignalColumns?: string[];   // signal only — DB column names for the backfill SQL
  signalArgIndices?: number[];  // signal only — 0-based positions in that category's builder INSERT args
}

// detected_format -> canonical category key. Formats not listed (crawl_overview,
// image_optimization legacy metrics writers, issue_urls supplementary detail,
// unknown_stored / raw-csv catch-all) intentionally have no coverage row.
export const FORMAT_TO_CATEGORY: Record<string, string> = {
  // file-present, Class-A (folded into the atomic batch)
  crawl_internal: 'crawl',
  links: 'links',
  images: 'images',
  redirects: 'redirects',
  security_urls: 'security',
  // file-present, Class-A — unique-data SF exports (slice 2)
  canonicals: 'canonicals',
  directives: 'directives',
  page_weight: 'page_weight',
  sitemap_urls: 'sitemaps',
  // signal, Class-A
  accessibility: 'accessibility',
  structured_data_urls: 'structured_data',
  content_urls: 'content_quality',
  // file-present, standalone (Class-B) — keywords
  position_tracking: 'keywords',
  keyword_research: 'keywords',
  keyword_suggestions: 'keywords',
  // file-present, standalone — GA4
  ga4_traffic_acquisition: 'ga4',
  ga4_pages: 'ga4',
  ga4_tech: 'ga4',
  ga4_geography: 'ga4',
  ga4_reports_snapshot: 'ga4',
  // file-present, standalone — GSC
  gsc_pages: 'gsc',
  gsc_queries: 'gsc',
  gsc_countries: 'gsc',
  gsc_devices: 'gsc',
  gsc_search_appearance: 'gsc',
  gsc_chart: 'gsc',
  gsc_filters: 'gsc',
  // file-present, standalone — issues
  issues_overview: 'issues',
  site_audit: 'issues',
};

// The canonical category matrix.
//
// signalArgIndices are the 0-based positions of the DB signal columns inside
// each signal category's builder INSERT args, read straight from the builder
// column list and locked by the unit test (a wrong index fails the
// hand-counted assertion rather than silently miscounting):
//   accessibility (accessibility-urls.ts): id,client_id,csv_upload_id,month,url,
//     hostname,status_code,content_type,indexability,all_violations(9),
//     best_practice_violations(10),wcag_20a_violations(11),wcag_20aa_violations(12),
//     wcag_20aaa_violations(13),wcag_21a_violations(14),wcag_21aa_violations(15),...
//   structured_data (structured-data-urls.ts): ...error_count(6),warning_count(7),
//     rich_result_errors(8),rich_result_warnings(9),total_types(10),...
//   content_quality (content-urls.ts): ...word_count(6),sentence_count(7),
//     avg_words_per_sentence(8),flesch_reading_ease(9),readability_grade(10),
//     closest_near_duplicate_url(11),near_duplicate_count(12),...,spelling_errors(16),
//     grammar_errors(17),...
export const COVERAGE_CATEGORIES: Record<string, CoverageCategory> = {
  crawl:     { category: 'crawl',     table: 'crawl_urls',      kind: 'file-present' },
  links:     { category: 'links',     table: 'link_graph',      kind: 'file-present' },
  images:    { category: 'images',    table: 'image_urls',      kind: 'file-present' },
  redirects: { category: 'redirects', table: 'redirect_chains', kind: 'file-present' },
  security:  { category: 'security',  table: 'security_urls',   kind: 'file-present' },
  keywords:  { category: 'keywords',  table: 'keyword_rankings',kind: 'file-present' },
  ga4:       { category: 'ga4',       table: 'ga4_channels',    kind: 'file-present' },
  gsc:       { category: 'gsc',       table: 'gsc_dimensions',  kind: 'file-present' },
  issues:    { category: 'issues',    table: 'site_issues',     kind: 'file-present' },
  // Unique-data SF exports (slice 2). file-present: the columns always
  // populate when the export is provided, so a live upload means measured.
  canonicals: { category: 'canonicals', table: 'canonical_urls',  kind: 'file-present' },
  directives: { category: 'directives', table: 'directive_urls',  kind: 'file-present' },
  page_weight:{ category: 'page_weight',table: 'page_weight_urls',kind: 'file-present' },
  sitemaps:   { category: 'sitemaps',   table: 'sitemap_urls',    kind: 'file-present' },

  accessibility: {
    category: 'accessibility',
    table: 'accessibility_urls',
    kind: 'signal',
    dbSignalColumns: ['all_violations', 'best_practice_violations', 'wcag_20a_violations', 'wcag_20aa_violations', 'wcag_21aa_violations'],
    signalArgIndices: [9, 10, 11, 12, 15],
  },
  structured_data: {
    category: 'structured_data',
    table: 'structured_data_urls',
    kind: 'signal',
    dbSignalColumns: ['error_count', 'warning_count', 'total_types'],
    signalArgIndices: [6, 7, 10],
  },
  content_quality: {
    category: 'content_quality',
    table: 'content_urls',
    kind: 'signal',
    dbSignalColumns: ['flesch_reading_ease', 'spelling_errors', 'grammar_errors', 'near_duplicate_count'],
    signalArgIndices: [9, 16, 17, 12],
  },
};

// Counts coverage from the builder's ACTUAL inserted statements (the deduped,
// filtered rows — NOT a fresh re-parse of the raw CSV, which would over-count
// since the builders dedupe by URL and skip rows with no URL/hostname).
//
//   rowsTotal = statements.length
//   signal:        rowsMeasured = # statements where ANY signalArgIndices
//                  position is non-null; measured = rowsMeasured > 0
//   file-present:  rowsMeasured = rowsTotal; measured = 1 (file provided)
//
// A literal 0 in a signal position is a REAL value (a measured-clean page),
// not "unmeasured": only null/undefined means "blank / not measured."
export function coverageCountsFromStatements(
  category: string,
  statements: Array<{ sql: string; args: any[] }>,
): { rowsTotal: number; rowsMeasured: number; measured: 0 | 1 } {
  const cat = COVERAGE_CATEGORIES[category];
  if (!cat) throw new Error(`coverageCountsFromStatements: unknown category ${category}`);

  const rowsTotal = statements.length;

  if (cat.kind === 'file-present') {
    return { rowsTotal, rowsMeasured: rowsTotal, measured: 1 };
  }

  const indices = cat.signalArgIndices ?? [];
  let rowsMeasured = 0;
  for (const stmt of statements) {
    const args = stmt.args || [];
    const hasReal = indices.some(i => args[i] !== null && args[i] !== undefined);
    if (hasReal) rowsMeasured++;
  }
  return { rowsTotal, rowsMeasured, measured: rowsMeasured > 0 ? 1 : 0 };
}

// File-present convenience for the standalone (Class-B) write path, where no
// statements array is on hand — only the inserted row count. A file provided
// is measured, even with zero data rows.
export function coverageCountsFilePresent(rowCount: number): {
  rowsTotal: number; rowsMeasured: number; measured: 1;
} {
  return { rowsTotal: rowCount, rowsMeasured: rowCount, measured: 1 };
}

// Builds the atomic/standalone upsert. measured is computed by the caller and
// passed as the 5th arg; id is a fresh nanoid. source is the SQL literal
// 'csv_upload' (NOT an arg), so this returns 8 args.
export function buildCoverageUpsert(p: {
  clientId: string; month: string; category: string; uploadId: string;
  rowsTotal: number; rowsMeasured: number; measured: 0 | 1;
}): { sql: string; args: any[] } {
  const sql = `INSERT INTO data_coverage
    (id, client_id, month, category, measured, rows_total, rows_measured, source, csv_upload_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'csv_upload', ?)
    ON CONFLICT(client_id, month, category) DO UPDATE SET
      measured = excluded.measured, rows_total = excluded.rows_total,
      rows_measured = excluded.rows_measured, csv_upload_id = excluded.csv_upload_id,
      detected_at = datetime('now')`;
  const args = [
    nanoid(), p.clientId, p.month, p.category,
    p.measured, p.rowsTotal, p.rowsMeasured, p.uploadId,
  ];
  return { sql, args };
}

// Recompute coverage for ONE (client, month, category) from the TABLE STATE —
// the canonical aggregate, single-sourced for both the ingest path and the 057
// backfill so the definition never drifts.
//
// WHY aggregate, not per-file (the PR #256 fix): coverage was written per FILE
// from that file's own statements and upserted last-writer-wins. When several
// files feed one category in a month (content_quality is fed by content_all.csv
// — the file with real flesch/spelling/near-dup signal — AND by the
// internal_css/images/javascript resource lists with NO signal), a no-signal
// resource file ingesting AFTER content_all overwrote coverage to measured=0,
// so a fully-measured category read as "not measured." Reading the whole table
// for the category makes the result independent of file count and order.
//
//   signal:        rows_total = COUNT(*); rows_measured = COUNT(rows where ANY
//                  dbSignalColumn IS NOT NULL); measured = rows_measured > 0.
//   file-present:  rows_total = rows_measured = COUNT(*) in the table; measured
//                  = 1 (a live upload exists because we just ingested one — the
//                  file was provided, even with zero data rows).
//
// This performs its own SELECT then upsert (it READS the table), so it must NOT
// run inside an atomic libsql write-batch — call it AFTER the batch commits.
// source/uploadId are parameterized: ingest passes ('csv_upload', uploadId),
// the 057 backfill passes ('backfill', null).
export async function recomputeCategoryCoverage(
  db: Client,
  clientId: string,
  month: string,
  category: string,
  source: 'csv_upload' | 'backfill',
  uploadId: string | null,
): Promise<void> {
  const cat = COVERAGE_CATEGORIES[category];
  if (!cat) throw new Error(`recomputeCategoryCoverage: unknown category ${category}`);

  let rowsTotal = 0;
  let rowsMeasured = 0;
  let measured: 0 | 1;

  if (cat.kind === 'file-present') {
    const res = await db.execute({
      sql: `SELECT COUNT(*) AS cnt FROM ${cat.table} WHERE client_id = ? AND month = ?`,
      args: [clientId, month],
    });
    rowsTotal = Number(res.rows[0]?.cnt) || 0;
    rowsMeasured = rowsTotal;
    measured = 1; // a live upload exists (we just ingested one) -> file provided
  } else {
    const cols = cat.dbSignalColumns ?? [];
    const realPredicate = cols.map(c => `${c} IS NOT NULL`).join(' OR ');
    const res = await db.execute({
      sql: `SELECT COUNT(*) AS total,
                   SUM(CASE WHEN ${realPredicate} THEN 1 ELSE 0 END) AS measured_rows
            FROM ${cat.table} WHERE client_id = ? AND month = ?`,
      args: [clientId, month],
    });
    rowsTotal = Number(res.rows[0]?.total) || 0;
    rowsMeasured = Number(res.rows[0]?.measured_rows) || 0;
    measured = rowsMeasured > 0 ? 1 : 0;
  }

  const sql = `INSERT INTO data_coverage
    (id, client_id, month, category, measured, rows_total, rows_measured, source, csv_upload_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(client_id, month, category) DO UPDATE SET
      measured = excluded.measured, rows_total = excluded.rows_total,
      rows_measured = excluded.rows_measured, source = excluded.source,
      csv_upload_id = excluded.csv_upload_id, detected_at = datetime('now')`;
  await db.execute({
    sql,
    args: [nanoid(), clientId, month, category, measured, rowsTotal, rowsMeasured, source, uploadId],
  });
}
