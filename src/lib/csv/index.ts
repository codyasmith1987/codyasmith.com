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
    await turso.execute({
      sql: 'UPDATE csv_uploads SET error = ? WHERE id = ?',
      args: ['Unrecognized CSV format', uploadId],
    });
    return { uploadId, format, rowCount: 0, headers, error: 'Unrecognized CSV format. Headers: ' + headers.join(', ') };
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
