import Papa from 'papaparse';
import { nanoid } from 'nanoid';
import turso from '../../turso';
import type { ParseResult, StagedIssue, StagedMetric } from '../types';

// v2: pure staging. Returns both issue rows and two aggregate metrics.
export function parseIssuesOverviewV2(raw: string): ParseResult {
  const result = Papa.parse(raw, { header: true, skipEmptyLines: true });
  const issues: StagedIssue[] = [];
  const seen = new Set<string>();
  let totalAffected = 0;
  for (const row of result.data as any[]) {
    const issueName = row['Issue Name']?.toString().trim();
    if (!issueName || seen.has(issueName)) continue;
    seen.add(issueName);
    const pctStr = row['% of Total']?.toString().replace('%', '').trim();
    const pct = pctStr ? parseFloat(pctStr) : null;
    const urls = parseInt(row['URLs']) || null;
    if (urls !== null) totalAffected += urls;
    issues.push({
      issue_name: issueName,
      issue_type: row['Issue Type']?.toString().trim() || null,
      priority: row['Issue Priority']?.toString().trim() || null,
      affected_urls: urls,
      pct_of_total: pct,
      description: row['Description']?.toString().trim() || null,
      how_to_fix: row['How To Fix']?.toString().trim() || null,
    });
  }
  const metrics: StagedMetric[] = [
    { category: 'health', metric_key: 'total_issues', metric_value: issues.length },
    { category: 'health', metric_key: 'total_affected_urls', metric_value: totalAffected },
  ];
  return { issues, metrics };
}

// v1: legacy.
export async function parse(raw: string, clientId: string, month: string, uploadId: string): Promise<number> {
  const result = Papa.parse(raw, { header: true, skipEmptyLines: true });
  let count = 0;

  for (const row of result.data as any[]) {
    const issueName = row['Issue Name']?.toString().trim();
    if (!issueName) continue;

    const pctStr = row['% of Total']?.toString().replace('%', '').trim();
    const pct = pctStr ? parseFloat(pctStr) : null;

    await turso.execute({
      sql: `INSERT INTO site_issues (id, client_id, month, issue_name, issue_type, priority, affected_urls, pct_of_total, description, how_to_fix, csv_upload_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        nanoid(),
        clientId,
        month,
        issueName,
        row['Issue Type']?.toString().trim() || null,
        row['Issue Priority']?.toString().trim() || null,
        parseInt(row['URLs']) || null,
        pct,
        row['Description']?.toString().trim() || null,
        row['How To Fix']?.toString().trim() || null,
        uploadId,
      ],
    });
    count++;
  }

  // Also store aggregate metrics
  const totalIssues = count;
  const totalAffected = (result.data as any[]).reduce((sum, r) => sum + (parseInt(r['URLs']) || 0), 0);

  await turso.execute({
    sql: `INSERT OR REPLACE INTO metrics (id, client_id, month, category, metric_key, metric_value, source, csv_upload_id)
          VALUES (?, ?, ?, 'health', 'total_issues', ?, 'csv_upload', ?)
          ON CONFLICT(client_id, month, category, metric_key)
          DO UPDATE SET metric_value = excluded.metric_value, csv_upload_id = excluded.csv_upload_id`,
    args: [nanoid(), clientId, month, totalIssues, uploadId],
  });

  await turso.execute({
    sql: `INSERT OR REPLACE INTO metrics (id, client_id, month, category, metric_key, metric_value, source, csv_upload_id)
          VALUES (?, ?, ?, 'health', 'total_affected_urls', ?, 'csv_upload', ?)
          ON CONFLICT(client_id, month, category, metric_key)
          DO UPDATE SET metric_value = excluded.metric_value, csv_upload_id = excluded.csv_upload_id`,
    args: [nanoid(), clientId, month, totalAffected, uploadId],
  });

  return count;
}
