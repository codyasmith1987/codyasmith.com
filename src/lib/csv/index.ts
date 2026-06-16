import { nanoid } from 'nanoid';
import turso from '../turso';
import { detectFormat, type CsvFormat } from './detector';
import { parse as parsePositionTracking } from './parsers/position-tracking';
import { parse as parseIssuesOverview } from './parsers/issues-overview';
import { parse as parseCrawlOverview } from './parsers/crawl-overview';
import { buildCrawlInternalStatements } from './parsers/crawl-internal';
import { buildRedirectsStatements } from './parsers/redirects';
import { buildImagesStatements } from './parsers/images';
import { buildContentUrlsStatements } from './parsers/content-urls';
import { buildSecurityUrlsStatements } from './parsers/security-urls';
import { buildStructuredDataUrlsStatements } from './parsers/structured-data-urls';
import { buildAccessibilityUrlsStatements } from './parsers/accessibility-urls';
import { buildCanonicalUrlsStatements } from './parsers/canonical-urls';
import { buildDirectiveUrlsStatements } from './parsers/directive-urls';
import { buildPageWeightUrlsStatements } from './parsers/page-weight-urls';
import { buildSitemapUrlsStatements } from './parsers/sitemap-urls';
import { buildJavascriptUrlsStatements } from './parsers/javascript-urls';
import { buildUrlStructureUrlsStatements } from './parsers/url-structure-urls';
import { buildHreflangUrlsStatements } from './parsers/hreflang-urls';
import { parse as parseImageOptimization } from './parsers/image-optimization';
import { parse as parseKeywordResearch } from './parsers/keyword-research';
import { parse as parseKeywordSuggestions } from './parsers/keyword-suggestions';
import { parse as parseSiteAudit } from './parsers/site-audit';
import { parse as parseAccessibility } from './parsers/accessibility';
import { parse as parseIssueUrls } from './parsers/issue-urls';
import { parse as parseRawCsv } from './parsers/raw-csv';
import { parse as parseSfGeneric } from './parsers/sf-generic';
import { parse as parseLinks } from './parsers/links';
import { parseGa4 } from './parsers/ga4';
import { parseGsc } from './parsers/gsc';
import {
  FORMAT_TO_CATEGORY,
  recomputeCategoryCoverage,
} from './coverage-signals';

