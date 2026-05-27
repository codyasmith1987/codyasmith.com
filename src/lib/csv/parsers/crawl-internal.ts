// Parser for the Screaming Frog Internal HTML / Internal All export.
//
// The Internal HTML CSV is the per-URL master file from SF: one row
// per crawled page with 50+ columns of per-page detail. Other SF
// reports (broken links, response codes, page titles, meta
// descriptions, H1, word count, crawl depth) are derivative filters
// over this same data, so one Internal HTML upload powers many
// portal insights at once.
//
// Strategy: capture 18 hot columns we know we want indexed access
// to, plus the entire SF row as raw_json so future insights can
// query columns we did not pre-index without re-uploading. Column
// detection is forgiving: SF uses "Title 1", "H1-1", "Meta
// Description 1" style suffixes; we match by leading label
// (case-insensitive) and fall back to null.
//
// Bulk insert: rows are inserted in batches via Promise.all chunks
// to stay under libSQL request-size limits on large crawls.

import Papa from 'papaparse';
import { nanoid } from 'nanoid';
import turso from '../../turso';

const BATCH_SIZE = 50;

function findHeaderIndex(headers: string[], wanted: string): number {
  const w = wanted.toLowerCase();
  for (let i = 0; i < headers.length; i++) {
    const h = (headers[i] || '').replace(/^\uFEFF/, '').toLowerCase().trim();
    if (h === w) return i;
    if (h === `${w} 1`) return i;
    if (h.startsWith(`${w}-1`)) return i;
    if (h.startsWith(`${w} 1 `)) return i;
  }
  return -1;
}

function safeInt(v: string | undefined): number | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  // Strip thousands separators if present (SF rarely emits them but
  // some locale exports do).
  const cleaned = s.replace(/,/g, '');
  const n = parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : null;
}

function safeFloat(v: string | undefined): number | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const cleaned = s.replace(/,/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function safeText(v: string | undefined, maxLen = 1000): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, maxLen);
}

function extractHostname(url: string): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
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

export async function parse(raw: string, clientId: string, month: string, uploadId: string): Promise<number> {
  const result = Papa.parse(raw, { header: false, skipEmptyLines: true });
  const rows = result.data as string[][];
  if (rows.length < 2) return 0;

  const headers = rows[0].map(h => (h || '').toString());
  const dataRows = rows.slice(1);

  const idxAddress = findHeaderIndex(headers, 'address');
  if (idxAddress < 0) return 0;

  // Hot column indexes. Anything not found stays at -1 and yields
  // null in the row tuple below.
  const idx = {
    statusCode: findHeaderIndex(headers, 'status code'),
    contentType: findHeaderIndex(headers, 'content type'),
    indexability: findHeaderIndex(headers, 'indexability'),
    indexabilityStatus: findHeaderIndex(headers, 'indexability status'),
    title: findHeaderIndex(headers, 'title'),
    titleLength: findHeaderIndex(headers, 'title 1 length'),
    metaDescription: findHeaderIndex(headers, 'meta description'),
    metaDescriptionLength: findHeaderIndex(headers, 'meta description 1 length'),
    h1: findHeaderIndex(headers, 'h1'),
    h2: findHeaderIndex(headers, 'h2'),
    wordCount: findHeaderIndex(headers, 'word count'),
    crawlDepth: findHeaderIndex(headers, 'crawl depth'),
    inlinks: findHeaderIndex(headers, 'inlinks'),
    outlinks: findHeaderIndex(headers, 'outlinks'),
    canonical: findHeaderIndex(headers, 'canonical link element'),
    responseTime: findHeaderIndex(headers, 'response time'),
    size: findHeaderIndex(headers, 'size'),
    lastModified: findHeaderIndex(headers, 'last modified'),
  };

  // Build raw_json by zipping headers with row values for every row.
  // Bounded length so a pathological CSV cannot blow up the DB.
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

  // Dedupe by URL within the upload so a row repeated in the CSV
  // does not produce duplicates.
  const seen = new Set<string>();
  const inserts: Array<any[]> = [];

  for (const row of dataRows) {
    const url = safeText(row[idxAddress], 2000);
    if (!url) continue;
    const hostname = extractHostname(url);
    if (!hostname) continue;
    const dedupKey = url.toLowerCase();
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    // Response time in SF is often in seconds with decimals. Store
    // milliseconds (rounded). If the parser sees an integer already,
    // assume it is milliseconds.
    let responseTimeMs: number | null = null;
    if (idx.responseTime >= 0) {
      const rt = safeFloat(row[idx.responseTime]);
      if (rt !== null) {
        responseTimeMs = rt < 30 ? Math.round(rt * 1000) : Math.round(rt);
      }
    }

    inserts.push([
      nanoid(), clientId, uploadId, month, url, hostname,
      idx.statusCode >= 0 ? safeInt(row[idx.statusCode]) : null,
      idx.contentType >= 0 ? safeText(row[idx.contentType], 128) : null,
      idx.indexability >= 0 ? safeText(row[idx.indexability], 64) : null,
      idx.indexabilityStatus >= 0 ? safeText(row[idx.indexabilityStatus], 256) : null,
      idx.title >= 0 ? safeText(row[idx.title], 500) : null,
      idx.titleLength >= 0 ? safeInt(row[idx.titleLength]) : null,
      idx.metaDescription >= 0 ? safeText(row[idx.metaDescription], 1000) : null,
      idx.metaDescriptionLength >= 0 ? safeInt(row[idx.metaDescriptionLength]) : null,
      idx.h1 >= 0 ? safeText(row[idx.h1], 500) : null,
      idx.h2 >= 0 ? safeText(row[idx.h2], 500) : null,
      idx.wordCount >= 0 ? safeInt(row[idx.wordCount]) : null,
      idx.crawlDepth >= 0 ? safeInt(row[idx.crawlDepth]) : null,
      idx.inlinks >= 0 ? safeInt(row[idx.inlinks]) : null,
      idx.outlinks >= 0 ? safeInt(row[idx.outlinks]) : null,
      idx.canonical >= 0 ? safeText(row[idx.canonical], 2000) : null,
      responseTimeMs,
      idx.size >= 0 ? safeInt(row[idx.size]) : null,
      idx.lastModified >= 0 ? safeText(row[idx.lastModified], 64) : null,
      rowToJson(row),
    ]);
  }

  const sql = `INSERT INTO crawl_urls
    (id, client_id, csv_upload_id, month, url, hostname,
     status_code, content_type, indexability, indexability_status,
     title, title_length, meta_description, meta_description_length,
     h1, h2, word_count, crawl_depth, inlinks_count, outlinks_count,
     canonical_url, response_time_ms, size_bytes, last_modified, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  for (let i = 0; i < inserts.length; i += BATCH_SIZE) {
    const chunk = inserts.slice(i, i + BATCH_SIZE);
    await Promise.all(chunk.map(args => turso.execute({ sql, args })));
  }

  return inserts.length;
}

// Exported for unit tests.
export { extractHostname, findHeaderIndex };
