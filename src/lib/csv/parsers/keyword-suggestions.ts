import Papa from 'papaparse';
import { nanoid } from 'nanoid';
import turso from '../../turso';

export async function parse(raw: string, clientId: string, month: string, uploadId: string): Promise<number> {
  const result = Papa.parse(raw, { header: true, skipEmptyLines: true });
  let count = 0;

  for (const row of result.data as any[]) {
    const keyword = row['Keyword']?.toString().trim();
    if (!keyword) continue;

    // CPC comes as "US$X.XX" — strip prefix
    const volumeStr = row['Search Volume']?.toString().replace(/,/g, '') || '0';

    await turso.execute({
      sql: `INSERT INTO keyword_rankings (id, client_id, month, keyword, position, search_volume, url, change_val, seo_difficulty, source, csv_upload_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'keyword_suggestions', ?)`,
      args: [
        nanoid(),
        clientId,
        month,
        keyword,
        null, // suggestions don't have current position
        parseInt(volumeStr) || null,
        null,
        null,
        row['SEO Difficulty'] ? parseInt(row['SEO Difficulty']) : null,
        uploadId,
      ],
    });
    count++;
  }

  return count;
}
