// Parser for Screaming Frog's sitemaps_all.csv export.
//
// The URLs found in the sitemap crawl. Columns: Address, Content Type,
// Status Code, Status, Indexability, Indexability Status. The header is
// generic (identical to response_codes_* and other crawl sub-reports),
// so this export is detected by the sitemaps_all.csv FILENAME rule in
// detectFormat, not by a column signature.
//
// Pure builder: buildSitemapUrlsStatements returns INSERT statements
// without executing them (for the atomic-ingest path in ingestCSV).
// Back-compat executor: parse() calls the builder and runs via
// turso.batch so direct callers still work.

import { nanoid } from 'nanoid';
import turso from '../../turso';
import {
  parseCsvHeaderAndRows, findIdx, safeText, safeInt,
  extractHostname, rowToJson,
} from './_url-parser-helpers';

// PURE: parse raw -> array of INSERT statements. No DB calls. Exported
// for the atomic-ingest path and the thin parse() executor below.
export function buildSitemapUrlsStatements(
  raw: string, clientId: string, month: string, uploadId: string,
): Array<{ sql: string; args: any[] }> {
  const parsed = parseCsvHeaderAndRows(raw);
  if (!parsed) return [];
  const { headers, rows } = parsed;

  const idx = {
    address: findIdx(headers, 'address'),
    contentType: findIdx(headers, 'content type'),
    statusCode: findIdx(headers, 'status code'),
    status: findIdx(headers, 'status'),
    indexability: findIdx(headers, 'indexability'),
    indexabilityStatus: findIdx(headers, 'indexability status'),
  };
  if (idx.address < 0) return [];

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
      idx.contentType >= 0 ? safeText(row[idx.contentType], 128) : null,
      idx.statusCode >= 0 ? safeInt(row[idx.statusCode]) : null,
      idx.status >= 0 ? safeText(row[idx.status], 64) : null,
      idx.indexability >= 0 ? safeText(row[idx.indexability], 64) : null,
      idx.indexabilityStatus >= 0 ? safeText(row[idx.indexabilityStatus], 256) : null,
      rowToJson(headers, row),
    ]);
  }

  const sql = `INSERT INTO sitemap_urls
    (id, client_id, csv_upload_id, month, url, hostname,
     content_type, status_code, status, indexability, indexability_status, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  return inserts.map(args => ({ sql, args }));
}

// Thin executor — back-compat for direct callers.
export async function parse(raw: string, clientId: string, month: string, uploadId: string): Promise<number> {
  const stmts = buildSitemapUrlsStatements(raw, clientId, month, uploadId);
  for (let i = 0; i < stmts.length; i += 450) {
    await turso.batch(stmts.slice(i, i + 450), 'write');
  }
  return stmts.length;
}
