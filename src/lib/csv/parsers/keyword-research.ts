import Papa from 'papaparse';
import { nanoid } from 'nanoid';
import { bulkInsert } from './_bulk-insert';

// Ubersuggest "domain overview" export (the client's ranking keywords with
// live positions): No, Keywords, Volume, Position, Est. Visits, Seo
// Difficulty, Ranking Url. These files run large (2,000+ rows), so inserts
// are batched to stay under the edge timeout — see _bulk-insert.
const SQL = `INSERT INTO keyword_rankings (id, client_id, month, keyword, position, search_volume, url, change_val, seo_difficulty, source, csv_upload_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'keyword_research', ?)`;

export async function parse(raw: string, clientId: string, month: string, uploadId: string): Promise<number> {
  const result = Papa.parse(raw, { header: true, skipEmptyLines: true, dynamicTyping: true });

  const allArgs: any[][] = [];
  for (const row of result.data as any[]) {
    const keyword = row['Keywords']?.toString().trim();
    if (!keyword) continue;
    allArgs.push([
      nanoid(),
      clientId,
      month,
      keyword,
      row['Position'] ?? null,
      row['Volume'] ?? null,
      row['Ranking Url']?.toString().trim() || null,
      null,
      row['Seo Difficulty'] ?? null,
      uploadId,
    ]);
  }

  await bulkInsert(SQL, allArgs);
  return allArgs.length;
}
