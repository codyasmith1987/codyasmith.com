import Papa from 'papaparse';
import { nanoid } from 'nanoid';
import turso from '../../turso';

// Reject derived issue names that look like a filename leak rather
// than a clean human-readable issue label. The detector should
// already have stopped these (PR removing _inlinks / _outlinks /
// anchor_text from the site_audit heuristic), and the upload route
// should already have stripped the directory prefix. This is
// defense in depth so a future regression in either of those
// places can't pollute site_issues with rows like
// "2026.05.24.15.21.38/issues reports/response codes external
// client error (4xx) inlinks".
function looksLikeFilenameLeak(name: string): boolean {
  if (!name) return true;
  // Path separators surviving the strip is an obvious tell.
  if (name.includes('/') || name.includes('\\')) return true;
  // SF export timestamp folders look like 2026.05.24.15.21.38.
  if (/^\d{4}\.\d{2}\.\d{2}/.test(name)) return true;
  // Anything excessively long is most likely a filename, not an
  // issue label.
  if (name.length > 100) return true;
  return false;
}

export async function parse(raw: string, clientId: string, month: string, uploadId: string, filename: string, siteId: string | null = null): Promise<number> {
  const result = Papa.parse(raw, { header: true, skipEmptyLines: true });
  const rows = result.data as any[];

  // Derive issue name from filename
  const baseName = filename.replace(/\.csv$/i, '').replace(/[_-]/g, ' ').trim();
  const issueName = baseName.charAt(0).toUpperCase() + baseName.slice(1);

  if (looksLikeFilenameLeak(issueName)) {
    // Skip silently. The CSV upload row still gets created (the
    // ingest pipeline marks the format as 'site_audit'), but no
    // site_issues row is written. Better to surface zero rows than
    // pollute the health page with a garbage entry.
    return 0;
  }

  // Store as a single site_issue with count. Upsert on
  // (client_id, month, issue_name) for the same reason issues-overview
  // does: a plain INSERT throws the UNIQUE constraint when the derived
  // issue_name already exists for this (client, month): a re-uploaded
  // audit file, or a derived name that collides with an issues_overview
  // row. Last-writer-wins refreshes the count instead of erroring.
  await turso.execute({
    sql: `INSERT INTO site_issues (id, client_id, month, issue_name, issue_type, priority, affected_urls, pct_of_total, description, how_to_fix, csv_upload_id, site_id)
          VALUES (?, ?, ?, ?, 'audit', 'medium', ?, ?, ?, ?, ?, ?)
          ON CONFLICT(client_id, month, issue_name, COALESCE(site_id, ''))
          DO UPDATE SET
            issue_type = excluded.issue_type,
            priority = excluded.priority,
            affected_urls = excluded.affected_urls,
            pct_of_total = excluded.pct_of_total,
            description = excluded.description,
            how_to_fix = excluded.how_to_fix,
            csv_upload_id = excluded.csv_upload_id`,
    args: [
      nanoid(),
      clientId,
      month,
      issueName,
      rows.length,
      null,
      `${rows.length} URLs affected`,
      null,
      uploadId,
      siteId,
    ],
  });

  return rows.length;
}
