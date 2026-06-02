// Parser for Screaming Frog link-relationship exports.
//
// Handles all_inlinks, all_outlinks, all_anchor_text, all_image_inlinks,
// absolute_outlinks, pathrelative_outlinks, rootrelative_outlinks,
// internal_outlinks_with_no_anchor_text, links_all, and the
// ~25 issue-context-filtered *_inlinks variants. Each file shares the
// same underlying shape: one row per (Source -> Destination) link with
// Type, Anchor, Status Code, Follow, Target, Rel, Link Position,
// Link Origin, Link Path. The inlinks variants add extra context
// columns we don't need to hot-promote.
//
// Source-file scoped dedup: each filename writes under its own
// source_file label (filename without extension, path stripped). A
// re-upload of all_inlinks.csv replaces just those rows; siblings
// like all_outlinks.csv stay untouched. The format_sources sweep in
// csv/index.ts skips the 'links' format for the same reason
// 'issue_urls' and 'unknown_stored' are skipped.

import Papa from 'papaparse';
import { nanoid } from 'nanoid';
import turso from '../../turso';

const BATCH_SIZE = 50;
// How many multi-row INSERT statements to bundle into one turso.batch call.
// Each statement already covers up to BATCH_SIZE rows, so this is
// FLUSH_CHUNK * BATCH_SIZE rows per round-trip (20 * 50 = 1000 rows).
const FLUSH_CHUNK = 20;

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
  if (v === undefined || v === null) return 1;
  const s = String(v).trim().toLowerCase();
  // Default to follow=1 if blank. Explicit 'false'/'no'/'0' flips it.
  return (s === 'false' || s === 'no' || s === '0') ? 0 : 1;
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

function deriveSourceFile(filename: string): string {
  // Strip path, strip .csv, lowercase. Used as the source_file tag
  // so per-file dedup works regardless of which folder SF dropped
  // the file into.
  const base = filename.replace(/^.*[\\/]/, '').replace(/\.csv$/i, '');
  return base.toLowerCase();
}

export async function parse(
  raw: string,
  clientId: string,
  month: string,
  uploadId: string,
  filename: string,
): Promise<number> {
  return parseLinksWithDb(raw, clientId, month, uploadId, filename, turso);
}

