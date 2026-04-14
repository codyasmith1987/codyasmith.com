import Papa from 'papaparse';
import { nanoid } from 'nanoid';
import turso from '../../turso';
import type { ParseResult, StagedIssue } from '../types';

// v2: pure staging. Unlike v1 this takes filename as a required arg so
// the caller (ingest-v2) must pass it explicitly.
export function parseSiteAuditV2(raw: string, filename: string): ParseResult {
  const result = Papa.parse(raw, { header: true, skipEmptyLines: true });
  const rows = result.data as any[];
  const baseName = filename.replace(/\.csv$/i, '').replace(/[_-]/g, ' ').trim();
  const issueName = baseName.charAt(0).toUpperCase() + baseName.slice(1);
  const issues: StagedIssue[] = [
    {
      issue_name: issueName,
      issue_type: 'audit',
      priority: 'medium',
      affected_urls: rows.length,
      pct_of_total: null,
      description: `${rows.length} URLs affected`,
      how_to_fix: null,
    },
  ];
  return { issues };
}

// v1: legacy.
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
