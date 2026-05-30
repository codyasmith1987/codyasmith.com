import Papa from 'papaparse';
import { nanoid } from 'nanoid';
import { bulkInsert } from './_bulk-insert';

// Ubersuggest keyword exports: the "suggestions" file (Keyword, Search
// Intent, Search Volume, CPC, Paid Difficulty, SEO Difficulty) and the
// "bulk analysis" file (same minus Search Intent). Both land here as
// keyword research with no live position. Batched inserts for large files.
const SQL = `INSERT INTO keyword_rankings (id, client_id, month, keyword, position, search_volume, url, change_val, seo_difficulty, source, csv_upload_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'keyword_suggestions', ?)`;

export async function parse(raw: string, clientId: string, month: string, uploadId: string): Promise<number> {
  const result = Papa.parse(raw, { header: true, skipEmptyLines: true });

  const allArgs: any[][] = [];
  for (const row of result.data as any[]) {
    const keyword = row['Keyword']?.toString().trim();
    if (!keyword) continue;

    // Search Volume comes formatted with thousands separators ("1,300").
    const volumeStr = row['Search Volume']?.toString().replace(/,/g, '') || '0';

    allArgs.push([
      nanoid(),
      clientId,
      month,
      keyword,
      null, // suggestions/bulk don't carry a current position
      parseInt(volumeStr) || null,
      null,
      null,
      row['SEO Difficulty'] ? parseInt(row['SEO Difficulty']) : null,
      uploadId,
    ]);
  }

  await bulkInsert(SQL, allArgs);
  return allArgs.length;
}