// Maps CSV formats to the source tags they write, so we can clear old data before re-importing
const FORMAT_SOURCES: Record<string, { tables: string[]; source: string }> = {
  position_tracking: { tables: ['keyword_rankings'], source: 'position_tracking' },
  keyword_research: { tables: ['keyword_rankings'], source: 'keyword_research' },
  keyword_suggestions: { tables: ['keyword_rankings'], source: 'keyword_suggestions' },
  issues_overview: { tables: ['site_issues', 'metrics'], source: 'issues_overview' },
  crawl_overview: { tables: ['metrics'], source: 'crawl_overview' },
  crawl_internal: { tables: ['crawl_urls'], source: 'crawl_internal' },
  redirects: { tables: ['redirect_chains'], source: 'redirects' },
  images: { tables: ['image_urls'], source: 'images' },
  content_urls: { tables: ['content_urls'], source: 'content_urls' },
  security_urls: { tables: ['security_urls'], source: 'security_urls' },
  structured_data_urls: { tables: ['structured_data_urls'], source: 'structured_data_urls' },
  // Unique-data SF exports (slice 2). Each maps 1:1 to its own per-URL
  // table; listed here so the supersede sweep clears the prior upload's
  // rows for the same (client, month, format, original_name) key.
  canonicals: { tables: ['canonical_urls'], source: 'canonicals' },
  directives: { tables: ['directive_urls'], source: 'directives' },
  page_weight: { tables: ['page_weight_urls'], source: 'page_weight' },
  sitemap_urls: { tables: ['sitemap_urls'], source: 'sitemap_urls' },
  // Rich per-URL "_all" reports (slice 3). Each maps 1:1 to its typed table;
  // listed so the supersede sweep clears the prior upload's rows on re-import.
  javascript: { tables: ['javascript_urls'], source: 'javascript' },
  url_structure: { tables: ['url_structure_urls'], source: 'url_structure' },
  hreflang: { tables: ['hreflang_urls'], source: 'hreflang' },
  image_optimization: { tables: ['metrics'], source: 'image_optimization' },
  site_audit: { tables: ['site_issues'], source: 'site_audit' },
  accessibility: { tables: ['metrics', 'accessibility_urls'], source: 'accessibility' },
  // issue_urls deliberately OMITTED. Multiple per-issue SF CSVs
  // (h1_missing.csv, h2_missing.csv, security_missing_hsts_header.csv,
  // etc.) all share detected_format='issue_urls', so a format-level
  // sweep would have the second per-issue upload wipe the first's
  // rows in the same batch. The issue-urls parser handles its own
  // dedup by issue_name (DELETE WHERE issue_name = ...), which is
  // the right key — re-uploading h1_missing.csv replaces only the
  // H1: Missing rows and leaves h2_missing.csv's data alone.
  // GA4 exports. Reports snapshot fans out to multiple tables; the
  // others map 1:1. Listed individually so the supersede sweep
  // clears the right rows on re-upload (a fresh Reports snapshot
  // should wipe last cycle's topline + source_medium + campaigns).
  ga4_reports_snapshot: { tables: ['ga4_topline', 'ga4_source_medium', 'ga4_campaigns'], source: 'ga4_reports_snapshot' },
  ga4_traffic_acquisition: { tables: ['ga4_channels'], source: 'ga4_traffic_acquisition' },
  ga4_pages: { tables: ['ga4_pages'], source: 'ga4_pages' },
  ga4_tech: { tables: ['ga4_tech'], source: 'ga4_tech' },
  ga4_geography: { tables: ['ga4_geography'], source: 'ga4_geography' },
  // GSC exports. The dimension kinds all hit gsc_dimensions but
  // listing them individually keeps the supersede sweep matched on
  // each kind separately (re-uploading Queries.csv should NOT wipe
  // Pages.csv rows).
  gsc_pages: { tables: ['gsc_dimensions'], source: 'gsc_pages' },
  gsc_queries: { tables: ['gsc_dimensions'], source: 'gsc_queries' },
  gsc_countries: { tables: ['gsc_dimensions'], source: 'gsc_countries' },
  gsc_devices: { tables: ['gsc_dimensions'], source: 'gsc_devices' },
  gsc_search_appearance: { tables: ['gsc_dimensions'], source: 'gsc_search_appearance' },
  gsc_chart: { tables: ['gsc_chart'], source: 'gsc_chart' },
  gsc_filters: { tables: ['gsc_filters'], source: 'gsc_filters' },
  // unknown_stored deliberately OMITTED. Same reasoning as
  // issue_urls: many distinct filenames (validation_all.csv,
  // ai_all.csv, mobile_all.csv, etc.) all share
  // detected_format='unknown_stored', so a format-level sweep would
  // have the second unknown upload wipe the first's raw storage.
  // raw-csv.ts handles its own per-filename dedup so uploading the
  // same filename twice replaces, while sibling unknowns coexist.
  //
  // sf_generic ALSO deliberately OMITTED. Every unrecognized CSV shares
  // detected_format='sf_generic' but writes its own report_type into
  // sf_export_rows; sf-generic.ts self-dedups by (client, month,
  // report_type), so a format-level sweep would wipe sibling reports.
};

// Map Class-A (supersede) formats to their pure statement builders. These
// formats route through the atomic per-file transaction in ingestCSV:
// supersede + delete-prior + csv_uploads insert + parser inserts + rowcount
// run in ONE turso.batch('write'), so a parser failure rolls back the whole
// thing and the prior upload's data is never half-deleted. Class-B formats
// (everything else) keep the self-executing parser path.
const CLASS_A_BUILDERS: Record<string, (raw: string, clientId: string, month: string, uploadId: string) => Array<{ sql: string; args: any[] }>> = {
  crawl_internal: buildCrawlInternalStatements,
  content_urls: buildContentUrlsStatements,
  security_urls: buildSecurityUrlsStatements,
  structured_data_urls: buildStructuredDataUrlsStatements,
  accessibility: buildAccessibilityUrlsStatements,
  images: buildImagesStatements,
  redirects: buildRedirectsStatements,
  canonicals: buildCanonicalUrlsStatements,
  directives: buildDirectiveUrlsStatements,
  page_weight: buildPageWeightUrlsStatements,
  sitemap_urls: buildSitemapUrlsStatements,
  javascript: buildJavascriptUrlsStatements,
  url_structure: buildUrlStructureUrlsStatements,
  hreflang: buildHreflangUrlsStatements,
};

