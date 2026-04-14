import Papa from 'papaparse';
import { nanoid } from 'nanoid';
import turso from '../../turso';

// v2 staging types moved to src/lib/csv/types.ts — re-exported here so
// existing imports (ingest-v2.ts) don't break. New code should import
// from ../types directly.
export type {
  StagedKeyword,
  StagedIssue,
  StagedMetric,
  ParseResult,
} from '../types';
import type { ParseResult, StagedKeyword } from '../types';

// v2: pure function. No DB writes. No upload_id. Deterministic for the same
// input bytes. The only side effect is string parsing.
export function parsePositionTrackingV2(raw: string): ParseResult {
  const result = Papa.parse(raw, { header: true, skipEmptyLines: true, dynamicTyping: true });
  const keywords: StagedKeyword[] = [];
  // Guard against intra-file duplicates the UNIQUE index would reject later.
  const seen = new Set<string>();
  for (const row of result.data as any[]) {
    const keyword = row['Keyword']?.toString().trim();
    if (!keyword) continue;
    if (seen.has(keyword)) continue;
    seen.add(keyword);
    keywords.push({
      keyword,
      position: row['Position'] ?? null,
      search_volume: row['Search Volume'] ?? null,
      url: row['URL']?.toString().trim() || null,
      change_val: row['Change'] ?? null,
      seo_difficulty: row['SD'] ?? null,
    });
  }
  return { keywords };
}

// v1: legacy DB-writing signature, still in use by src/lib/csv/index.ts for
// formats not yet migrated to v2. Will be deleted in Step 4b-ii.
export async function parse(raw: string, clientId: string, month: string, uploadId: string): Promise<number> {
  const result = Papa.parse(raw, { header: true, skipEmptyLines: true, dynamicTyping: true });
  let count = 0;

  for (const row of result.data as any[]) {
    const keyword = row['Keyword']?.toString().trim();
    if (!keyword) continue;

    await turso.execute({
      sql: `INSERT INTO keyword_rankings (id, client_id, month, keyword, position, search_volume, url, change_val, seo_difficulty, source, csv_upload_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'position_tracking', ?)`,
      args: [
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
      ],
    });
    count++;
  }

  return count;
}
