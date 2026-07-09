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
import { bulkInsert } from './_bulk-insert';

// Filename -> exact issue_name as it appears in site_issues.
//
// Sources:
//   1. SF's issues_overview_report.csv from the April ZipKit crawl
//      (every per-issue filename SF generated has a matching row in
//      that report; the issue_name column is the canonical string).
//   2. SF Documentation pages for issue categories not present in
//      the ZKH crawl (e.g., canonical chain issues only show up when
//      a site has them).
//
// Adding a new mapping: the filename is what SF writes in the
// /issues_reports/ subfolder; the value is the exact "Issue Name"
// from the issues_overview_report.csv that ships alongside it. Both
// must match exactly or the per-issue popout join breaks.
//
// Files like *_inlinks.csv are NOT mapped here. Those have a
// different schema (Source URL + Anchor + Destination URL) and need
// a separate parser, not the issue-urls parser. Worth doing in a
// follow-up — "what links to broken pages" is its own useful view.
export const ISSUE_CSV_FILENAME_MAP: Record<string, string> = {
  // Headings: H1
  'h1_missing.csv': 'H1: Missing',
  'h1_duplicate.csv': 'H1: Duplicate',
  'h1_multiple.csv': 'H1: Multiple',
  'h1_nonsequential.csv': 'H1: Non-Sequential',
  'h1_over_70_characters.csv': 'H1: Over 70 Characters',
  'h1_alt_text_in_h1.csv': 'H1: Alt Text In H1',
  // Headings: H2
  'h2_missing.csv': 'H2: Missing',
  'h2_duplicate.csv': 'H2: Duplicate',
  'h2_multiple.csv': 'H2: Multiple',
  'h2_nonsequential.csv': 'H2: Non-Sequential',
  'h2_over_70_characters.csv': 'H2: Over 70 Characters',
  // Page titles
  'page_titles_missing.csv': 'Page Titles: Missing',
  'page_titles_duplicate.csv': 'Page Titles: Duplicate',
  'page_titles_multiple.csv': 'Page Titles: Multiple',
  'page_titles_below_30_characters.csv': 'Page Titles: Below 30 Characters',
  'page_titles_below_200_pixels.csv': 'Page Titles: Below 200 Pixels',
  'page_titles_over_60_characters.csv': 'Page Titles: Over 60 Characters',
  'page_titles_over_561_pixels.csv': 'Page Titles: Over 561 Pixels',
  'page_titles_outside_head.csv': 'Page Titles: Outside <Head>',
  'page_titles_same_as_h1.csv': 'Page Titles: Same As H1',
  // Meta descriptions
  'meta_description_missing.csv': 'Meta Description: Missing',
  'meta_description_duplicate.csv': 'Meta Description: Duplicate',
  'meta_description_multiple.csv': 'Meta Description: Multiple',
  'meta_description_below_70_characters.csv': 'Meta Description: Below 70 Characters',
  'meta_description_below_400_pixels.csv': 'Meta Description: Below 400 Pixels',
  'meta_description_over_155_characters.csv': 'Meta Description: Over 155 Characters',
  'meta_description_over_985_pixels.csv': 'Meta Description: Over 985 Pixels',
  'meta_description_outside_head.csv': 'Meta Description: Outside <Head>',
  // Meta keywords
  'meta_keywords_missing.csv': 'Meta Keywords: Missing',
  'meta_keywords_duplicate.csv': 'Meta Keywords: Duplicate',
  'meta_keywords_multiple.csv': 'Meta Keywords: Multiple',
  // Canonicals
  'canonicals_missing.csv': 'Canonicals: Missing',
  'canonicals_canonicalised.csv': 'Canonicals: Canonicalised',
  'canonicals_canonical_is_relative.csv': 'Canonicals: Canonical Is Relative',
  'canonicals_contains_fragment_url.csv': 'Canonicals: Contains Fragment URL',
  'canonicals_invalid_attribute_in_annotation.csv': 'Canonicals: Invalid Attribute In Annotation',
  'canonicals_multiple.csv': 'Canonicals: Multiple',
  'canonicals_multiple_conflicting.csv': 'Canonicals: Multiple Conflicting',
  'canonicals_nonindexable_canonical.csv': 'Canonicals: Non-Indexable Canonical',
  'canonicals_outside_head.csv': 'Canonicals: Outside <Head>',
  'canonicals_unlinked.csv': 'Canonicals: Unlinked',
  // Images
  'images_missing_alt_text.csv': 'Images: Missing Alt Text',
  'images_missing_alt_attribute.csv': 'Images: Missing Alt Attribute',
  'images_over_100_kb.csv': 'Images: Over 100 KB',
  'images_missing_size_attributes.csv': 'Images: Missing Size Attributes',
  'images_alt_text_over_100_characters.csv': 'Images: Alt Text Over 100 Characters',
  'images_background_images.csv': 'Images: Background Images',
  'images_incorrectly_sized_images.csv': 'Images: Incorrectly Sized Images',
  // Security headers
  'security_missing_contentsecuritypolicy_header.csv': 'Security: Missing Content-Security-Policy Header',
  'security_missing_secure_referrerpolicy_header.csv': 'Security: Missing Secure Referrer-Policy Header',
  'security_missing_xcontenttypeoptions_header.csv': 'Security: Missing X-Content-Type-Options Header',
  'security_missing_xframeoptions_header.csv': 'Security: Missing X-Frame-Options Header',
  'security_missing_hsts_header.csv': 'Security: Missing HSTS Header',
  'security_bad_content_type.csv': 'Security: Bad Content Type',
  'security_form_on_http_url.csv': 'Security: Form On HTTP URL',
  'security_form_url_insecure.csv': 'Security: Form URL Insecure',
  'security_http_urls.csv': 'Security: HTTP URLs',
  'security_mixed_content.csv': 'Security: Mixed Content',
  'security_protocolrelative_resource_links.csv': 'Security: Protocol-Relative Resource Links',
  'security_unsafe_crossorigin_links.csv': 'Security: Unsafe Cross-Origin Links',
  // Content
  'content_low_content_pages.csv': 'Content: Low Content Pages',
  'content_exact_duplicates.csv': 'Content: Exact Duplicates',
  'content_near_duplicates.csv': 'Content: Near Duplicates',
  'content_semantically_similar.csv': 'Content: Semantically Similar',
  'content_low_relevance_content.csv': 'Content: Low Relevance Content',
  'content_readability_difficult.csv': 'Content: Readability Difficult',
  'content_readability_very_difficult.csv': 'Content: Readability Very Difficult',
  'content_grammar_errors.csv': 'Content: Grammar Errors',
  'content_spelling_errors.csv': 'Content: Spelling Errors',
  'content_lorem_ipsum_placeholder.csv': 'Content: Lorem Ipsum Placeholder',
  'content_soft_404_pages.csv': 'Content: Soft 404 Pages',
  // Links
  'links_internal_outlinks_with_no_anchor_text.csv': 'Links: Internal Outlinks With No Anchor Text',
  'links_nondescriptive_anchor_text_in_internal_outlinks.csv': 'Links: Non-Descriptive Anchor Text In Internal Outlinks',
  // Response codes — internal
  'response_codes_internal_client_error_(4xx).csv': 'Response Codes: Internal Client Error (4xx)',
  'response_codes_internal_server_error_(5xx).csv': 'Response Codes: Internal Server Error (5xx)',
  'response_codes_internal_no_response.csv': 'Response Codes: Internal No Response',
  'response_codes_internal_redirect_chain.csv': 'Response Codes: Internal Redirect Chain',
  'response_codes_internal_redirect_loop.csv': 'Response Codes: Internal Redirect Loop',
  'response_codes_internal_blocked_by_robots_txt.csv': 'Response Codes: Internal Blocked By Robots.txt',
  'response_codes_internal_blocked_resource.csv': 'Response Codes: Internal Blocked Resource',
  // Response codes — external
  'response_codes_external_client_error_(4xx).csv': 'Response Codes: External Client Error (4xx)',
  'response_codes_external_server_error_(5xx).csv': 'Response Codes: External Server Error (5xx)',
  'response_codes_external_no_response.csv': 'Response Codes: External No Response',
  'response_codes_external_blocked_by_robots_txt.csv': 'Response Codes: External Blocked By Robots.txt',
  'response_codes_external_blocked_resource.csv': 'Response Codes: External Blocked Resource',
  // URL shape
  'url_uppercase.csv': 'URL: Uppercase',
  'url_parameters.csv': 'URL: Parameters',
  'url_multiple_slashes.csv': 'URL: Multiple Slashes',
  'url_repetitive_path.csv': 'URL: Repetitive Path',
  'url_underscores.csv': 'URL: Underscores',
  'url_non_ascii_characters.csv': 'URL: Non ASCII Characters',
  'url_over_115_characters.csv': 'URL: Over 115 Characters',
  'url_contains_space.csv': 'URL: Contains Space',
  'url_broken_bookmark.csv': 'URL: Broken Bookmark',
  'url_ga_tracking_parameters.csv': 'URL: GA Tracking Parameters',
  'url_internal_search.csv': 'URL: Internal Search',
  // Validation
  'validation_high_carbon_rating.csv': 'Validation: High Carbon Rating',
  'validation_html_document_over_2mb.csv': 'Validation: HTML Document Over 2MB',
  'validation_resource_over_2mb.csv': 'Validation: Resource Over 2MB',
  'validation_missing_body_tag.csv': 'Validation: Missing <Body> Tag',
  'validation_missing_head_tag.csv': 'Validation: Missing <Head> Tag',
  'validation_multiple_body_tags.csv': 'Validation: Multiple <Body> Tags',
  'validation_multiple_head_tags.csv': 'Validation: Multiple <Head> Tags',
  'validation_body_element_preceding_html.csv': 'Validation: <Body> Element Preceding <Html>',
  'validation_head_not_first_in_html_element.csv': 'Validation: <Head> Not First In <Html> Element',
  'validation_invalid_html_elements_in_head.csv': 'Validation: Invalid HTML Elements In <Head>',
  // Mobile
  'mobile_viewport_not_set.csv': 'Mobile: Viewport Not Set',
  'mobile_target_size.csv': 'Mobile: Target Size',
  'mobile_content_not_sized_correctly.csv': 'Mobile: Content Not Sized Correctly',
  'mobile_illegible_font_size.csv': 'Mobile: Illegible Font Size',
  'mobile_contains_unsupported_plugins.csv': 'Mobile: Contains Unsupported Plugins',
  // Sitemaps
  'sitemaps_orphan_urls.csv': 'Sitemaps: Orphan URLs',
  'sitemaps_nonindexable_urls_in_sitemap.csv': 'Sitemaps: Non-Indexable URLs In Sitemap',
  'sitemaps_urls_in_multiple_sitemaps.csv': 'Sitemaps: URLs In Multiple Sitemaps',
  'sitemaps_urls_not_in_sitemap.csv': 'Sitemaps: URLs Not In Sitemap',
  // Pagination
  'pagination_non200_pagination_urls.csv': 'Pagination: Non-200 Pagination URLs',
  'pagination_nonindexable.csv': 'Pagination: Non-Indexable',
  'pagination_pagination_loop.csv': 'Pagination: Pagination Loop',
  'pagination_sequence_error.csv': 'Pagination: Sequence Error',
  'pagination_unlinked_pagination_urls.csv': 'Pagination: Unlinked Pagination URLs',
  'pagination_pagination_url_not_in_anchor_tag.csv': 'Pagination: Pagination URL Not In Anchor Tag',
};

