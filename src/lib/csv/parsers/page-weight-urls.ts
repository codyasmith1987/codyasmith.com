// Parser for Screaming Frog's validation_all.csv export.
//
// Despite the SF filename, the data is page size + carbon footprint
// (NOT html/schema validation), so the format is named page_weight by
// its content. Columns: Address, Content Type, Status Code, Status,
// Indexability, Indexability Status, Size (Bytes), Transferred (Bytes),
// Total Transferred (Bytes), CO2 (mg), Carbon Rating.
//
// CO2 (mg) + Carbon Rating is the unique tell that routes this export
// here rather than images_all (which also carries Size (Bytes) but
// requires IMG Inlinks + Dimensions). See detector.ts SIGNATURES.
//
// Pure builder: buildPageWeightUrlsStatements returns INSERT statements
// without executing them (for the atomic-ingest path in ingestCSV).
// Back-compat executor: parse() calls the builder and runs via
// turso.batch so direct callers still work.

import { nanoid } from 'nanoid';
import turso from '../../turso';
import {
  parseCsvHeaderAndRows, findIdx, safeText, safeInt, safeFloat,
  extractHostname, rowToJson,
} from './_url-parser-helpers';

// PURE: parse raw -> array of INSERT statements. No DB calls. Exported
// for the atomic-ingest path and the thin parse() executor below.
export function buildPageWeightUrlsStatements(
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
    sizeBytes: findIdx(headers, 'size (bytes)'),
    transferredBytes: findIdx(headers, 'transferred (bytes)'),
    totalTransferredBytes: findIdx(headers, 'total transferred (bytes)'),
    co2Mg: findIdx(headers, 'co2 (mg)'),
    carbonRating: findIdx(headers, 'carbon rating'),
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
      idx.indexability >= 0 ? safeText(row[idx.indexability], 64) : null,
      idx.sizeBytes >= 0 ? safeInt(row[idx.sizeBytes]) : null,
      idx.transferredBytes >= 0 ? safeInt(row[idx.transferredBytes]) : null,
      idx.totalTransferredBytes >= 0 ? safeInt(row[idx.totalTransferredBytes]) : null,
      idx.co2Mg >= 0 ? safeFloat(row[idx.co2Mg]) : null,
      idx.carbonRating >= 0 ? safeText(row[idx.carbonRating], 16) : null,
      rowToJson(headers, row),
    ]);
  }

  const sql = `INSERT INTO page_weight_urls
    (id, client_id, csv_upload_id, month, url, hostname,
     content_type, status_code, indexability, size_bytes, transferred_bytes,
     total_transferred_bytes, co2_mg, carbon_rating, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  return inserts.map(args => ({ sql, args }));
}

// Thin executor — back-compat for direct callers.
export async function parse(raw: string, clientId: string, month: string, uploadId: string): Promise<number> {
  const stmts = buildPageWeightUrlsStatements(raw, clientId, month, uploadId);
  for (let i = 0; i < stmts.length; i += 450) {
    await turso.batch(stmts.slice(i, i + 450), 'write');
  }
  return stmts.length;
}
