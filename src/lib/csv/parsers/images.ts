// Parser for the Screaming Frog Images bulk export (images_all.csv).
//
// One row per image asset on the crawled site. Columns: Address,
// Content Type, Size (Bytes), IMG Inlinks, Indexability, Indexability
// Status, Dimensions.
//
// Writes to image_urls (distinct from crawl_urls because internal_html
// only covers HTML pages; images warrant per-image queries: oversized,
// missing alt text, etc.).
//
// Pure builder: buildImagesStatements returns INSERT statements without
// executing them (for the atomic-ingest path, Task 8).
// Back-compat executor: parse() calls the builder and runs via
// turso.batch so direct callers still work.

import Papa from 'papaparse';
import { nanoid } from 'nanoid';
import turso from '../../turso';

function safeText(v: string | undefined, maxLen = 2000): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, maxLen) : null;
}

function safeInt(v: string | undefined): number | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = parseInt(s.replace(/,/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function extractHostname(url: string): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withProtocol);
    let h = u.hostname.toLowerCase();
    if (h.startsWith('www.')) h = h.slice(4);
    return h;
  } catch {
    return null;
  }
}

function findIdx(headers: string[], wanted: string): number {
  const w = wanted.toLowerCase();
  for (let i = 0; i < headers.length; i++) {
    if ((headers[i] || '').toLowerCase().trim() === w) return i;
  }
  return -1;
}

// PURE: parse raw -> array of INSERT statements. No DB calls. Exported
// for the atomic-ingest path (Task 8) and the thin parse() executor below.
export function buildImagesStatements(
  raw: string, clientId: string, month: string, uploadId: string,
): Array<{ sql: string; args: any[] }> {
  const result = Papa.parse(raw, { header: false, skipEmptyLines: true });
  const rows = result.data as string[][];
  if (rows.length < 2) return [];

  const headers = rows[0].map(h => (h || '').toString());
  const dataRows = rows.slice(1);

  const idxAddress = findIdx(headers, 'address');
  if (idxAddress < 0) return [];

  const idxContentType = findIdx(headers, 'content type');
  const idxSize = findIdx(headers, 'size (bytes)');
  const idxInlinks = findIdx(headers, 'img inlinks');
  const idxIndexability = findIdx(headers, 'indexability');
  const idxDimensions = findIdx(headers, 'dimensions');

  function rowToJson(row: string[]): string {
    const obj: Record<string, string> = {};
    for (let i = 0; i < headers.length && i < row.length; i++) {
      const key = (headers[i] || '').toString().trim();
      if (!key) continue;
      const val = (row[i] || '').toString().trim();
      if (val) obj[key] = val.slice(0, 2000);
    }
    return JSON.stringify(obj).slice(0, 50_000);
  }

  const seen = new Set<string>();
  const inserts: any[][] = [];

  for (const row of dataRows) {
    const url = safeText(row[idxAddress], 2000);
    if (!url) continue;
    const hostname = extractHostname(url);
    if (!hostname) continue;
    const dedupKey = url.toLowerCase();
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    inserts.push([
      nanoid(), clientId, uploadId, month, url, hostname,
      idxContentType >= 0 ? safeText(row[idxContentType], 128) : null,
      idxSize >= 0 ? safeInt(row[idxSize]) : null,
      idxInlinks >= 0 ? safeInt(row[idxInlinks]) : null,
      idxIndexability >= 0 ? safeText(row[idxIndexability], 64) : null,
      idxDimensions >= 0 ? safeText(row[idxDimensions], 64) : null,
      rowToJson(row),
    ]);
  }

  const sql = `INSERT INTO image_urls
    (id, client_id, csv_upload_id, month, url, hostname,
     content_type, size_bytes, inlinks_count, indexability, dimensions, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  return inserts.map(args => ({ sql, args }));
}

// Thin executor — back-compat for direct callers.
export async function parse(raw: string, clientId: string, month: string, uploadId: string): Promise<number> {
  const stmts = buildImagesStatements(raw, clientId, month, uploadId);
  for (let i = 0; i < stmts.length; i += 100) {
    await turso.batch(stmts.slice(i, i + 100), 'write');
  }
  return stmts.length;
}

export { extractHostname, findIdx };
