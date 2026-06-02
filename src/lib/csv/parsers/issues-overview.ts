import Papa from 'papaparse';
import { nanoid } from 'nanoid';
import turso from '../../turso';

export async function parse(raw: string, clientId: string, month: string, uploadId: string): Promise<number> {
  return parseIssuesOverviewWithDb(raw, clientId, month, uploadId, turso);
}

// Test-injectable variant. The db param defaults to the prod singleton in
// parse(); tests inject an in-memory client to avoid touching the remote DB.
export async function parseIssuesOverviewWithDb(
  raw: string,
  clientId: string,
  month: string,
  uploadId: string,
  db: typeof turso,
): Promise<number> {
  const result = Papa.parse(raw, { header: true, skipEmptyLines: true });
  let count = 0;

  for (const row of result.data as any[]) {
    const issueName = row['Issue Name']?.toString().trim();
    if (!issueName) continue;

    const pctStr = row['% of Total']?.toString().replace('%', '').trim();
    const pct = pctStr ? parseFloat(pctStr) : null;

    // Upsert on (client_id, month, issue_name): Screaming Frog ships
    // issues_overview_report.csv in BOTH the crawl root and
    // /issues_reports/, and they detect as the same format with
    // different original_names, so neither supersedes the other. A
    // plain INSERT throws a UNIQUE constraint on the second file's
    // identical issue_names. Overwriting (last-writer-wins) lets a
    // duplicate file, or a re-run, refresh the row instead of erroring.
    await db.execute({
      sql: `INSERT INTO site_issues (id, client_id, month, issue_name, issue_type, priority, affected_urls, pct_of_total, description, how_to_fix, csv_upload_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(client_id, month, issue_name)
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

  await db.execute({
    sql: `INSERT OR REPLACE INTO metrics (id, client_id, month, category, metric_key, metric_value, source, csv_upload_id)
          VALUES (?, ?, ?, 'health', 'total_issues', ?, 'csv_upload', ?)
          ON CONFLICT(client_id, month, category, metric_key)
          DO UPDATE SET metric_value = excluded.metric_value, csv_upload_id = excluded.csv_upload_id`,
    args: [nanoid(), clientId, month, totalIssues, uploadId],
  });

  await db.execute({
    sql: `INSERT OR REPLACE INTO metrics (id, client_id, month, category, metric_key, metric_value, source, csv_upload_id)
          VALUES (?, ?, ?, 'health', 'total_affected_urls', ?, 'csv_upload', ?)
          ON CONFLICT(client_id, month, category, metric_key)
          DO UPDATE SET metric_value = excluded.metric_value, csv_upload_id = excluded.csv_upload_id`,
    args: [nanoid(), clientId, month, totalAffected, uploadId],
  });

  return count;
}
