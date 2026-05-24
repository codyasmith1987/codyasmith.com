import { nanoid } from 'nanoid';
import turso from '../turso';
import { detectFormat, type CsvFormat } from './detector';
import { parse as parsePositionTracking } from './parsers/position-tracking';
import { parse as parseIssuesOverview } from './parsers/issues-overview';
import { parse as parseCrawlOverview } from './parsers/crawl-overview';
import { parse as parseCrawlInternal } from './parsers/crawl-internal';
import { parse as parseRedirects } from './parsers/redirects';
import { parse as parseImages } from './parsers/images';
import { parse as parseContentUrls } from './parsers/content-urls';
import { parse as parseSecurityUrls } from './parsers/security-urls';
import { parse as parseStructuredDataUrls } from './parsers/structured-data-urls';
import { parse as parseAccessibilityUrls } from './parsers/accessibility-urls';
import { parse as parseImageOptimization } from './parsers/image-optimization';
import { parse as parseKeywordResearch } from './parsers/keyword-research';
import { parse as parseKeywordSuggestions } from './parsers/keyword-suggestions';
import { parse as parseSiteAudit } from './parsers/site-audit';
import { parse as parseAccessibility } from './parsers/accessibility';
import { parse as parseIssueUrls } from './parsers/issue-urls';
import { parse as parseRawCsv } from './parsers/raw-csv';
import { parseGa4 } from './parsers/ga4';
import { parseGsc } from './parsers/gsc';

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
  image_optimization: { tables: ['metrics'], source: 'image_optimization' },
  site_audit: { tables: ['site_issues'], source: 'site_audit' },
  accessibility: { tables: ['metrics', 'accessibility_urls'], source: 'accessibility' },
  issue_urls: { tables: ['site_issue_urls'], source: 'issue_urls' },
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
  // Stored-but-not-yet-typed CSVs. Cleared on re-upload like every
  // other format so the same filename doesn't accumulate raw copies.
  unknown_stored: { tables: ['raw_csv_data'], source: 'unknown_stored' },
};

async function clearPreviousData(clientId: string, month: string, format: string, currentUploadId: string): Promise<string | null> {
  const config = FORMAT_SOURCES[format];
  if (!config) return null;

  // Find previous upload IDs for this client+month+format (not the current one)
  const prevUploads = await turso.execute({
    sql: 'SELECT id FROM csv_uploads WHERE client_id = ? AND month = ? AND detected_format = ? AND id != ? ORDER BY created_at ASC',
    args: [clientId, month, format, currentUploadId],
  });

  if (prevUploads.rows.length === 0) return null;

  const prevIds = prevUploads.rows.map(r => r[0] as string);

  // Only clear data from the MOST RECENT previous upload of this format,
  // not ALL previous uploads. This prevents accumulating stale data while
  // preserving intentional multi-file uploads within the same month.
  const latestPrevId = prevIds[prevIds.length - 1];
  for (const table of config.tables) {
    await turso.execute({
      sql: `DELETE FROM ${table} WHERE client_id = ? AND month = ? AND csv_upload_id = ?`,
      args: [clientId, month, latestPrevId],
    });
  }

  // Mark old upload records as superseded (keep for history, don't delete)
  await turso.execute({
    sql: 'UPDATE csv_uploads SET error = ? WHERE id = ?',
    args: ['Superseded by newer upload', latestPrevId],
  });

  return latestPrevId;
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
): Promise<IngestResult> {
  const { format, headers } = detectFormat(raw, filename);
  const uploadId = nanoid();

  // Create upload record
  await turso.execute({
    sql: 'INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)',
    args: [uploadId, clientId, filename, format, month, uploadedBy],
  });

  if (format === 'unknown') {
    // Don't reject. Store the raw text + headers so a later parser
    // can be added and process this file retroactively without
    // re-upload. The detector ran first to confirm this is a CSV
    // shape; if Papa.parse failed to extract headers the file may
    // still be malformed but we'd rather store it than lose it.
    try {
      const clearedUploadId = await clearPreviousData(clientId, month, 'unknown_stored', uploadId);
      const rowCount = await parseRawCsv(raw, clientId, month, uploadId, filename);
      await turso.execute({
        sql: 'UPDATE csv_uploads SET detected_format = ?, row_count = ?, processed_at = datetime(\'now\') WHERE id = ?',
        args: ['unknown_stored', rowCount, uploadId],
      });
      return { uploadId, format: 'unknown_stored' as CsvFormat, rowCount, headers };
    } catch (err: any) {
      await turso.execute({
        sql: 'UPDATE csv_uploads SET error = ? WHERE id = ?',
        args: [`Stored as raw but encountered: ${err.message}`, uploadId],
      });
      return { uploadId, format, rowCount: 0, headers, error: err.message };
    }
  }

  try {
    // Clear old data for this client+month+source before inserting.
    // Track what was cleared so we can undo if parsing fails.
    const clearedUploadId = await clearPreviousData(clientId, month, format, uploadId);

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
      case 'crawl_internal':
        rowCount = await parseCrawlInternal(raw, clientId, month, uploadId);
        break;
      case 'redirects':
        rowCount = await parseRedirects(raw, clientId, month, uploadId);
        break;
      case 'images':
        rowCount = await parseImages(raw, clientId, month, uploadId);
        break;
      case 'content_urls':
        rowCount = await parseContentUrls(raw, clientId, month, uploadId);
        break;
      case 'security_urls':
        rowCount = await parseSecurityUrls(raw, clientId, month, uploadId);
        break;
      case 'structured_data_urls':
        rowCount = await parseStructuredDataUrls(raw, clientId, month, uploadId);
        break;
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
      case 'accessibility': {
        // Two parsers on the same file: the legacy one writes 5
        // aggregate metric rows; the new one writes per-URL rows to
        // accessibility_urls so the portal can drill into which page
        // has which WCAG violation. rowCount reports the per-URL
        // count which is the more useful signal for the upload UI.
        await parseAccessibility(raw, clientId, month, uploadId);
        rowCount = await parseAccessibilityUrls(raw, clientId, month, uploadId);
        break;
      }
      case 'issue_urls':
        rowCount = await parseIssueUrls(raw, clientId, month, uploadId, filename);
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

    // If we cleared a previous upload's data, un-mark it as superseded
    if (clearedUploadId) {
      await turso.execute({
        sql: 'UPDATE csv_uploads SET error = NULL WHERE id = ?',
        args: [clearedUploadId],
      });
    }

    await turso.execute({
      sql: 'UPDATE csv_uploads SET error = ? WHERE id = ?',
      args: [err.message, uploadId],
    });
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
