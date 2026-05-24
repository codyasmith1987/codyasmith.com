// Parser for Screaming Frog's accessibility_all.csv export at
// per-URL resolution. The existing accessibility parser stores 5
// aggregate metrics; this parser keeps the per-URL violation
// counts so the portal can show which page has which problem.
//
// Detector dispatches based on signature: if the file has the
// per-URL columns (Status Code + All Violations + WCAG breakdowns),
// route here. Otherwise the existing aggregate parser still wins.

import { nanoid } from 'nanoid';
import turso from '../../turso';
import {
  parseCsvHeaderAndRows, findIdx, findIdxContains, safeText, safeInt,
  extractHostname, rowToJson,
} from './_url-parser-helpers';

const BATCH = 50;

export async function parse(raw: string, clientId: string, month: string, uploadId: string): Promise<number> {
  const parsed = parseCsvHeaderAndRows(raw);
  if (!parsed) return 0;
  const { headers, rows } = parsed;

  const idx = {
    address: findIdx(headers, 'address'),
    contentType: findIdx(headers, 'content type'),
    statusCode: findIdx(headers, 'status code'),
    indexability: findIdx(headers, 'indexability'),
    allViolations: findIdx(headers, 'all violations'),
    bestPractice: findIdx(headers, 'best practice violations'),
    wcag20a: findIdx(headers, 'wcag 2.0 a violations'),
    wcag20aa: findIdx(headers, 'wcag 2.0 aa violations'),
    wcag20aaa: findIdx(headers, 'wcag 2.0 aaa violations'),
    wcag21a: findIdxContains(headers, 'wcag 2.1 a violations'),
    wcag21aa: findIdx(headers, 'wcag 2.1 aa violations'),
    wcag22a: findIdxContains(headers, 'wcag 2.2 a violations'),
    wcag22aa: findIdx(headers, 'wcag 2.2 aa violations'),
  };
  if (idx.address < 0) return 0;

  const seen = new Set<string>();
  const inserts: any[][] = [];

  for (const row of rows) {
    const url = safeText(row[idx.address], 2000);
    if (!url) continue;
    const hostname = extractHostname(url);
    if (!hostname) continue;
    const dedupKey = url.toLowerCase();
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    inserts.push([
      nanoid(), clientId, uploadId, month, url, hostname,
      idx.statusCode >= 0 ? safeInt(row[idx.statusCode]) : null,
      idx.contentType >= 0 ? safeText(row[idx.contentType], 128) : null,
      idx.indexability >= 0 ? safeText(row[idx.indexability], 64) : null,
      idx.allViolations >= 0 ? safeInt(row[idx.allViolations]) : null,
      idx.bestPractice >= 0 ? safeInt(row[idx.bestPractice]) : null,
      idx.wcag20a >= 0 ? safeInt(row[idx.wcag20a]) : null,
      idx.wcag20aa >= 0 ? safeInt(row[idx.wcag20aa]) : null,
      idx.wcag20aaa >= 0 ? safeInt(row[idx.wcag20aaa]) : null,
      idx.wcag21a >= 0 ? safeInt(row[idx.wcag21a]) : null,
      idx.wcag21aa >= 0 ? safeInt(row[idx.wcag21aa]) : null,
      idx.wcag22a >= 0 ? safeInt(row[idx.wcag22a]) : null,
      idx.wcag22aa >= 0 ? safeInt(row[idx.wcag22aa]) : null,
      rowToJson(headers, row),
    ]);
  }

  const sql = `INSERT INTO accessibility_urls
    (id, client_id, csv_upload_id, month, url, hostname,
     status_code, content_type, indexability,
     all_violations, best_practice_violations,
     wcag_20a_violations, wcag_20aa_violations, wcag_20aaa_violations,
     wcag_21a_violations, wcag_21aa_violations,
     wcag_22a_violations, wcag_22aa_violations, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  for (let i = 0; i < inserts.length; i += BATCH) {
    const chunk = inserts.slice(i, i + BATCH);
    await Promise.all(chunk.map(args => turso.execute({ sql, args })));
  }
  return inserts.length;
}
