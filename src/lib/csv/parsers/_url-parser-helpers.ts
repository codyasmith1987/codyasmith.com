// Shared helpers for the per-URL Screaming Frog parsers
// (content_all, security_all, structured_data_all, accessibility_all,
// and the existing crawl_internal / redirects / images parsers).
//
// Common pattern: parse CSV with Papa, find columns case-insensitively
// by leading label, normalize the URL's hostname for indexing, write
// a raw_json catch-all for the full row, dedupe by URL within the
// upload, insert in batches via turso.batch.

import Papa from 'papaparse';

export function safeText(v: unknown, maxLen = 1000): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, maxLen) : null;
}

export function safeInt(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = parseInt(s.replace(/,/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

export function safeFloat(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = parseFloat(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function safeBoolFlag(v: unknown): number {
  if (v === undefined || v === null) return 0;
  const s = String(v).trim().toLowerCase();
  if (s === '' || s === 'no' || s === 'false' || s === '0' || s === 'missing' || s === 'absent' || s === 'none') return 0;
  return 1;
}

export function extractHostname(url: string): string | null {
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

export function findIdx(headers: string[], wanted: string): number {
  const w = wanted.toLowerCase();
  for (let i = 0; i < headers.length; i++) {
    if ((headers[i] || '').toLowerCase().trim() === w) return i;
  }
  return -1;
}

// Looser match: returns the first column whose header CONTAINS the
// wanted substring (case-insensitive). Useful when SF appends
// versioned suffixes ("WCAG 2.0 A Violations" vs "WCAG 2.0 AA").
export function findIdxContains(headers: string[], wanted: string): number {
  const w = wanted.toLowerCase();
  for (let i = 0; i < headers.length; i++) {
    if ((headers[i] || '').toLowerCase().includes(w)) return i;
  }
  return -1;
}

export function parseCsvHeaderAndRows(raw: string): { headers: string[]; rows: string[][] } | null {
  const result = Papa.parse(raw, { header: false, skipEmptyLines: true });
  const rows = result.data as string[][];
  if (rows.length < 2) return null;
  const headers = rows[0].map(h => (h || '').toString());
  return { headers, rows: rows.slice(1) };
}

export function rowToJson(headers: string[], row: string[], maxBytes = 50_000): string {
  const obj: Record<string, string> = {};
  for (let i = 0; i < headers.length && i < row.length; i++) {
    const key = (headers[i] || '').toString().trim();
    if (!key) continue;
    const val = (row[i] || '').toString().trim();
    if (val) obj[key] = val.slice(0, 2000);
  }
  return JSON.stringify(obj).slice(0, maxBytes);
}