// READ-ONLY collector: runs ONLY the SELECT for the prior live upload of this
// key and RETURNS the DELETE/supersede statements to run, without executing
// them. The caller decides whether to execute them directly (Class-B) or fold
// them into an atomic batch (Class-A). Splitting the SELECT out is required
// because libsql write-batches cannot contain reads.
//
// Keying on original_name is what lets sibling files of the same
// detected_format (e.g. internal_all.csv vs internal_html.csv, or the 60+
// accessibility_*.csv per-issue files) coexist instead of wiping each other.
// Mirrors the per-key dedup proven for issue_urls (by issue_name) and links
// (by source_file).
//
// The UPLOAD-ROW supersession is UNIVERSAL (runs for every format), while the
// DATA-TABLE clearing stays scoped to FORMAT_SOURCES. Formats deliberately kept
// out of FORMAT_SOURCES (links, issue_urls) still own a LIVE csv_uploads row
// under the partial unique index ux_csv_uploads_live (client_id, month,
// detected_format, original_name). If we skip superseding their prior live row,
// a legitimate re-upload's INSERT collides with the stale live row and is
// rejected as "A concurrent upload of this file is already being processed".
// So we ALWAYS emit the supersede UPDATE for the prior live row of this exact
// key, but only emit per-table DELETEs when config exists — links self-dedups
// by source_file and issue_urls by issue_name inside their own parsers, so
// adding a format-level data sweep for them would wipe sibling files' rows.
// Keying on original_name means sibling files (h1_missing.csv vs
// h2_missing.csv, both issue_urls, different paths) are NOT superseded.
async function collectClearStatements(
  clientId: string,
  month: string,
  format: string,
  filename: string,
  currentUploadId: string,
  db: typeof turso = turso,
  siteId: string | null = null,
): Promise<{ latestPrevId: string | null; clearStatements: Array<{ sql: string; args: any[] }> }> {
  const config = FORMAT_SOURCES[format];

  // Site-aware key (multi-site Phase 1, migration 070): the same filename from
  // a DIFFERENT site of the same client must never supersede this one. NULL
  // site_id means the client's primary/only site, so two NULLs still match.
  const prevUploads = await db.execute({
    sql: `SELECT id FROM csv_uploads WHERE client_id = ? AND month = ? AND detected_format = ? AND original_name = ? AND id != ? AND COALESCE(site_id, '') = COALESCE(?, '') ORDER BY created_at ASC`,
    args: [clientId, month, format, filename, currentUploadId, siteId],
  });

  if (prevUploads.rows.length === 0) return { latestPrevId: null, clearStatements: [] };

  const prevIds = prevUploads.rows.map(r => r[0] as string);

  // Only clear data from the MOST RECENT previous upload of this key,
  // not ALL previous uploads. This prevents accumulating stale data while
  // preserving intentional multi-file uploads within the same month.
  const latestPrevId = prevIds[prevIds.length - 1];

  const clearStatements: Array<{ sql: string; args: any[] }> = [];
  // Per-table DELETEs ONLY when this format is tracked in FORMAT_SOURCES.
  // Non-FORMAT_SOURCES formats (links, issue_urls) self-dedup inside their
  // parsers, so a format-level data sweep would wipe sibling files.
  if (config) {
    for (const table of config.tables) {
      clearStatements.push({
        sql: `DELETE FROM ${table} WHERE client_id = ? AND month = ? AND csv_upload_id = ?`,
        args: [clientId, month, latestPrevId],
      });
    }
  }
  // Mark old upload record as superseded (keep for history, don't delete).
  // ALWAYS emitted, for every format — this is what frees the live unique
  // index slot so the re-upload's INSERT can succeed.
  clearStatements.push({
    sql: 'UPDATE csv_uploads SET error = ? WHERE id = ?',
    args: ['Superseded by newer upload', latestPrevId],
  });

  return { latestPrevId, clearStatements };
}

