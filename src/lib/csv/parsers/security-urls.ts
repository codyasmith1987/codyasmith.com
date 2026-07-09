// Parser for Screaming Frog's security_all.csv export.
//
// One row per URL with HTTP version + indexability + content type.
// The per-header presence (CSP, HSTS, X-Frame-Options, etc.) is NOT
// in security_all.csv directly; those are in the sub-reports like
// security_missing_csp_header.csv etc. We capture the columns that
// security_all does carry; per-header flags stay null on this row
// and would be populated by a future cross-report sync pass.
//
// raw_json carries the full row so any future query can extract
// what the hot columns missed.
//
// Pure builder: buildSecurityUrlsStatements returns INSERT statements
// without executing them (for the atomic-ingest path, Task 8).
// Back-compat executor: parse() calls the builder and runs via
// turso.batch so direct callers still work.

import { nanoid } from 'nanoid';
import turso from '../../turso';
import {
  parseCsvHeaderAndRows, findIdx, safeText, safeInt,
  extractHostname, rowToJson,
} from './_url-parser-helpers';

// PURE: parse raw -> array of INSERT statements. No DB calls. Exported
// for the atomic-ingest path (Task 8) and the thin parse() executor below.
export function buildSecurityUrlsStatements(
  raw: string, clientId: string, month: string, uploadId: string,
): Array<{ sql: string; args: any[] }> {
  const parsed = parseCsvHeaderAndRows(raw);
  if (!parsed) return [];
  const { headers, rows } = parsed;

  const idx = {
    address: findIdx(headers, 'address'),
    contentType: findIdx(headers, 'content type'),
    statusCode: findIdx(headers, 'status code'),
    indexability: findIdx(headers, 'indexability'),
    httpVersion: findIdx(headers, 'http version'),
    canonical: findIdx(headers, 'canonical link element 1'),
    metaRobots: findIdx(headers, 'meta robots 1'),
    xRobots: findIdx(headers, 'x-robots-tag 1'),
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

    const isHttps = /^https:\/\//i.test(url) ? 1 : 0;

    inserts.push([
      nanoid(), clientId, uploadId, month, url, hostname,
      idx.statusCode >= 0 ? safeInt(row[idx.statusCode]) : null,
      idx.httpVersion >= 0 ? safeText(row[idx.httpVersion], 16) : null,
      idx.contentType >= 0 ? safeText(row[idx.contentType], 128) : null,
      idx.indexability >= 0 ? safeText(row[idx.indexability], 64) : null,
      isHttps,
      null, null, null, null, null, // has_hsts, has_csp, has_x_content_type_options, has_x_frame_options, has_referrer_policy
      idx.metaRobots >= 0 ? safeText(row[idx.metaRobots], 256) : null,
      idx.xRobots >= 0 ? safeText(row[idx.xRobots], 256) : null,
      idx.canonical >= 0 ? safeText(row[idx.canonical], 2000) : null,
      rowToJson(headers, row),
    ]);
  }

  const sql = `INSERT INTO security_urls
    (id, client_id, csv_upload_id, month, url, hostname,
     status_code, http_version, content_type, indexability, is_https,
     has_hsts, has_csp, has_x_content_type_options, has_x_frame_options, has_referrer_policy,
     meta_robots, x_robots_tag, canonical_link, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  return inserts.map(args => ({ sql, args }));
}

// Thin executor — back-compat for direct callers.
export async function parse(raw: string, clientId: string, month: string, uploadId: string): Promise<number> {
  const stmts = buildSecurityUrlsStatements(raw, clientId, month, uploadId);
  for (let i = 0; i < stmts.length; i += 450) {
    await turso.batch(stmts.slice(i, i + 450), 'write');
  }
  return stmts.length;
}
