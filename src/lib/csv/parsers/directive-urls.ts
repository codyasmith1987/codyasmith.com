// Parser for Screaming Frog's directives_all.csv export.
//
// Per-URL robots / refresh directives. Columns: Address, Occurrences,
// Meta Robots 1, X-Robots-Tag 1, Meta Refresh 1, Canonical Link
// Element 1, HTTP Canonical, Indexability, Indexability Status.
//
// Meta Refresh 1 is the unique tell that routes this export here rather
// than security_all (which has meta robots / x-robots but no meta
// refresh, and is matched earlier by its HTTP Version signature). See
// detector.ts SIGNATURES.
//
// Pure builder: buildDirectiveUrlsStatements returns INSERT statements
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
export function buildDirectiveUrlsStatements(
  raw: string, clientId: string, month: string, uploadId: string,
): Array<{ sql: string; args: any[] }> {
  const parsed = parseCsvHeaderAndRows(raw);
  if (!parsed) return [];
  const { headers, rows } = parsed;

  const idx = {
    address: findIdx(headers, 'address'),
    occurrences: findIdx(headers, 'occurrences'),
    metaRobots: findIdx(headers, 'meta robots 1'),
    xRobots: findIdx(headers, 'x-robots-tag 1'),
    metaRefresh: findIdx(headers, 'meta refresh 1'),
    canonical: findIdx(headers, 'canonical link element 1'),
    httpCanonical: findIdx(headers, 'http canonical'),
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
      idx.occurrences >= 0 ? safeInt(row[idx.occurrences]) : null,
      idx.metaRobots >= 0 ? safeText(row[idx.metaRobots], 256) : null,
      idx.xRobots >= 0 ? safeText(row[idx.xRobots], 256) : null,
      idx.metaRefresh >= 0 ? safeText(row[idx.metaRefresh], 256) : null,
      idx.canonical >= 0 ? safeText(row[idx.canonical], 2000) : null,
      idx.httpCanonical >= 0 ? safeText(row[idx.httpCanonical], 2000) : null,
      idx.indexability >= 0 ? safeText(row[idx.indexability], 64) : null,
      idx.indexabilityStatus >= 0 ? safeText(row[idx.indexabilityStatus], 256) : null,
      rowToJson(headers, row),
    ]);
  }

  const sql = `INSERT INTO directive_urls
    (id, client_id, csv_upload_id, month, url, hostname,
     occurrences, meta_robots, x_robots_tag, meta_refresh, canonical_link_element, http_canonical,
     indexability, indexability_status, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  return inserts.map(args => ({ sql, args }));
}

// Thin executor — back-compat for direct callers.
export async function parse(raw: string, clientId: string, month: string, uploadId: string): Promise<number> {
  const stmts = buildDirectiveUrlsStatements(raw, clientId, month, uploadId);
  for (let i = 0; i < stmts.length; i += 450) {
    await turso.batch(stmts.slice(i, i + 450), 'write');
  }
  return stmts.length;
}
