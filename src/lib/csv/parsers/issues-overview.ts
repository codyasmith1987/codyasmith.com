import Papa from 'papaparse';
import { nanoid } from 'nanoid';
import turso from '../../turso';

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
