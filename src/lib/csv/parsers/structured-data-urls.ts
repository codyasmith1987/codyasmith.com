// Parser for Screaming Frog's structured_data_all.csv export.
//
// Per-URL schema markup quality. Columns include Address, Errors,
// Warnings, Rich Result Errors, Rich Result Warnings, Rich Result
// Features, Feature-1..N, Total Types, Unique Types, Type-1..N.
// We capture summary counts as hot columns and roll the Feature-N
// and Type-N columns into comma-joined strings.
//
// Pure builder: buildStructuredDataUrlsStatements returns INSERT
// statements without executing them (for the atomic-ingest path,
// Task 8). Back-compat executor: parse() calls the builder and
// runs via turso.batch so direct callers still work.

import { nanoid } from 'nanoid';
import turso from '../../turso';
import {
  parseCsvHeaderAndRows, findIdx, safeText, safeInt,
  extractHostname, rowToJson,
} from './_url-parser-helpers';

function collectIndexed(headers: string[], row: string[], prefix: string, maxN = 10): string {
  // Pulls every "Prefix-N" column value (e.g., "Feature-1", "Type-1")
  // for N from 1 to maxN. Returns a comma-joined string of non-empty
  // values.
  const values: string[] = [];
  for (let n = 1; n <= maxN; n++) {
    const i = findIdx(headers, `${prefix}-${n}`);
    if (i < 0) continue;
    const v = (row[i] || '').toString().trim();
    if (v) values.push(v);
  }
  return values.join(', ').slice(0, 2000);
}

// PURE: parse raw -> array of INSERT statements. No DB calls. Exported
// for the atomic-ingest path (Task 8) and the thin parse() executor below.
export function buildStructuredDataUrlsStatements(
  raw: string, clientId: string, month: string, uploadId: string,
): Array<{ sql: string; args: any[] }> {
  const parsed = parseCsvHeaderAndRows(raw);
  if (!parsed) return [];
  const { headers, rows } = parsed;

  const idx = {
    address: findIdx(headers, 'address'),
    errors: findIdx(headers, 'errors'),
    warnings: findIdx(headers, 'warnings'),
    richErrors: findIdx(headers, 'rich result errors'),
    richWarnings: findIdx(headers, 'rich result warnings'),
    totalTypes: findIdx(headers, 'total types'),
    uniqueTypes: findIdx(headers, 'unique types'),
    indexability: findIdx(headers, 'indexability'),
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

    const featuresList = collectIndexed(headers, row, 'feature', 20);
    const typesList = collectIndexed(headers, row, 'type', 20);

    inserts.push([
      nanoid(), clientId, uploadId, month, url, hostname,
      idx.errors >= 0 ? safeInt(row[idx.errors]) : null,
      idx.warnings >= 0 ? safeInt(row[idx.warnings]) : null,
      idx.richErrors >= 0 ? safeInt(row[idx.richErrors]) : null,
      idx.richWarnings >= 0 ? safeInt(row[idx.richWarnings]) : null,
      idx.totalTypes >= 0 ? safeInt(row[idx.totalTypes]) : null,
      idx.uniqueTypes >= 0 ? safeInt(row[idx.uniqueTypes]) : null,
      typesList || null,
      featuresList || null,
      idx.indexability >= 0 ? safeText(row[idx.indexability], 64) : null,
      rowToJson(headers, row),
    ]);
  }

  const sql = `INSERT INTO structured_data_urls
    (id, client_id, csv_upload_id, month, url, hostname,
     error_count, warning_count, rich_result_errors, rich_result_warnings,
     total_types, unique_types, types_list, rich_result_features,
     indexability, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  return inserts.map(args => ({ sql, args }));
}

// Thin executor — back-compat for direct callers.
export async function parse(raw: string, clientId: string, month: string, uploadId: string): Promise<number> {
  const stmts = buildStructuredDataUrlsStatements(raw, clientId, month, uploadId);
  for (let i = 0; i < stmts.length; i += 450) {
    await turso.batch(stmts.slice(i, i + 450), 'write');
  }
  return stmts.length;
}
