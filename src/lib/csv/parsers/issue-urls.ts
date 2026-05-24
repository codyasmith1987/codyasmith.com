// Parser for Screaming Frog per-issue URL CSV exports.
//
// SF generates one CSV per issue category (h1_missing.csv,
// page_titles_below_30_characters.csv, meta_description_over_155_characters.csv,
// etc.) — each lists the URLs that have that issue. The filename maps
// deterministically to an issue display name that matches what the
// issues_overview.csv aggregate reports.
//
// The mapping is fixed: each supported filename maps to the exact
// issue_name string that appears in site_issues.issue_name. Unmapped
// filenames are not ingested (the caller's format detector decides
// whether to route to this parser).
//
// Each row's first column is "Address" (the URL). All other columns
// go into `extras` as JSON so the pop-out can show issue-specific
// context (e.g., current title and its length for length-issue popouts).

import Papa from 'papaparse';
import { nanoid } from 'nanoid';
import turso from '../../turso';

// Filename -> exact issue_name as it appears in site_issues.
// Source: SF's issues_overview.csv and the matching per-issue CSV
// filenames it generates alongside. New mappings added as new
// per-issue CSVs ship; unmapped filenames are skipped.
export const ISSUE_CSV_FILENAME_MAP: Record<string, string> = {
  // Headings
  'h1_missing.csv': 'H1: Missing',
  'h1_duplicate.csv': 'H1: Duplicate',
  'h1_multiple.csv': 'H1: Multiple',
  'h2_missing.csv': 'H2: Missing',
  'h2_duplicate.csv': 'H2: Duplicate',
  'h2_multiple.csv': 'H2: Multiple',
  // Page titles
  'page_titles_missing.csv': 'Page Titles: Missing',
  'page_titles_duplicate.csv': 'Page Titles: Duplicate',
  'page_titles_below_30_characters.csv': 'Page Titles: Below 30 Characters',
  'page_titles_over_60_characters.csv': 'Page Titles: Over 60 Characters',
  'page_titles_over_561_pixels.csv': 'Page Titles: Over 561 Pixels',
  // Meta descriptions
  'meta_description_missing.csv': 'Meta Description: Missing',
  'meta_description_duplicate.csv': 'Meta Description: Duplicate',
  'meta_description_over_155_characters.csv': 'Meta Description: Over 155 Characters',
  'meta_description_over_985_pixels.csv': 'Meta Description: Over 985 Pixels',
  // Canonicals
  'canonicals_missing.csv': 'Canonicals: Missing',
  // Images
  'images_missing_alt_text.csv': 'Images: Missing Alt Text',
  'images_missing_alt_attribute.csv': 'Images: Missing Alt Attribute',
  'images_over_100_kb.csv': 'Images: Over 100 KB',
  'images_missing_size_attributes.csv': 'Images: Missing Size Attributes',
  // Security headers
  'security_missing_contentsecuritypolicy_header.csv': 'Security: Missing Content-Security-Policy Header',
  'security_missing_secure_referrerpolicy_header.csv': 'Security: Missing Secure Referrer-Policy Header',
  'security_missing_xcontenttypeoptions_header.csv': 'Security: Missing X-Content-Type-Options Header',
  'security_missing_xframeoptions_header.csv': 'Security: Missing X-Frame-Options Header',
  // Content
  'content_low_content_pages.csv': 'Content: Low Content Pages',
};

/**
 * Look up the issue_name for a CSV filename. Returns null when the
 * filename is not a known per-issue export. The format detector uses
 * this to decide whether the file routes to this parser.
 */
export function issueNameForFilename(filename: string): string | null {
  const normalized = filename.toLowerCase().replace(/^.*[\\/]/, '');
  return ISSUE_CSV_FILENAME_MAP[normalized] || null;
}

export async function parse(
  raw: string,
  clientId: string,
  month: string,
  uploadId: string,
  filename: string,
): Promise<number> {
  const issueName = issueNameForFilename(filename);
  if (!issueName) return 0;

  const result = Papa.parse(raw, { header: true, skipEmptyLines: true });
  let count = 0;

  // Wipe any previous rows for this (client, month, issue) so re-uploads
  // do not double-insert. The same upload can supply many per-issue
  // CSVs; clearing by (client, month, issue) is the right key.
  await turso.execute({
    sql: `DELETE FROM site_issue_urls
          WHERE client_id = ? AND month = ? AND issue_name = ?`,
    args: [clientId, month, issueName],
  });

  for (const row of result.data as any[]) {
    const url = (row['Address'] || row['URL'] || row['url'])?.toString().trim();
    if (!url) continue;

    // Collect non-Address columns into extras for popout context
    // (e.g., current title length, current meta description, etc.).
    const extras: Record<string, any> = {};
    for (const [k, v] of Object.entries(row as Record<string, any>)) {
      if (k === 'Address' || k === 'URL' || k === 'url') continue;
      if (v === undefined || v === null || v === '') continue;
      extras[k] = v;
    }

    await turso.execute({
      sql: `INSERT INTO site_issue_urls (id, client_id, csv_upload_id, month, issue_name, url, extras)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        nanoid(),
        clientId,
        uploadId,
        month,
        issueName,
        url,
        Object.keys(extras).length > 0 ? JSON.stringify(extras) : null,
      ],
    });
    count++;
  }

  return count;
}
