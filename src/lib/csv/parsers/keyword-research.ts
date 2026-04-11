import Papa from 'papaparse';
import { nanoid } from 'nanoid';
import turso from '../../turso';

export async function parse(raw: string, clientId: string, month: string, uploadId: string): Promise<number> {
  const result = Papa.parse(raw, { header: true, skipEmptyLines: true, dynamicTyping: true });
  let count = 0;

  for (const row of result.data as any[]) {
    const keyword = row['Keywords']?.toString().trim();
    if (!keyword) continue;

    await turso.execute({
      sql: `INSERT INTO keyword_rankings (id, client_id, month, keyword, position, search_volume, url, change_val, seo_difficulty, source, csv_upload_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'keyword_research', ?)`,
      args: [
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
      ],
    });
    count++;
  }

  return count;
}