// Test-injectable variant. The db param defaults to the prod singleton in
// parse(); tests inject an in-memory client to avoid touching the remote DB.
export async function parseLinksWithDb(
  raw: string,
  clientId: string,
  month: string,
  uploadId: string,
  filename: string,
  db: typeof turso,
): Promise<number> {
  const result = Papa.parse(raw, { header: false, skipEmptyLines: true });
  const rows = result.data as string[][];
  if (rows.length < 2) return 0;

  const headers = rows[0].map(h => (h || '').toString());
  const dataRows = rows.slice(1);

  const idxType = findIdx(headers, 'type');
  const idxSource = findIdx(headers, 'source');
  const idxDestination = findIdx(headers, 'destination');
  const idxAnchor = findIdx(headers, 'anchor');
  const idxAltText = findIdx(headers, 'alt text');
  const idxStatus = findIdx(headers, 'status code');
  const idxFollow = findIdx(headers, 'follow');
  const idxTarget = findIdx(headers, 'target');
  const idxRel = findIdx(headers, 'rel');
  const idxLinkPosition = findIdx(headers, 'link position');
  const idxLinkOrigin = findIdx(headers, 'link origin');
  const idxLinkPath = findIdx(headers, 'link path');
  const idxSize = findIdx(headers, 'size (bytes)');
  const idxLength = findIdx(headers, 'length');

  // Source and Destination are mandatory; if either is missing this
  // file doesn't match the link-graph shape and we bail clean.
  if (idxSource < 0 || idxDestination < 0) return 0;

  const sourceFile = deriveSourceFile(filename);

  // Per-source_file dedup: clear previous rows for this client + month
  // + source_file before inserting. Uploading all_inlinks.csv replaces
  // its own rows but leaves all_outlinks.csv's rows alone.
  await db.execute({
    sql: `DELETE FROM link_graph WHERE client_id = ? AND month = ? AND source_file = ?`,
    args: [clientId, month, sourceFile],
  });

  // Collect all multi-row INSERT statements, then dispatch them in
  // chunks via db.batch. Each statement covers up to BATCH_SIZE rows
  // (multi-row VALUES syntax), so FLUSH_CHUNK statements per batch call
  // = FLUSH_CHUNK * BATCH_SIZE rows per round-trip (20 * 50 = 1000).
  // Previously flush() issued one db.execute per statement — an 8,013-row
  // file produced ceil(8013/50) = 161 sequential round-trips and 524'd.
  const statements: Array<{ sql: string; args: any[] }> = [];
  let batch: any[][] = [];

  const buildStatement = (b: any[][]): { sql: string; args: any[] } => {
    const placeholders = b.map(() =>
      '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).join(',');
    const flat: any[] = [];
    for (const row of b) flat.push(...row);
    return {
      sql: `INSERT INTO link_graph (
        id, client_id, csv_upload_id, month, source_file, link_type,
        source_url, source_hostname, destination_url, destination_hostname,
        anchor_text, alt_text, status_code, follow, target, rel,
        link_position, link_origin, link_path, size_bytes, anchor_length,
        raw_json
      ) VALUES ${placeholders}`,
      args: flat,
    };
  };

  for (const row of dataRows) {
    const source = safeText(row[idxSource]);
    const destination = safeText(row[idxDestination]);
    if (!source || !destination) continue;

    const linkType = idxType >= 0 ? safeText(row[idxType], 50) : null;
    const anchor = idxAnchor >= 0 ? safeText(row[idxAnchor], 500) : null;
    const altText = idxAltText >= 0 ? safeText(row[idxAltText], 500) : null;
    const statusCode = idxStatus >= 0 ? safeInt(row[idxStatus]) : null;
    const follow = idxFollow >= 0 ? safeBool(row[idxFollow]) : 1;
    const target = idxTarget >= 0 ? safeText(row[idxTarget], 50) : null;
    const rel = idxRel >= 0 ? safeText(row[idxRel], 200) : null;
    const linkPosition = idxLinkPosition >= 0 ? safeText(row[idxLinkPosition], 50) : null;
    const linkOrigin = idxLinkOrigin >= 0 ? safeText(row[idxLinkOrigin], 50) : null;
    const linkPath = idxLinkPath >= 0 ? safeText(row[idxLinkPath], 500) : null;
    const sizeBytes = idxSize >= 0 ? safeInt(row[idxSize]) : null;
    const anchorLength = idxLength >= 0 ? safeInt(row[idxLength]) : null;

    // Stash any non-hot columns in raw_json for future analysis.
    const rawObj: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i];
      if (!h) continue;
      const v = row[i];
      if (v === undefined || v === null || v === '') continue;
      rawObj[h] = String(v);
    }

    batch.push([
      nanoid(),
      clientId,
      uploadId,
      month,
      sourceFile,
      linkType,
      source,
      extractHostname(source),
      destination,
      extractHostname(destination),
      anchor,
      altText,
      statusCode,
      follow,
      target,
      rel,
      linkPosition,
      linkOrigin,
      linkPath,
      sizeBytes,
      anchorLength,
      JSON.stringify(rawObj),
    ]);

    if (batch.length >= BATCH_SIZE) {
      statements.push(buildStatement(batch));
      batch = [];
    }
  }

  if (batch.length > 0) {
    statements.push(buildStatement(batch));
  }

  // Send all statements in chunks via db.batch — one round-trip per chunk.
  for (let i = 0; i < statements.length; i += FLUSH_CHUNK) {
    await db.batch(statements.slice(i, i + FLUSH_CHUNK), 'write');
  }

  // Row count = sum of rows across all statements. Each statement's args
  // length / 22 (columns) gives the row count for that statement.
  let inserted = 0;
  for (const stmt of statements) {
    inserted += stmt.args.length / 22;
  }
  return inserted;
}
