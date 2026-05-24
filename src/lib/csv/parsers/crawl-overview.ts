// Screaming Frog Crawl Overview parser.
//
// Crawl Overview is a 30+ section metadata file, not a flat CSV. The
// first 8 lines are document metadata (site crawled, timestamps).
// After that, lines are either a section header (single quoted value
// on its own row), a column header row, or data rows.
//
// Old parser captured only 8 metric keys (total_urls, internal_urls,
// etc.). The file actually has 200+ key-value pairs organized into
// sections: Internal, External, Security, Response Codes, URL, Page
// Titles, Meta Description, Meta Keywords, H1, H2, Content, Images,
// Canonicals, Pagination, Directives, Hreflang, JavaScript, Links,
// AMP, Structured Data, Sitemaps, PageSpeed, Mobile, Accessibility,
// Custom Search/Extraction/JavaScript, Analytics, Search Console,
// Validation, Link Metrics, AI, Depth, and Inlinks.
//
// New parser captures every (section, label, value) triple as a
// metrics row with:
//   - category = lowercased section name with non-alpha replaced by _
//   - metric_key = lowercased label with non-alpha replaced by _
//   - metric_value = the numeric value from the URLs column
//
// Document-metadata lines (Site Crawled, Start Date/Time, Elapsed,
// Report Date/Time) and percentage strings are skipped or stored as
// separate text-valued metrics where they make sense. Non-numeric
// values are skipped.

import { nanoid } from 'nanoid';
import turso from '../../turso';

const SECTION_RE = /^"([A-Za-z][A-Za-z0-9 ()/\-,]*?)"$/;
const SKIP_TOP_KEYS = new Set([
  'site crawled',
  'start date',
  'start time',
  'last modified date',
  'last modified time',
  'elapsed',
  'report date',
  'report time',
]);

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function parseNumeric(raw: string): number | null {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim().replace(/^"|"$/g, '').replace(/,/g, '');
  if (s === '' || s === '-') return null;
  // Strip a trailing % sign so percent columns parse as the number.
  const cleaned = s.endsWith('%') ? s.slice(0, -1) : s;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function splitCsvLine(line: string): string[] {
  // Lightweight CSV-line tokenizer that handles quoted fields with
  // commas inside them. The crawl-overview file is well-formed (SF
  // always quotes label cells); avoids pulling Papa for a tiny job.
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; continue; }
      inQuotes = !inQuotes;
      continue;
    }
    if (c === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

export async function parse(raw: string, clientId: string, month: string, uploadId: string): Promise<number> {
  const lines = raw.replace(/\r\n/g, '\n').replace(/^﻿/, '').split('\n');
  let currentSection = 'crawl';

  // For backward compatibility with the existing portal surfaces
  // that read summary-level keys like total_urls and internal_urls,
  // map a few well-known labels (regardless of section) to the
  // legacy metric_keys. New rows still get the prefixed key too so
  // section context is preserved.
  const LEGACY_ALIASES: Array<{ pattern: RegExp; key: string }> = [
    { pattern: /^total urls$/i, key: 'total_urls' },
    { pattern: /^total urls encountered$/i, key: 'total_urls' },
    { pattern: /^total urls crawled$/i, key: 'urls_crawled' },
    { pattern: /^total internal urls$/i, key: 'internal_urls' },
    { pattern: /^total external urls$/i, key: 'external_urls' },
    { pattern: /^html$/i, key: 'resource_html' },
    { pattern: /^javascript$/i, key: 'resource_javascript' },
    { pattern: /^css$/i, key: 'resource_css' },
    { pattern: /^images$/i, key: 'resource_images' },
  ];

  // Collect all the (category, key, value) triples first, then
  // batch-insert. Old version did one sequential turso.execute per
  // metric; an expanded crawl-overview file produces 200+ metrics
  // and 200 sequential round-trips against a remote Turso costs
  // measurable seconds per upload.
  const dedup = new Map<string, [string, string, number]>();
  function queueMetric(category: string, key: string, value: number): void {
    const dedupKey = `${category}|${key}`;
    dedup.set(dedupKey, [category, key, value]);
  }

  // Track which sections we've already seen the header row of so we
  // can ignore "Summary,URLs,% of Total,..." style header lines.
  const seenHeaderInSection = new Set<string>();

  for (const rawLine of lines) {
    if (!rawLine.trim()) continue;
    const cells = splitCsvLine(rawLine);
    if (cells.length === 0 || !cells[0]) continue;

    // Section header: single-cell quoted line, e.g. "Internal".
    if (SECTION_RE.test(rawLine.trim())) {
      const match = rawLine.trim().match(SECTION_RE);
      if (match) {
        currentSection = slugify(match[1]) || 'crawl';
        seenHeaderInSection.delete(currentSection);
      }
      continue;
    }

    const label = cells[0].toLowerCase();

    // Skip the document-metadata lines at the top of the file. They
    // emit a value in cell[1] but it is a date/time string, not a
    // metric.
    if (SKIP_TOP_KEYS.has(label)) continue;

    // The first row of each tabular section is a column header
    // row, e.g. "Summary,URLs,% of Total,Total URLs,Total URLs
    // Description". Detect by the URL header.
    if (!seenHeaderInSection.has(currentSection) && cells.some(c => c.toLowerCase() === 'urls')) {
      seenHeaderInSection.add(currentSection);
      continue;
    }

    // Data row: cell[0] is the label, cell[1] is the URL count.
    // Some sections (Depth, Inlinks) use different column orders; we
    // accept any numeric value in the cells after [0].
    let value: number | null = null;
    for (let i = 1; i < Math.min(cells.length, 4); i++) {
      value = parseNumeric(cells[i]);
      if (value !== null && !cells[i].endsWith('%')) break;
    }
    if (value === null) continue;

    // Write the section-scoped key.
    const key = slugify(label);
    if (key) {
      queueMetric(currentSection, key, value);
    }

    // Write legacy aliases so the existing portal surfaces (which
    // query category='crawl' + metric_key='total_urls' etc.) keep
    // working unchanged.
    for (const alias of LEGACY_ALIASES) {
      if (alias.pattern.test(cells[0])) {
        queueMetric('crawl', alias.key, value);
        break;
      }
    }
  }

  // Batch-insert via turso.batch. Each statement is its own
  // INSERT ... ON CONFLICT so existing values get updated. Chunks
  // of 100 keep individual batch payloads small.
  const statements: Array<{ sql: string; args: any[] }> = [];
  const sql = `INSERT INTO metrics (id, client_id, month, category, metric_key, metric_value, source, csv_upload_id)
               VALUES (?, ?, ?, ?, ?, ?, 'csv_upload', ?)
               ON CONFLICT(client_id, month, category, metric_key)
               DO UPDATE SET metric_value = excluded.metric_value, csv_upload_id = excluded.csv_upload_id`;
  for (const [, [category, key, value]] of dedup) {
    statements.push({ sql, args: [nanoid(), clientId, month, category, key, value, uploadId] });
  }

  const CHUNK = 100;
  for (let i = 0; i < statements.length; i += CHUNK) {
    const chunk = statements.slice(i, i + CHUNK);
    await turso.batch(chunk, 'write');
  }

  return statements.length;
}
