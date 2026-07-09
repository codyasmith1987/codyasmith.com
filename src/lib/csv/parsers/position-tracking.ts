import Papa from 'papaparse';
import { nanoid } from 'nanoid';
import { bulkInsert } from './_bulk-insert';

// Rank-tracker position export (keyword + live position + search volume +
// change + difficulty + ranking URL). Batched inserts so large keyword
// sets stay under the edge timeout — see _bulk-insert.
const SQL = `INSERT INTO keyword_rankings (id, client_id, month, keyword, position, search_volume, url, change_val, seo_difficulty, source, csv_upload_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'position_tracking', ?)`;

export async function parse(raw: string, clientId: string, month: string, uploadId: string): Promise<number> {
  const result = Papa.parse(raw, { header: true, skipEmptyLines: true, dynamicTyping: true });

  const allArgs: any[][] = [];
  for (const row of result.data as any[]) {
    const keyword = row['Keyword']?.toString().trim();
    if (!keyword) continue;
    allArgs.push([
      nanoid(),
      clientId,
      month,
      keyword,
      row['Position'] ?? null,
      row['Search Volume'] ?? null,
      row['URL']?.toString().trim() || null,
      row['Change'] ?? null,
      row['SD'] ?? null,
      uploadId,
    ]);
  }

  await bulkInsert(SQL, allArgs);
  return allArgs.length;
}