// The Screaming Frog issue/violation FAMILIES whose per-issue slice files are
// genuine "list of URLs flagged for one issue" exports. A filename only
// derives an issue name when its first token is one of these — everything
// else returns null so the detector does NOT route it to the issue system
// (it falls through to typed signatures or the sf_generic floor). This is the
// qualify gate that keeps resource lists, link dumps, and per-URL masters OUT.
// NOTE: 'canonicals' and 'directives' are deliberately NOT here. Their
// non-_all slice files (canonicals_contains_canonical.csv, directives_follow.csv,
// etc.) carry the SAME rich per-URL columns as their _all master and must
// route to the typed canonical/directive parsers via the SIGNATURES loop, not
// the issue system. Including them would steal those files before the loop.
const ISSUE_FAMILIES = new Set([
  'accessibility', 'wcag', 'amp', 'hreflang', 'javascript', 'pagespeed',
  'security', 'sitemaps', 'pagination', 'images',
  'content', 'validation', 'mobile', 'url', 'h1', 'h2', 'page', 'meta',
  'structured', 'analytics',
]);

// Tokens that should render as acronyms / fixed casing in a derived name.
const ISSUE_TOKEN_CASING: Record<string, string> = {
  url: 'URL', urls: 'URLs', http: 'HTTP', https: 'HTTPS', html: 'HTML',
  css: 'CSS', js: 'JS', amp: 'AMP', h1: 'H1', h2: 'H2', h3: 'H3', kb: 'KB',
  mb: 'MB', api: 'API', ga: 'GA', psi: 'PSI', wcag: 'WCAG', aa: 'AA',
  aaa: 'AAA', xml: 'XML', json: 'JSON', seo: 'SEO', cdn: 'CDN', hsts: 'HSTS',
  csp: 'CSP', cors: 'CORS', dom: 'DOM', lcp: 'LCP', cls: 'CLS', amphtml: 'AMPHTML',
  '2xx': '2xx', '3xx': '3xx', '4xx': '4xx', '5xx': '5xx',
  pagespeed: 'PageSpeed', javascript: 'JavaScript', hreflang: 'Hreflang',
};