// Executing version for the Class-B path: collect the statements then run them
// as separate executes (Class-B parsers self-execute their inserts afterward,
// so these clears do not need to share a transaction with them).
async function clearPreviousData(
  clientId: string,
  month: string,
  format: string,
  filename: string,
  currentUploadId: string,
  db: typeof turso = turso,
  siteId: string | null = null,
): Promise<string | null> {
  const { latestPrevId, clearStatements } = await collectClearStatements(
    clientId, month, format, filename, currentUploadId, db, siteId,
  );
  for (const stmt of clearStatements) {
    await db.execute(stmt);
  }
  return latestPrevId;
}

// Assemble + run the atomic per-file ingest transaction. Extracted as an
// exported helper so the atomicity test can exercise the exact statement
// ordering against an in-memory libsql db. The whole array runs in ONE
// turso.batch(..., 'write'): if ANY statement fails (e.g. a parser INSERT
// violates a constraint, or a concurrent same-key insert races the unique
// index) libsql rolls back the entire batch. Because nothing was actually
// committed, the prior upload's row stays live and its child rows stay
// present — no manual restore is needed (the win over the old non-atomic path).
export async function runAtomicIngest(
  db: typeof turso,
  parts: {
    clearStatements: Array<{ sql: string; args: any[] }>;
    uploadInsert: { sql: string; args: any[] };
    parserStatements: Array<{ sql: string; args: any[] }>;
    coverageStatement?: { sql: string; args: any[] };
    rowCountUpdate: { sql: string; args: any[] };
  },
): Promise<void> {
  // coverageStatement (when present) goes AFTER parserStatements and before
  // rowCountUpdate, so it runs after uploadInsert — its FK parent
  // (csv_uploads.id via csv_upload_id) already exists in the same tx (same
  // ordering lesson as the accessibility metrics FK fix). It commits in the
  // SAME batch as the data it describes and can never disagree with it: a
  // parser failure rolls back both the data and the coverage row.
  const statements = [
    ...parts.clearStatements,
    parts.uploadInsert,
    ...parts.parserStatements,
    ...(parts.coverageStatement ? [parts.coverageStatement] : []),
    parts.rowCountUpdate,
  ];
  await db.batch(statements, 'write');
}

// Test-only seam: lets the unit test exercise clearPreviousData against an
// in-memory libsql db without prod. Not used in app code.
export async function __clearPreviousDataForTest(
  db: typeof turso, clientId: string, month: string, format: string, filename: string, currentUploadId: string, siteId: string | null = null,
): Promise<string | null> {
  return clearPreviousData(clientId, month, format, filename, currentUploadId, db, siteId);
}

export interface IngestResult {
  uploadId: string;
  format: CsvFormat;
  rowCount: number;
  headers: string[];
  error?: string;
}

