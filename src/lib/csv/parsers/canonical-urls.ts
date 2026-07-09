// Parser for Screaming Frog's canonicals_all.csv export.
//
// Per-URL canonical + pagination posture. Columns: Address, Occurrences,
// Indexability, Indexability Status, Canonical Link Element 1, HTTP
// Canonical, Meta Robots 1, X-Robots-Tag 1, rel="next" 1, rel="prev" 1,
// HTTP rel="next" 1, HTTP rel="prev" 1.
//
// rel="next"/"prev" is the unique tell that routes this export here
// rather than directives_all (see detector.ts SIGNATURES).
//
// Pure builder: buildCanonicalUrlsStatements returns INSERT statements
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
export function buildCanonicalUrlsStatements(
  raw: string, clientId: string, month: string, uploadId: string,
): Array<{ sql: string; args: any[] }> {
  const parsed = parseCsvHeaderAndRows(raw);
  if (!parsed) return [];
  const { headers, rows } = parsed;

  const idx = {
    address: findIdx(headers, 'address'),
    occurrences: findIdx(headers, 'occurrences'),
    indexability: findIdx(headers, 'indexability'),
    indexabilityStatus: findIdx(headers, 'indexability status'),
    canonical: findIdx(headers, 'canonical link element 1'),
    httpCanonical: findIdx(headers, 'http canonical'),
    metaRobots: findIdx(headers, 'meta robots 1'),
    xRobots: findIdx(headers, 'x-robots-tag 1'),
    relNext: findIdx(headers, 'rel="next" 1'),
    relPrev: findIdx(headers, 'rel="prev" 1'),
    httpRelNext: findIdx(headers, 'http rel="next" 1'),
    httpRelPrev: findIdx(headers, 'http rel="prev" 1'),
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
      idx.occurrences >= 0 ? safeInt(row[idx.occurrences]) : null,
      idx.indexability >= 0 ? safeText(row[idx.indexability], 64) : null,
      idx.indexabilityStatus >= 0 ? safeText(row[idx.indexabilityStatus], 256) : null,
      idx.canonical >= 0 ? safeText(row[idx.canonical], 2000) : null,
      idx.httpCanonical >= 0 ? safeText(row[idx.httpCanonical], 2000) : null,
      idx.metaRobots >= 0 ? safeText(row[idx.metaRobots], 256) : null,
      idx.xRobots >= 0 ? safeText(row[idx.xRobots], 256) : null,
      idx.relNext >= 0 ? safeText(row[idx.relNext], 2000) : null,
      idx.relPrev >= 0 ? safeText(row[idx.relPrev], 2000) : null,
      idx.httpRelNext >= 0 ? safeText(row[idx.httpRelNext], 2000) : null,
      idx.httpRelPrev >= 0 ? safeText(row[idx.httpRelPrev], 2000) : null,
      rowToJson(headers, row),
    ]);
  }

  const sql = `INSERT INTO canonical_urls
    (id, client_id, csv_upload_id, month, url, hostname,
     occurrences, indexability, indexability_status, canonical_link_element, http_canonical,
     meta_robots, x_robots_tag, rel_next, rel_prev, http_rel_next, http_rel_prev, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  return inserts.map(args => ({ sql, args }));
}

// Thin executor — back-compat for direct callers.
export async function parse(raw: string, clientId: string, month: string, uploadId: string): Promise<number> {
  const stmts = buildCanonicalUrlsStatements(raw, clientId, month, uploadId);
  for (let i = 0; i < stmts.length; i += 450) {
    await turso.batch(stmts.slice(i, i + 450), 'write');
  }
  return stmts.length;
}