// Reused from site-audit.ts: a derived name that still looks like a raw
// filename (path separators, SF timestamp folder, absurd length) must NOT
// become an issue label.
function looksLikeFilenameLeak(name: string): boolean {
  if (!name) return true;
  if (name.includes('/') || name.includes('\\')) return true;
  if (/^\d{4}\.\d{2}\.\d{2}/.test(name)) return true;
  if (name.length > 100) return true;
  return false;
}

function titleCaseToken(t: string): string {
  if (ISSUE_TOKEN_CASING[t]) return ISSUE_TOKEN_CASING[t];
  if (/^\d+$/.test(t)) return t;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * Derive a clean human issue name from a Screaming Frog issue-slice filename
 * when it is NOT in the curated ISSUE_CSV_FILENAME_MAP. Returns null for any
 * filename that is not a genuine single-issue URL slice, so the detector does
 * not over-route. Derived names live in site_issue_urls ONLY (never
 * site_issues — see the parser), so they never affect the health score.
 */
export function deriveIssueNameFromFilename(filename: string): string | null {
  const norm = filename
    .replace(/^.*[\\/]/, '')
    .replace(/^.*\.zip:/i, '')
    .replace(/\.csv$/i, '')
    .trim()
    .toLowerCase();
  if (!norm) return null;

  // DENY: per-URL masters, link/anchor dumps, and resource inventories are
  // NOT issue slices. (*_inlinks/links_* are already claimed by the 'links'
  // format earlier in the detector; denied here too as belt-and-suspenders.)
  if (/(^|_)all$/.test(norm)) return null;                                   // *_all masters
  if (/_inlinks$|_outlinks$|^links_|^all_anchor_text$/.test(norm)) return null; // link dumps
  if (/resources?$|^external_|^internal_(css|javascript|images|html|other)$/.test(norm)) return null; // resource lists
  if (/_summary$|_summary_report$|_overview$/.test(norm)) return null;       // aggregates, not per-URL issue lists

  const family = norm.split('_')[0];
  if (!ISSUE_FAMILIES.has(family)) return null;                              // qualify gate

  const name = norm.split('_').map(titleCaseToken).join(' ');
  if (looksLikeFilenameLeak(name)) return null;
  return name;
}

/**
 * Look up the issue_name for a CSV filename. The curated map wins first (its
 * names match issues_overview exactly for the site_issues join); otherwise a
 * clean name is derived for any genuine issue-slice family. Returns null when
 * the filename is not a per-issue export. The format detector uses this to
 * decide whether the file routes to this parser.
 */
export function issueNameForFilename(filename: string): string | null {
  const normalized = filename.toLowerCase().replace(/^.*[\\/]/, '');
  return ISSUE_CSV_FILENAME_MAP[normalized] || deriveIssueNameFromFilename(filename);
}

export async function parse(
  raw: string,
  clientId: string,
  month: string,
  uploadId: string,
  filename: string,
): Promise<number> {
  return parseIssueUrlsWithDb(raw, clientId, month, uploadId, filename, turso);
}

// Test-injectable variant. The db param defaults to the prod singleton in
// parse(); tests inject an in-memory client to avoid touching the remote DB.
export async function parseIssueUrlsWithDb(
  raw: string,
  clientId: string,
  month: string,
  uploadId: string,
  filename: string,
  db: typeof turso,
): Promise<number> {
  const issueName = issueNameForFilename(filename);
  if (!issueName) return 0;

  const result = Papa.parse(raw, { header: true, skipEmptyLines: true });

  // Column-shape guard: a genuine issue slice has the URL in an
  // Address/URL/url column. If none is present (e.g. a link-relationship
  // file keyed on Source slipped through, or a non-URL report), do NOT
  // touch the table — returning before the DELETE prevents a misrouted file
  // from wiping a legitimate issue's URLs under this issue_name.
  const fields = (result.meta?.fields || []).map(f => String(f).trim().toLowerCase());
  if (!fields.includes('address') && !fields.includes('url')) {
    return 0;
  }

  // Wipe any previous rows for this (client, month, issue) so re-uploads
  // do not double-insert. The same upload can supply many per-issue
  // CSVs; clearing by (client, month, issue) is the right key.
  await db.execute({
    sql: `DELETE FROM site_issue_urls
          WHERE client_id = ? AND month = ? AND issue_name = ?`,
    args: [clientId, month, issueName],
  });

  // Collect args first, then batch-insert via bulkInsert (turso.batch).
  // The old Promise.all(chunk.map(execute)) did one round-trip per row,
  // which timed out on large issue files (400+ URLs per category).
  const inserts: any[][] = [];
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

    inserts.push([
      nanoid(), clientId, uploadId, month, issueName, url,
      Object.keys(extras).length > 0 ? JSON.stringify(extras) : null,
    ]);
  }

  const sql = `INSERT INTO site_issue_urls
                 (id, client_id, csv_upload_id, month, issue_name, url, extras)
               VALUES (?, ?, ?, ?, ?, ?, ?)`;
  await bulkInsert(sql, inserts, db);

  return inserts.length;
}
