// Parser for the Screaming Frog Redirects bulk export.
//
// One row per redirect chain. Columns: Chain Type, Number of
// Redirects, Loop, Source, Temp Redirect in Chain, Address, Final
// Address, Final Indexability, Final Status Code, Anchor Text, Link
// Path, Link Position, then repeating Content/Status Code/Status/
// Redirect Type/Redirect URL columns 1 through 10 for each hop.
//
// We materialize the first 5 hops as hot columns (URL + status per
// hop). The full chain stays in raw_json for analysis of pathological
// 8+ hop chains.
//
// Pure builder: buildRedirectsStatements returns INSERT statements
// without executing them (for the atomic-ingest path, Task 8).
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

function safeBool(v: string | undefined): number {
  if (v === undefined || v === null) return 0;
  const s = String(v).trim().toLowerCase();
  return (s === 'true' || s === 'yes' || s === '1') ? 1 : 0;
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
export function buildRedirectsStatements(
  raw: string, clientId: string, month: string, uploadId: string,
): Array<{ sql: string; args: any[] }> {
  const result = Papa.parse(raw, { header: false, skipEmptyLines: true });
  const rows = result.data as string[][];
  if (rows.length < 2) return [];

  const headers = rows[0].map(h => (h || '').toString());
  const dataRows = rows.slice(1);

  const idxChainType = findIdx(headers, 'chain type');
  const idxNumRedirects = findIdx(headers, 'number of redirects');
  const idxLoop = findIdx(headers, 'loop');
  const idxSource = findIdx(headers, 'source');
  const idxTempRedirect = findIdx(headers, 'temp redirect in chain');
  const idxAddress = findIdx(headers, 'address');
  const idxFinalAddress = findIdx(headers, 'final address');
  const idxFinalIndexability = findIdx(headers, 'final indexability');
  const idxFinalStatus = findIdx(headers, 'final status code');
  const idxAnchorText = findIdx(headers, 'anchor text');
  const idxLinkPath = findIdx(headers, 'link path');

  // Hop indexes for 5 hops.
  const hopIdx: Array<{ url: number; status: number }> = [];
  for (let i = 1; i <= 5; i++) {
    hopIdx.push({
      url: findIdx(headers, `redirect url ${i}`),
      status: findIdx(headers, `status code ${i}`),
    });
  }

  // Each chain needs a Source. Without one, the row is unusable.
  if (idxSource < 0) return [];

  function rowToJson(row: string[]): string {
    const obj: Record<string, string> = {};
    for (let i = 0; i < headers.length && i < row.length; i++) {
      const key = (headers[i] || '').toString().trim();
      if (!key) continue;
      const val = (row[i] || '').toString().trim();
      if (val) obj[key] = val.slice(0, 2000);
    }
    return JSON.stringify(obj).slice(0, 100_000);
  }

  const inserts: any[][] = [];

  for (const row of dataRows) {
    const source = safeText(row[idxSource], 2000);
    if (!source) continue;
    const hostname = extractHostname(source);
    if (!hostname) continue;

    inserts.push([
      nanoid(), clientId, uploadId, month,
      idxChainType >= 0 ? safeText(row[idxChainType], 64) : null,
      source,
      hostname,
      idxFinalAddress >= 0 ? safeText(row[idxFinalAddress], 2000) : null,
      idxFinalStatus >= 0 ? safeInt(row[idxFinalStatus]) : null,
      idxFinalIndexability >= 0 ? safeText(row[idxFinalIndexability], 64) : null,
      idxNumRedirects >= 0 ? (safeInt(row[idxNumRedirects]) ?? 0) : 0,
      idxLoop >= 0 ? safeBool(row[idxLoop]) : 0,
      idxTempRedirect >= 0 ? safeBool(row[idxTempRedirect]) : 0,
      idxAnchorText >= 0 ? safeText(row[idxAnchorText], 500) : null,
      idxLinkPath >= 0 ? safeText(row[idxLinkPath], 1000) : null,
      hopIdx[0].url >= 0 ? safeText(row[hopIdx[0].url], 2000) : null,
      hopIdx[0].status >= 0 ? safeInt(row[hopIdx[0].status]) : null,
      hopIdx[1].url >= 0 ? safeText(row[hopIdx[1].url], 2000) : null,
      hopIdx[1].status >= 0 ? safeInt(row[hopIdx[1].status]) : null,
      hopIdx[2].url >= 0 ? safeText(row[hopIdx[2].url], 2000) : null,
      hopIdx[2].status >= 0 ? safeInt(row[hopIdx[2].status]) : null,
      hopIdx[3].url >= 0 ? safeText(row[hopIdx[3].url], 2000) : null,
      hopIdx[3].status >= 0 ? safeInt(row[hopIdx[3].status]) : null,
      hopIdx[4].url >= 0 ? safeText(row[hopIdx[4].url], 2000) : null,
      hopIdx[4].status >= 0 ? safeInt(row[hopIdx[4].status]) : null,
      rowToJson(row),
    ]);
  }

  const sql = `INSERT INTO redirect_chains
    (id, client_id, csv_upload_id, month, chain_type, source_url, source_hostname,
     final_url, final_status_code, final_indexability, hop_count, is_loop,
     temp_redirect_in_chain, anchor_text, link_path,
     hop1_url, hop1_status, hop2_url, hop2_status,
     hop3_url, hop3_status, hop4_url, hop4_status, hop5_url, hop5_status, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  return inserts.map(args => ({ sql, args }));
}

// Thin executor — back-compat for direct callers.
export async function parse(raw: string, clientId: string, month: string, uploadId: string): Promise<number> {
  const stmts = buildRedirectsStatements(raw, clientId, month, uploadId);
  for (let i = 0; i < stmts.length; i += 450) {
    await turso.batch(stmts.slice(i, i + 450), 'write');
  }
  return stmts.length;
}

export { extractHostname, findIdx };
