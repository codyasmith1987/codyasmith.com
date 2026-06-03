// Parser for Screaming Frog's javascript_all.csv export.
//
// Per-URL HTML-vs-rendered comparison: word count / title / H1 / meta /
// canonical before and after JS rendering, plus the JS link counts. The
// "Rendered HTML Word Count" column is the unique tell (no other SF export
// has pre/post-render columns), so it routes here rather than crawl_internal.
//
// Pure builder + thin executor, same Class-A pattern as canonical-urls.ts.

import { nanoid } from 'nanoid';
import turso from '../../turso';
import {
  parseCsvHeaderAndRows, findIdx, safeText, safeInt, safeFloat,
  extractHostname, rowToJson,
} from './_url-parser-helpers';

export function buildJavascriptUrlsStatements(
  raw: string, clientId: string, month: string, uploadId: string,
): Array<{ sql: string; args: any[] }> {
  const parsed = parseCsvHeaderAndRows(raw);
  if (!parsed) return [];
  const { headers, rows } = parsed;

  const idx = {
    address: findIdx(headers, 'address'),
    statusCode: findIdx(headers, 'status code'),
    htmlWordCount: findIdx(headers, 'html word count'),
    renderedWordCount: findIdx(headers, 'rendered html word count'),
    wordCountChange: findIdx(headers, 'word count change'),
    jsWordCountPct: findIdx(headers, 'js word count %'),
    htmlTitle: findIdx(headers, 'html title'),
    renderedTitle: findIdx(headers, 'rendered html title'),
    htmlH1: findIdx(headers, 'html h1'),
    renderedH1: findIdx(headers, 'rendered html h1'),
    htmlMetaDesc: findIdx(headers, 'html meta description'),
    renderedMetaDesc: findIdx(headers, 'rendered html meta description'),
    htmlCanonical: findIdx(headers, 'html canonical'),
    renderedCanonical: findIdx(headers, 'rendered html canonical'),
    uniqueInlinks: findIdx(headers, 'unique inlinks'),
    uniqueJsInlinks: findIdx(headers, 'unique js inlinks'),
    uniqueOutlinks: findIdx(headers, 'unique outlinks'),
    uniqueJsOutlinks: findIdx(headers, 'unique js outlinks'),
    htmlMetaRobots: findIdx(headers, 'html meta robots 1'),
    renderedMetaRobots: findIdx(headers, 'rendered html meta robots 1'),
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
      idx.statusCode >= 0 ? safeInt(row[idx.statusCode]) : null,
      idx.htmlWordCount >= 0 ? safeInt(row[idx.htmlWordCount]) : null,
      idx.renderedWordCount >= 0 ? safeInt(row[idx.renderedWordCount]) : null,
      idx.wordCountChange >= 0 ? safeInt(row[idx.wordCountChange]) : null,
      idx.jsWordCountPct >= 0 ? safeFloat(row[idx.jsWordCountPct]) : null,
      idx.htmlTitle >= 0 ? safeText(row[idx.htmlTitle], 1000) : null,
      idx.renderedTitle >= 0 ? safeText(row[idx.renderedTitle], 1000) : null,
      idx.htmlH1 >= 0 ? safeText(row[idx.htmlH1], 1000) : null,
      idx.renderedH1 >= 0 ? safeText(row[idx.renderedH1], 1000) : null,
      idx.htmlMetaDesc >= 0 ? safeText(row[idx.htmlMetaDesc], 2000) : null,
      idx.renderedMetaDesc >= 0 ? safeText(row[idx.renderedMetaDesc], 2000) : null,
      idx.htmlCanonical >= 0 ? safeText(row[idx.htmlCanonical], 2000) : null,
      idx.renderedCanonical >= 0 ? safeText(row[idx.renderedCanonical], 2000) : null,
      idx.uniqueInlinks >= 0 ? safeInt(row[idx.uniqueInlinks]) : null,
      idx.uniqueJsInlinks >= 0 ? safeInt(row[idx.uniqueJsInlinks]) : null,
      idx.uniqueOutlinks >= 0 ? safeInt(row[idx.uniqueOutlinks]) : null,
      idx.uniqueJsOutlinks >= 0 ? safeInt(row[idx.uniqueJsOutlinks]) : null,
      idx.htmlMetaRobots >= 0 ? safeText(row[idx.htmlMetaRobots], 256) : null,
      idx.renderedMetaRobots >= 0 ? safeText(row[idx.renderedMetaRobots], 256) : null,
      rowToJson(headers, row),
    ]);
  }

  const sql = `INSERT INTO javascript_urls
    (id, client_id, csv_upload_id, month, url, hostname,
     status_code, html_word_count, rendered_word_count, word_count_change, js_word_count_pct,
     html_title, rendered_title, html_h1, rendered_h1, html_meta_description, rendered_meta_description,
     html_canonical, rendered_canonical, unique_inlinks, unique_js_inlinks, unique_outlinks, unique_js_outlinks,
     html_meta_robots, rendered_meta_robots, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  return inserts.map(args => ({ sql, args }));
}

export async function parse(raw: string, clientId: string, month: string, uploadId: string): Promise<number> {
  const stmts = buildJavascriptUrlsStatements(raw, clientId, month, uploadId);
  for (let i = 0; i < stmts.length; i += 450) {
    await turso.batch(stmts.slice(i, i + 450), 'write');
  }
  return stmts.length;
}
