// Parser for Screaming Frog's url_all.csv export.
//
// Per-URL structure view across ALL resource types: content hash (the
// duplicate-content fingerprint), URL length, encoding, canonical. Header is
// crawl-generic, so the detector routes this by the exact filename url_all.csv
// (a backup signature keys on Hash + URL Encoded Address, which are unique to
// this report). url_length is the URL STRING length, NOT page byte size.
//
// Pure builder + thin executor, same Class-A pattern as canonical-urls.ts.

import { nanoid } from 'nanoid';
import turso from '../../turso';
import {
  parseCsvHeaderAndRows, findIdx, safeText, safeInt,
  extractHostname, rowToJson,
} from './_url-parser-helpers';

export function buildUrlStructureUrlsStatements(
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
    hash: findIdx(headers, 'hash'),
    length: findIdx(headers, 'length'),
    canonical: findIdx(headers, 'canonical link element 1'),
    urlEncoded: findIdx(headers, 'url encoded address'),
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
      idx.hash >= 0 ? safeText(row[idx.hash], 128) : null,
      idx.length >= 0 ? safeInt(row[idx.length]) : null,
      idx.canonical >= 0 ? safeText(row[idx.canonical], 2000) : null,
      idx.urlEncoded >= 0 ? safeText(row[idx.urlEncoded], 2000) : null,
      rowToJson(headers, row),
    ]);
  }

  const sql = `INSERT INTO url_structure_urls
    (id, client_id, csv_upload_id, month, url, hostname,
     content_type, status_code, status, indexability, indexability_status,
     content_hash, url_length, canonical_link_element, url_encoded_address, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  return inserts.map(args => ({ sql, args }));
}

export async function parse(raw: string, clientId: string, month: string, uploadId: string): Promise<number> {
  const stmts = buildUrlStructureUrlsStatements(raw, clientId, month, uploadId);
  for (let i = 0; i < stmts.length; i += 450) {
    await turso.batch(stmts.slice(i, i + 450), 'write');
  }
  return stmts.length;
}
