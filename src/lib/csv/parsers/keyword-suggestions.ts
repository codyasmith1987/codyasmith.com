import Papa from 'papaparse';
import { nanoid } from 'nanoid';
import turso from '../../turso';
import type { ParseResult, StagedKeyword } from '../types';

// v2: pure staging.
export function parseKeywordSuggestionsV2(raw: string): ParseResult {
  const result = Papa.parse(raw, { header: true, skipEmptyLines: true });
  const keywords: StagedKeyword[] = [];
  const seen = new Set<string>();
  for (const row of result.data as any[]) {
    const keyword = row['Keyword']?.toString().trim();
    if (!keyword || seen.has(keyword)) continue;
    seen.add(keyword);
    const volumeStr = row['Search Volume']?.toString().replace(/,/g, '') || '0';
    keywords.push({
      keyword,
      position: null,
      search_volume: parseInt(volumeStr) || null,
      url: null,
      change_val: null,
      seo_difficulty: row['SEO Difficulty'] ? parseInt(row['SEO Difficulty']) : null,
    });
  }
  return { keywords };
}

// v1: legacy.
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
