import Papa from 'papaparse';
import { nanoid } from 'nanoid';
import turso from '../../turso';

export async function parse(raw: string, clientId: string, month: string, uploadId: string, filename: string): Promise<number> {
  const result = Papa.parse(raw, { header: true, skipEmptyLines: true });
  const rows = result.data as any[];

  // Derive issue name from filename
  const baseName = filename.replace(/\.csv$/i, '').replace(/[_-]/g, ' ').trim();
  const issueName = baseName.charAt(0).toUpperCase() + baseName.slice(1);

  // Store as a single site_issue with count
  await turso.execute({
    sql: `INSERT INTO site_issues (id, client_id, month, issue_name, issue_type, priority, affected_urls, pct_of_total, description, how_to_fix, csv_upload_id)
          VALUES (?, ?, ?, ?, 'audit', 'medium', ?, ?, ?, ?, ?)`,
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
    ],
  });

  return rows.length;
}