export async function ingestCSV(
  raw: string,
  clientId: string,
  month: string,
  filename: string,
  uploadedBy: string,
  // Which of the client's sites this file belongs to (multi-site Phase 1,
  // migration 070). NULL = the client's primary/only site. Crawl-family data
  // self-identifies per row by hostname; this matters for the families that
  // cannot (GA4, GSC, keywords, metrics) so two sites' same-named exports
  // never supersede each other.
  siteId: string | null = null,
  // When true, SKIP the per-file coverage recompute. The batch upload path
  // (upload.ts) sets this and instead recomputes each touched category ONCE
  // after the whole batch finishes. recomputeCategoryCoverage aggregates the
  // FULL (client, month, category) table state and upserts on that key, so it
  // is order- and file-count-independent by design (the PR #256 property):
  // collapsing N per-file recomputes into one yields a byte-identical
  // data_coverage row while removing N-1 round-trips per category. Other
  // callers (F3 bundle ingest) keep the default per-file recompute.
  deferCoverage = false,
): Promise<IngestResult> {
  const { format, headers } = detectFormat(raw, filename);
  const uploadId = nanoid();

  if (format === 'unknown') {
    // Don't reject. Store the raw text + headers so a later parser
    // can be added and process this file retroactively without
    // re-upload. The detector ran first to confirm this is a CSV
    // shape; if Papa.parse failed to extract headers the file may
    // still be malformed but we'd rather store it than lose it.
    //
    // Supersede any prior live 'unknown_stored' row for this exact
    // filename BEFORE inserting the new row, so the partial unique
    // index (migration 055) is never violated by a legitimate re-upload.
    // The unknown branch supersedes by (client, month, 'unknown_stored',
    // original_name) with its own inline SELECT+UPDATE (plus parse-failure
    // restore below) rather than calling clearPreviousData, so it stays
    // self-contained here.
    //
    // Capture the prior live row's id BEFORE superseding it so we can
    // restore it in the parse-failure catch below (mirrors the typed-branch
    // rollback ordering: new row errored first, then prior row restored).
    const priorUnknown = await turso.execute({
      sql: `SELECT id FROM csv_uploads WHERE client_id = ? AND month = ? AND detected_format = 'unknown_stored' AND original_name = ? AND COALESCE(site_id, '') = COALESCE(?, '') AND error IS NULL LIMIT 1`,
      args: [clientId, month, filename, siteId],
    });
    const clearedUnknownId: string | null = priorUnknown.rows.length > 0 ? (priorUnknown.rows[0][0] as string) : null;

    await turso.execute({
      sql: `UPDATE csv_uploads SET error = 'Superseded by newer upload'
            WHERE client_id = ? AND month = ? AND detected_format = 'unknown_stored'
              AND original_name = ? AND COALESCE(site_id, '') = COALESCE(?, '') AND error IS NULL`,
      args: [clientId, month, filename, siteId],
    });

    // Create upload record
    try {
      await turso.execute({
        sql: 'INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month, uploaded_by, site_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        args: [uploadId, clientId, filename, format, month, uploadedBy, siteId],
      });
    } catch (insertErr: any) {
      if (insertErr.message?.includes('UNIQUE constraint')) {
        return { uploadId, format, rowCount: 0, headers, error: 'A concurrent upload of this file is already being processed' };
      }
      throw insertErr;
    }

    try {
      const rowCount = await parseRawCsv(raw, clientId, month, uploadId, filename);
      await turso.execute({
        sql: 'UPDATE csv_uploads SET detected_format = ?, row_count = ?, processed_at = datetime(\'now\') WHERE id = ?',
        args: ['unknown_stored', rowCount, uploadId],
      });
      return { uploadId, format: 'unknown_stored' as CsvFormat, rowCount, headers };
    } catch (err: any) {
      // Error the new (failed) row FIRST — removes it from the partial unique
      // index — then restore the prior row to live. Same invariant as the
      // typed-branch catch: new row must leave the index before prior re-enters.
      await turso.execute({
        sql: 'UPDATE csv_uploads SET error = ? WHERE id = ?',
        args: [`Stored as raw but encountered: ${err.message}`, uploadId],
      });
      if (clearedUnknownId) {
        try {
          await turso.execute({
            sql: 'UPDATE csv_uploads SET error = NULL WHERE id = ?',
            args: [clearedUnknownId],
          });
        } catch (restoreErr: any) {
          // Swallow: the failed upload is already errored above. If the
          // restore fails (e.g. a residual concurrent live row exists), the
          // prior row stays superseded but no live row is left in a corrupt
          // state. Log for diagnostics.
          console.error('[ingestCSV] unknown branch: failed to restore prior upload', clearedUnknownId, restoreErr?.message);
        }
      }
      return { uploadId, format, rowCount: 0, headers, error: err.message };
    }
  }

  // ── Class-A (supersede) formats: ONE atomic transaction ──────────────────
  // crawl_internal, content_urls, security_urls, structured_data_urls,
  // accessibility, images, redirects. The prior upload's supersede+delete, the
  // new csv_uploads insert, the parser's INSERTs, and the rowcount update all
  // run in a single turso.batch('write'). If any statement fails (parser error
  // OR a concurrent same-key insert racing the partial unique index) libsql
  // rolls the WHOLE batch back: the prior row stays live, its child rows stay
  // present, no new row is written. No catch-and-restore is needed because
  // nothing was ever half-committed — that is the fix for the old non-atomic
  // half-write + race.
  const builder = CLASS_A_BUILDERS[format];
  if (builder) {
    // SELECT the prior live upload OUTSIDE the batch (reads cannot be part of a
    // libsql write-batch) and get back the DELETE/supersede statements to fold
    // into the atomic batch — empty if there is no prior upload of this key.
    const { clearStatements } = await collectClearStatements(clientId, month, format, filename, uploadId, turso, siteId);

    const parserStatements = builder(raw, clientId, month, uploadId);

    try {
      await runAtomicIngest(turso, {
        clearStatements,
        uploadInsert: {
          sql: 'INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month, uploaded_by, site_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
          args: [uploadId, clientId, filename, format, month, uploadedBy, siteId],
        },
        parserStatements,
        rowCountUpdate: {
          sql: 'UPDATE csv_uploads SET row_count = ?, processed_at = datetime(\'now\') WHERE id = ?',
          args: [parserStatements.length, uploadId],
        },
      });
    } catch (err: any) {
      // The batch rolled back atomically: prior upload still live, prior child
      // rows still present, no new row, no new child rows. Nothing to restore.
      if (err.message?.includes('UNIQUE constraint')) {
        // A concurrent same-key upload raced the partial unique index. The
        // batch (incl. our supersede UPDATE) was rolled back, so the prior live
        // row is untouched.
        return { uploadId, format, rowCount: 0, headers, error: 'A concurrent upload of this file is already being processed' };
      }
      return { uploadId, format, rowCount: 0, headers, error: err.message };
    }

    // The accessibility format runs a SECOND, separate parser: the aggregate
    // metrics writer. It upserts 5 rows into `metrics` via ON CONFLICT DO UPDATE
    // (idempotent). It MUST run AFTER the atomic batch commits because metrics
    // has a FK to csv_uploads(id) — writing metrics before the csv_uploads row
    // exists throws SQLITE_CONSTRAINT: FOREIGN KEY constraint failed.
    // clearStatements (inside the batch) already deleted the prior upload's
    // metrics rows; this post-batch write re-populates them for the new uploadId.
    // Wrap so a metrics-write failure does not fail the whole upload: the
    // per-URL data (accessibility_urls) is already committed.
    if (format === 'accessibility') {
      try {
        await parseAccessibility(raw, clientId, month, uploadId);
      } catch (metricsErr: any) {
        console.error('[ingestCSV] accessibility aggregate metrics write failed (per-URL data committed OK)', metricsErr?.message);
      }
    }

    // Recompute coverage from the FULL table state for this category, AFTER the
    // atomic batch commits. This MUST be post-commit because it READS the table
    // (its own SELECT then upsert) and reads cannot live in a libsql
    // write-batch. Aggregating the whole table — not this one file's statements
    // — fixes the PR #256 last-writer-wins bug: when several files feed one
    // category in a month (content_quality is fed by content_all.csv AND by the
    // internal_css/images/javascript resource lists), a no-signal resource file
    // ingesting after content_all used to overwrite coverage to measured=0.
    // Now the result reflects every row regardless of file count or order.
    // Wrapped in try/catch so a coverage-recompute failure never fails the
    // upload — the per-URL data is already committed (same guard as metrics).
    // Skipped when the batch path defers it to one recompute-per-category after
    // the whole upload (deferCoverage); the aggregate is identical either way.
    const coverageCategory = FORMAT_TO_CATEGORY[format];
    if (coverageCategory && !deferCoverage) {
      try {
        await recomputeCategoryCoverage(turso, clientId, month, coverageCategory, 'csv_upload', uploadId);
      } catch (coverageErr: any) {
        console.error('[ingestCSV] coverage recompute failed (upload data committed OK)', format, coverageErr?.message);
      }
    }

    return { uploadId, format, rowCount: parserStatements.length, headers };
  }

  // ── Class-B formats: clear (if in FORMAT_SOURCES) then the parser ─────────
  // self-executes its own inserts via turso.batch. These are self-dedup or
  // append-only and do not need the all-in-one atomic transaction.
  //
  // Supersede any prior LIVE upload of this exact key BEFORE inserting the
  // new row, so the partial unique index (migration 055) is never violated
  // by a legitimate re-upload. Also clears the prior upload's child rows
  // for formats in FORMAT_SOURCES (per-filename key from Task 1).
  // Track what was cleared so we can undo if parsing fails.
  const clearedUploadId = await clearPreviousData(clientId, month, format, filename, uploadId, turso, siteId);

  // Create upload record (after supersede so the partial unique index is satisfied)
  try {
    await turso.execute({
      sql: 'INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month, uploaded_by, site_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [uploadId, clientId, filename, format, month, uploadedBy, siteId],
    });
  } catch (insertErr: any) {
    if (insertErr.message?.includes('UNIQUE constraint')) {
      // A concurrent upload raced in between our supersede and this insert.
      // Un-supersede the prior row we just marked, since we're not taking over.
      if (clearedUploadId) {
        await turso.execute({
          sql: 'UPDATE csv_uploads SET error = NULL WHERE id = ?',
          args: [clearedUploadId],
        });
      }
      return { uploadId, format, rowCount: 0, headers, error: 'A concurrent upload of this file is already being processed' };
    }
    throw insertErr;
  }

  try {
    // Clear has already happened above. Parse and write child rows.

    let rowCount = 0;

    switch (format) {
      case 'position_tracking':
        rowCount = await parsePositionTracking(raw, clientId, month, uploadId);
        break;
      case 'issues_overview':
        rowCount = await parseIssuesOverview(raw, clientId, month, uploadId);
        break;
      case 'crawl_overview':
        rowCount = await parseCrawlOverview(raw, clientId, month, uploadId);
        break;
      // NOTE: crawl_internal, redirects, images, content_urls, security_urls,
      // structured_data_urls, and accessibility are Class-A and handled by the
      // atomic-batch branch above (CLASS_A_BUILDERS); they never reach here.
      case 'image_optimization':
        rowCount = await parseImageOptimization(raw, clientId, month, uploadId);
        break;
      case 'keyword_research':
        rowCount = await parseKeywordResearch(raw, clientId, month, uploadId);
        break;
      case 'keyword_suggestions':
        rowCount = await parseKeywordSuggestions(raw, clientId, month, uploadId);
        break;
      case 'site_audit':
        rowCount = await parseSiteAudit(raw, clientId, month, uploadId, filename);
        break;
      case 'issue_urls':
        rowCount = await parseIssueUrls(raw, clientId, month, uploadId, filename);
        break;
      case 'links':
        // Per-source_file dedup happens inside the parser, so 'links'
        // is intentionally absent from FORMAT_SOURCES — the format-level
        // sweep at the top would wipe sibling link files in the same
        // batch. Same pattern as 'issue_urls' and 'unknown_stored'.
        rowCount = await parseLinks(raw, clientId, month, uploadId, filename);
        break;
      case 'sf_generic':
        // Universal capture: row-explode any unrecognized CSV into
        // sf_export_rows. Self-dedups by (client, month, report_type), so
        // sf_generic is intentionally absent from FORMAT_SOURCES (a
        // format-level sweep would wipe sibling reports in the same batch).
        rowCount = await parseSfGeneric(raw, clientId, month, uploadId, filename);
        break;
      case 'ga4_reports_snapshot':
      case 'ga4_traffic_acquisition':
      case 'ga4_pages':
      case 'ga4_tech':
      case 'ga4_geography':
        rowCount = await parseGa4(raw, clientId, month, uploadId, format);
        break;
      case 'gsc_pages':
      case 'gsc_queries':
      case 'gsc_countries':
      case 'gsc_devices':
      case 'gsc_search_appearance':
      case 'gsc_chart':
      case 'gsc_filters':
        rowCount = await parseGsc(raw, clientId, month, uploadId, format);
        break;
    }

    await turso.execute({
      sql: 'UPDATE csv_uploads SET row_count = ?, processed_at = datetime(\'now\') WHERE id = ?',
      args: [rowCount, uploadId],
    });

    // Recompute coverage from the FULL table state for this category, after the
    // data parser and rowcount update. All Class-B tracked categories
    // (keywords, ga4, gsc, issues) are file-present, so recomputeCategoryCoverage
    // records measured = 1 (the file was provided) with rows_total = COUNT(*) in
    // the table — even with zero data rows. Aggregating the table rather than
    // this one file's row count means multiple files feeding the same category
    // (e.g. several GSC dimension exports into gsc_dimensions) no longer wipe
    // each other's coverage. Wrapped in its own try/catch so a coverage failure
    // never fails the upload — the data is already committed (mirrors the
    // accessibility metrics guard). Skipped when the batch path defers it to
    // one recompute-per-category after the whole upload (deferCoverage).
    const coverageCategory = FORMAT_TO_CATEGORY[format];
    if (coverageCategory && !deferCoverage) {
      try {
        await recomputeCategoryCoverage(turso, clientId, month, coverageCategory, 'csv_upload', uploadId);
      } catch (coverageErr: any) {
        console.error('[ingestCSV] coverage recompute failed (upload data committed OK)', format, coverageErr?.message);
      }
    }

    return { uploadId, format, rowCount, headers };
  } catch (err: any) {
    // Clean up partial data from the failed parse
    const config = FORMAT_SOURCES[format];
    if (config) {
      for (const table of config.tables) {
        await turso.execute({
          sql: `DELETE FROM ${table} WHERE csv_upload_id = ?`,
          args: [uploadId],
        });
      }
    }

    // CRITICAL ordering: error the new (failed) upload row FIRST so it
    // leaves the partial unique index (ux_csv_uploads_live) BEFORE we
    // attempt to restore the prior superseded row. If the prior row's
    // restore runs while the new row still has error IS NULL, both rows
    // share the same (client_id, month, detected_format, original_name)
    // key and the partial index fires a UNIQUE constraint violation,
    // aborting the rollback and leaving the prior row permanently
    // superseded with its child rows already deleted — silent data loss.
    await turso.execute({
      sql: 'UPDATE csv_uploads SET error = ? WHERE id = ?',
      args: [err.message, uploadId],
    });

    // With the new row now errored (out of the live index), it is safe
    // to restore the prior superseded upload. Wrapped in its own
    // try/catch so that even if some residual concurrent live row exists
    // (which would re-fire the unique constraint), the failed upload
    // stays correctly errored and ingestCSV always returns cleanly.
    if (clearedUploadId) {
      try {
        await turso.execute({
          sql: 'UPDATE csv_uploads SET error = NULL WHERE id = ?',
          args: [clearedUploadId],
        });
      } catch (restoreErr: any) {
        // Swallow: the failed upload is already marked errored above. If
        // the restore fails (e.g. a residual concurrent live row exists),
        // the prior row stays superseded but no live row is left in a
        // corrupt state. Log for diagnostics.
        console.error('[ingestCSV] typed branch: failed to restore prior upload', clearedUploadId, restoreErr?.message);
      }
    }

    return { uploadId, format, rowCount: 0, headers, error: err.message };
  }
}

export async function getRecentUploads(clientId?: string, limit = 20) {
  const sql = clientId
    ? 'SELECT u.*, c.name as client_name FROM csv_uploads u JOIN clients c ON c.id = u.client_id WHERE u.client_id = ? ORDER BY u.created_at DESC LIMIT ?'
    : 'SELECT u.*, c.name as client_name FROM csv_uploads u JOIN clients c ON c.id = u.client_id ORDER BY u.created_at DESC LIMIT ?';
  const args = clientId ? [clientId, limit] : [limit];
  const result = await turso.execute({ sql, args });

  return result.rows.map(row => ({
    id: row[0] as string,
    client_id: row[1] as string,
    original_name: row[2] as string,
    detected_format: row[3] as string,
    row_count: row[4] as number,
    month: row[5] as string,
    uploaded_by: row[6] as string,
    processed_at: row[7] as string | null,
    error: row[8] as string | null,
    created_at: row[9] as string,
    client_name: row[10] as string,
  }));
}
