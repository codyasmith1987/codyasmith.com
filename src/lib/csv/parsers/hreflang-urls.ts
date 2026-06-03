// Parser for Screaming Frog's hreflang_all.csv export.
//
// Per-URL hreflang annotations. SF emits N repeating column groups
// ("HTML hreflang 1", "HTML hreflang 1 URL", "HTTP hreflang 1", ...). We type
// the first group (the common case) + an annotation count, and preserve EVERY
// group in raw_json so no locale is lost. "HTML hreflang 1" is the unique tell
// (canonicals/directives carry Occurrences but never hreflang columns).
//
// Normalizing all N groups into a child annotations table is a future step,
// warranted once a multi-locale client actually ships hreflang data; until
// then raw_json holds the full superset.

import { nanoid } from 'nanoid';
import turso from '../../turso';
import {
  parseCsvHeaderAndRows, findIdx, safeText, safeInt,
  extractHostname, rowToJson,
} from './_url-parser-helpers';

// Count distinct annotation groups (N) that have a non-empty language value
// in any source (html/http/sitemap), so an empty crawl reports 0.
function countHreflangGroups(headers: string[], row: string[]): number {
  const groups = new Set<number>();
  for (let i = 0; i < headers.length; i++) {
    const m = (headers[i] || '').toLowerCase().trim().match(/^(?:html|http|sitemap) hreflang (\d+)$/);
    if (m) {
      const val = (row[i] || '').toString().trim();
      if (val) groups.add(Number(m[1]));
    }
  }
  return groups.size;
}

export function buildHreflangUrlsStatements(
  raw: string, clientId: string, month: string, uploadId: string,
): Array<{ sql: string; args: any[] }> {
  const parsed = parseCsvHeaderAndRows(raw);
  if (!parsed) return [];
  const { headers, rows } = parsed;

  const idx = {
    address: findIdx(headers, 'address'),
    title: findIdx(headers, 'title 1'),
    occurrences: findIdx(headers, 'occurrences'),
    indexability: findIdx(headers, 'indexability'),
    indexabilityStatus: findIdx(headers, 'indexability status'),
    htmlHl1: findIdx(headers, 'html hreflang 1'),
    htmlHl1Url: findIdx(headers, 'html hreflang 1 url'),
    httpHl1: findIdx(headers, 'http hreflang 1'),
    httpHl1Url: findIdx(headers, 'http hreflang 1 url'),
    sitemapHl1: findIdx(headers, 'sitemap hreflang 1'),
    sitemapHl1Url: findIdx(headers, 'sitemap hreflang 1 url'),
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
      idx.title >= 0 ? safeText(row[idx.title], 1000) : null,
      idx.occurrences >= 0 ? safeInt(row[idx.occurrences]) : null,
      idx.indexability >= 0 ? safeText(row[idx.indexability], 64) : null,
      idx.indexabilityStatus >= 0 ? safeText(row[idx.indexabilityStatus], 256) : null,
      countHreflangGroups(headers, row),
      idx.htmlHl1 >= 0 ? safeText(row[idx.htmlHl1], 32) : null,
      idx.htmlHl1Url >= 0 ? safeText(row[idx.htmlHl1Url], 2000) : null,
      idx.httpHl1 >= 0 ? safeText(row[idx.httpHl1], 32) : null,
      idx.httpHl1Url >= 0 ? safeText(row[idx.httpHl1Url], 2000) : null,
      idx.sitemapHl1 >= 0 ? safeText(row[idx.sitemapHl1], 32) : null,
      idx.sitemapHl1Url >= 0 ? safeText(row[idx.sitemapHl1Url], 2000) : null,
      rowToJson(headers, row),
    ]);
  }

  const sql = `INSERT INTO hreflang_urls
    (id, client_id, csv_upload_id, month, url, hostname,
     title, occurrences, indexability, indexability_status, hreflang_count,
     html_hreflang_1, html_hreflang_1_url, http_hreflang_1, http_hreflang_1_url,
     sitemap_hreflang_1, sitemap_hreflang_1_url, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  return inserts.map(args => ({ sql, args }));
}

export async function parse(raw: string, clientId: string, month: string, uploadId: string): Promise<number> {
  const stmts = buildHreflangUrlsStatements(raw, clientId, month, uploadId);
  for (let i = 0; i < stmts.length; i += 450) {
    await turso.batch(stmts.slice(i, i + 450), 'write');
  }
  return stmts.length;
}
