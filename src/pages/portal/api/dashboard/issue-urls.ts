// Per-issue URL list for the health page's expandable issue cards.
//
// Three-tier data source strategy:
//
//   Tier 1 — site_issue_urls. Populated when per-issue SF CSVs
//     (h1_missing.csv, page_titles_below_30_characters.csv, etc.)
//     have been uploaded. Most accurate; the URLs the audit tool
//     explicitly tagged with this issue.
//
//   Tier 2 — derived from crawl_urls. When site_issue_urls is empty
//     for the issue but the SF Internal HTML CSV (crawl_internal)
//     has been uploaded, we can compute "H1: Missing" as
//     `WHERE h1 IS NULL`, "Page Titles: Below 30 Characters" as
//     `WHERE title_length < 30`, etc. The count may differ slightly
//     from the audit summary because SF applies edge-case rules
//     (whitespace-only counts as missing, etc.), but the list is
//     concretely useful.
//
//   Tier 3 — empty with a clear next-step message. Different copy
//     depending on whether ANY data is uploaded yet.
//
// Per-URL classification (page vs image vs tag archive etc.) runs
// against all returned URLs regardless of source so the popout
// renders consistently across tiers.

import type { APIRoute } from 'astro';
import turso from '../../../../lib/turso';
import { classifyUrl, type UrlType } from '../../../../lib/url-classifier';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// Issue name → SQL fragment for deriving the URL list. Supports
// multiple source tables since different categories of issues live
// in different per-URL tables (crawl_urls for headings/titles,
// image_urls for image-specific issues, content_urls for readability
// / duplicates, accessibility_urls for WCAG counts, etc.). The
// raw_json catch-all on most tables lets us derive issues whose
// SF columns weren't promoted to hot columns at parse time (H1
// duplicates, multiple H1/H2 on a page).
//
// Each entry knows:
//   - source table (crawl_urls, image_urls, content_urls, ...)
//   - WHERE predicate (may include json_extract for raw_json hops)
//   - extra columns to surface as `extras` next to the URL
//   - optional groupBy + having for duplicate-detection patterns
//
// Issues still in Tier 3 (no derivation):
//   - Pixel-based length checks (page_titles_over_561_pixels,
//     meta_description_over_985_pixels) — SF measures these from
//     rendered text; no equivalent in our stored columns.
//   - Security header issues — Cody's SF security_all.csv only
//     emits the bare 10 columns (Address/Content Type/Status/HTTP
//     Version/Indexability/Canonical/Meta Robots/X-Robots-Tag),
//     so individual headers aren't in security_urls or its
//     raw_json. The per-issue files (security_missing_hsts_header.csv,
//     etc.) carry them; Tier 1 (site_issue_urls) handles those.
//   - External link 4xx errors — need the link-relationships table
//     (*_inlinks) which doesn't have a typed parser yet.
interface IssueDerivation {
  source: 'crawl_urls' | 'image_urls' | 'content_urls' | 'accessibility_urls' | 'structured_data_urls' | 'link_graph';
  where: string;
  extraColumns?: string[];
  // For "find duplicates within a column" patterns: groupBy + having
  // identifies the duplicate values, then the SELECT lists pages
  // that have one of those values.
  groupBy?: string;
  having?: string;
}

const ISSUE_DERIVATION_MAP: Record<string, IssueDerivation> = {
  // ===== crawl_urls (Internal HTML) =====
  // Headings — missing
  'H1: Missing': { source: 'crawl_urls', where: "(h1 IS NULL OR TRIM(h1) = '')" },
  'H2: Missing': { source: 'crawl_urls', where: "(h2 IS NULL OR TRIM(h2) = '')" },
  // Headings — multiple (uses raw_json since hot column only stores first H1/H2)
  'H1: Multiple': {
    source: 'crawl_urls',
    where: `json_extract(raw_json, '$."H1-2"') IS NOT NULL AND TRIM(json_extract(raw_json, '$."H1-2"')) != ''`,
  },
  'H2: Multiple': {
    source: 'crawl_urls',
    where: `json_extract(raw_json, '$."H2-2"') IS NOT NULL AND TRIM(json_extract(raw_json, '$."H2-2"')) != ''`,
  },
  // Headings — duplicate (same h1/h2 text appears on multiple pages)
  'H1: Duplicate': {
    source: 'crawl_urls',
    where: "h1 IS NOT NULL AND TRIM(h1) != ''",
    groupBy: 'h1',
    having: 'COUNT(*) > 1',
  },
  'H2: Duplicate': {
    source: 'crawl_urls',
    where: "h2 IS NOT NULL AND TRIM(h2) != ''",
    groupBy: 'h2',
    having: 'COUNT(*) > 1',
  },
  // Page titles
  'Page Titles: Missing': { source: 'crawl_urls', where: "(title IS NULL OR TRIM(title) = '')" },
  'Page Titles: Below 30 Characters': {
    source: 'crawl_urls',
    where: "title_length > 0 AND title_length < 30",
    extraColumns: ['title_length'],
  },
  'Page Titles: Over 60 Characters': {
    source: 'crawl_urls',
    where: "title_length > 60",
    extraColumns: ['title_length'],
  },
  'Page Titles: Duplicate': {
    source: 'crawl_urls',
    where: "title IS NOT NULL AND TRIM(title) != ''",
    groupBy: 'title',
    having: 'COUNT(*) > 1',
  },
  // Meta descriptions
  'Meta Description: Missing': {
    source: 'crawl_urls',
    where: "(meta_description IS NULL OR TRIM(meta_description) = '')",
  },
  'Meta Description: Over 155 Characters': {
    source: 'crawl_urls',
    where: "meta_description_length > 155",
    extraColumns: ['meta_description_length'],
  },
  'Meta Description: Duplicate': {
    source: 'crawl_urls',
    where: "meta_description IS NOT NULL AND TRIM(meta_description) != ''",
    groupBy: 'meta_description',
    having: 'COUNT(*) > 1',
  },
  // Content
  'Content: Low Content Pages': {
    source: 'crawl_urls',
    where: "word_count > 0 AND word_count < 200",
    extraColumns: ['word_count'],
  },
  // Response codes
  'Response Codes: Internal Client Error (4xx)': {
    source: 'crawl_urls',
    where: "status_code >= 400 AND status_code < 500",
    extraColumns: ['status_code'],
  },
  'Response Codes: Internal Server Error (5xx)': {
    source: 'crawl_urls',
    where: "status_code >= 500",
    extraColumns: ['status_code'],
  },
  // ===== link_graph (Tier-2) =====
  // These two curated Links issues route to link_graph (the detector's links_
  // gate claims them before the issue gate), so their site_issue_urls popout
  // is empty. Derive the affected SOURCE pages from link_graph instead (L1).
  // source_file is the filename lowercased, path + .csv stripped (links.ts).
  'Links: Internal Outlinks With No Anchor Text': {
    source: 'link_graph',
    where: "source_file = 'links_internal_outlinks_with_no_anchor_text'",
  },
  'Links: Non-Descriptive Anchor Text In Internal Outlinks': {
    source: 'link_graph',
    where: "source_file = 'links_nondescriptive_anchor_text_in_internal_outlinks'",
  },
  // Canonicals
  'Canonicals: Missing': {
    source: 'crawl_urls',
    where: "(canonical_url IS NULL OR TRIM(canonical_url) = '')",
  },
  'Canonicals: Canonicalised': {
    source: 'crawl_urls',
    where: "canonical_url IS NOT NULL AND TRIM(canonical_url) != '' AND canonical_url != url",
  },
  // Deep pages
  'Links: Pages With High Crawl Depth': {
    source: 'crawl_urls',
    where: "crawl_depth > 5",
    extraColumns: ['crawl_depth'],
  },

  // ===== image_urls (Images bulk export) =====
  'Images: Over 100 KB': {
    source: 'image_urls',
    where: "size_bytes > 102400",
    extraColumns: ['size_bytes'],
  },
  // Alt-text presence isn't a hot column on image_urls; SF stores
  // it under "Alt Text" in the row. The image-urls parser writes
  // the full row into raw_json, so we can pull it back out here.
  // Empty / null / whitespace counts as missing.
  'Images: Missing Alt Text': {
    source: 'image_urls',
    where: `(json_extract(raw_json, '$."Alt Text"') IS NULL OR TRIM(IFNULL(json_extract(raw_json, '$."Alt Text"'), '')) = '')`,
  },
  // Alt attribute missing entirely (vs. present-but-empty) shows
  // up as a distinct value SF marks.
  'Images: Missing Alt Attribute': {
    source: 'image_urls',
    where: `LOWER(IFNULL(json_extract(raw_json, '$."Alt Text"'), '')) = 'missing'`,
  },

  // ===== content_urls (Content bulk export) =====
  'Content: Exact Duplicates': {
    source: 'content_urls',
    where: "near_duplicate_count > 0 AND closest_near_duplicate_url IS NOT NULL",
    extraColumns: ['near_duplicate_count'],
  },
  'Content: Near Duplicates': {
    source: 'content_urls',
    where: "near_duplicate_count > 0",
    extraColumns: ['near_duplicate_count'],
  },
  'Content: Readability Difficult': {
    source: 'content_urls',
    where: "flesch_reading_ease IS NOT NULL AND flesch_reading_ease < 50 AND flesch_reading_ease >= 30",
    extraColumns: ['flesch_reading_ease'],
  },
  'Content: Readability Very Difficult': {
    source: 'content_urls',
    where: "flesch_reading_ease IS NOT NULL AND flesch_reading_ease < 30",
    extraColumns: ['flesch_reading_ease'],
  },
  'Content: Spelling Errors': {
    source: 'content_urls',
    where: "spelling_errors > 0",
    extraColumns: ['spelling_errors'],
  },
  'Content: Grammar Errors': {
    source: 'content_urls',
    where: "grammar_errors > 0",
    extraColumns: ['grammar_errors'],
  },

  // ===== accessibility_urls (Accessibility bulk export) =====
  // WCAG-level violations. Each kind matches the corresponding
  // hot column SF populates per URL.
  'Accessibility: WCAG 2.0 A Violations': {
    source: 'accessibility_urls',
    where: "wcag_20a_violations > 0",
    extraColumns: ['wcag_20a_violations'],
  },
  'Accessibility: WCAG 2.0 AA Violations': {
    source: 'accessibility_urls',
    where: "wcag_20aa_violations > 0",
    extraColumns: ['wcag_20aa_violations'],
  },
  'Accessibility: WCAG 2.1 AA Violations': {
    source: 'accessibility_urls',
    where: "wcag_21aa_violations > 0",
    extraColumns: ['wcag_21aa_violations'],
  },
  'Accessibility: WCAG 2.2 AA Violations': {
    source: 'accessibility_urls',
    where: "wcag_22aa_violations > 0",
    extraColumns: ['wcag_22aa_violations'],
  },
  'Accessibility: Best Practice Violations': {
    source: 'accessibility_urls',
    where: "best_practice_violations > 0",
    extraColumns: ['best_practice_violations'],
  },

  // ===== structured_data_urls (Structured Data bulk export) =====
  'Structured Data: Validation Errors': {
    source: 'structured_data_urls',
    where: "error_count > 0",
    extraColumns: ['error_count'],
  },
  'Structured Data: Validation Warnings': {
    source: 'structured_data_urls',
    where: "warning_count > 0",
    extraColumns: ['warning_count'],
  },
  'Structured Data: Rich Result Errors': {
    source: 'structured_data_urls',
    where: "rich_result_errors > 0",
    extraColumns: ['rich_result_errors'],
  },
};

export const GET: APIRoute = async ({ locals, url }) => {
  if (!locals.user) return json({ error: 'Unauthorized' }, 401);

  const clientId = locals.user.role === 'admin'
    ? (url.searchParams.get('client_id') || null)
    : locals.user.client_id;
  const issueName = url.searchParams.get('issue_name') || '';
  if (!clientId) return json({ error: 'No client specified' }, 400);
  if (!issueName) return json({ error: 'issue_name is required' }, 400);

  // ===== Tier 1: site_issue_urls =====
  const monthResult = await turso.execute({
    sql: 'SELECT DISTINCT month FROM site_issue_urls WHERE client_id = ? AND issue_name = ? ORDER BY month DESC LIMIT 1',
    args: [clientId, issueName],
  });
  if (monthResult.rows.length > 0) {
    const month = monthResult.rows[0][0] as string;
    return await respondFromSiteIssueUrls(clientId, month, issueName);
  }

  // ===== Tier 2: derive from a per-URL table =====
  const derivation = ISSUE_DERIVATION_MAP[issueName];
  if (derivation) {
    const result = await deriveFromTable(clientId, issueName, derivation);
    if (result) return result;
  }

  // ===== Tier 3: empty with diagnostic =====
  // Different upload tables to check for "do you have ANY data
  // here?" so the empty-state message is specific. If crawl_urls
  // has rows but this issue's derivation needs image_urls (which is
  // empty), say "upload the Images bulk export" rather than
  // generic "upload the SF Internal HTML CSV."
  const hasCrawl = await tableHasRows(clientId, 'crawl_urls');
  const expectedSource = derivation?.source;
  const hasExpectedSource = expectedSource
    ? await tableHasRows(clientId, expectedSource)
    : hasCrawl;

  return json({
    month: null,
    issue_name: issueName,
    urls: [],
    count: 0,
    pages_count: 0,
    other_count: 0,
    by_type: {},
    source: 'none',
    has_crawl: hasCrawl,
    has_expected_source: hasExpectedSource,
    expected_source: expectedSource || null,
    derivable: !!derivation,
  });
};

async function tableHasRows(clientId: string, table: string): Promise<boolean> {
  try {
    const r = await turso.execute({
      sql: `SELECT 1 FROM ${table} WHERE client_id = ? LIMIT 1`,
      args: [clientId],
    });
    return r.rows.length > 0;
  } catch {
    return false;
  }
}

async function respondFromSiteIssueUrls(
  clientId: string,
  month: string,
  issueName: string,
): Promise<Response> {
  const result = await turso.execute({
    sql: `SELECT siu.url, siu.extras, cu.content_type, cu.indexability
          FROM site_issue_urls siu
          LEFT JOIN crawl_urls cu
            ON cu.url = siu.url
            AND cu.client_id = siu.client_id
          WHERE siu.client_id = ?
            AND siu.month = ?
            AND siu.issue_name = ?
          GROUP BY siu.url, siu.extras
          ORDER BY siu.url ASC`,
    args: [clientId, month, issueName],
  });

  let pagesCount = 0;
  let otherCount = 0;
  const byType: Partial<Record<UrlType, number>> = {};

  const urls = result.rows.map(row => {
    const urlStr = row[0] as string;
    const extrasRaw = row[1] as string | null;
    const contentType = (row[2] as string | null) || null;
    const indexability = (row[3] as string | null) || null;

    let extras: any = null;
    if (extrasRaw) {
      try { extras = JSON.parse(extrasRaw); } catch { /* swallow */ }
    }

    const classification = classifyUrl(urlStr, { contentType, indexability });
    if (classification.is_page) pagesCount++;
    else otherCount++;
    byType[classification.type] = (byType[classification.type] || 0) + 1;

    return {
      url: urlStr,
      extras,
      type: classification.type,
      label: classification.label,
      is_page: classification.is_page,
    };
  });

  return json({
    month,
    issue_name: issueName,
    urls,
    count: urls.length,
    pages_count: pagesCount,
    other_count: otherCount,
    by_type: byType,
    source: 'site_issue_urls',
  });
}

async function deriveFromTable(
  clientId: string,
  issueName: string,
  derivation: IssueDerivation,
): Promise<Response | null> {
  const table = derivation.source;

  // Latest month with data in the source table. Each table is
  // queried separately so an issue tied to image_urls picks the
  // newest image-export month, even if the SF Internal HTML upload
  // is older or newer.
  const monthRow = await turso.execute({
    sql: `SELECT DISTINCT month FROM ${table} WHERE client_id = ? ORDER BY month DESC LIMIT 1`,
    args: [clientId],
  });
  if (monthRow.rows.length === 0) return null;
  const month = monthRow.rows[0][0] as string;

  // The classification helper needs content_type + indexability.
  // crawl_urls, image_urls, content_urls, security_urls,
  // accessibility_urls, structured_data_urls all carry both as
  // hot columns (per their migrations). Use null fallback for
  // any table that doesn't — classifier handles nulls gracefully.
  const extraColumns = derivation.extraColumns || [];
  const selectExtras = extraColumns.length > 0
    ? ', ' + extraColumns.join(', ')
    : '';

  // link_graph has no content_type/indexability columns and many rows per
  // source page, so list DISTINCT source pages with NULL class columns (the
  // classifier handles nulls). Other tables are one row per URL.
  const urlSelect = table === 'link_graph'
    ? 'DISTINCT source_url AS url, NULL AS content_type, NULL AS indexability'
    : 'url, content_type, indexability';

  let sql: string;
  if (derivation.groupBy) {
    // Duplicate-detection: subquery finds values that appear more
    // than once, outer query lists pages with those values.
    sql = `SELECT ${urlSelect}${selectExtras}
           FROM ${table}
           WHERE client_id = ?
             AND month = ?
             AND ${derivation.where}
             AND ${derivation.groupBy} IN (
               SELECT ${derivation.groupBy} FROM ${table}
               WHERE client_id = ? AND month = ? AND ${derivation.where}
               GROUP BY ${derivation.groupBy}
               HAVING ${derivation.having || 'COUNT(*) > 1'}
             )
           ORDER BY ${derivation.groupBy}, url ASC
           LIMIT 500`;
  } else {
    sql = `SELECT ${urlSelect}${selectExtras}
           FROM ${table}
           WHERE client_id = ?
             AND month = ?
             AND ${derivation.where}
           ORDER BY url ASC
           LIMIT 500`;
  }

  const args = derivation.groupBy
    ? [clientId, month, clientId, month]
    : [clientId, month];

  const result = await turso.execute({ sql, args });

  if (result.rows.length === 0) {
    return json({
      month,
      issue_name: issueName,
      urls: [],
      count: 0,
      pages_count: 0,
      other_count: 0,
      by_type: {},
      source: 'derived',
      source_table: table,
    });
  }

  let pagesCount = 0;
  let otherCount = 0;
  const byType: Partial<Record<UrlType, number>> = {};

  const urls = result.rows.map(row => {
    const urlStr = row[0] as string;
    const contentType = (row[1] as string | null) || null;
    const indexability = (row[2] as string | null) || null;

    const extras: Record<string, any> = {};
    for (let i = 0; i < extraColumns.length; i++) {
      const colName = extraColumns[i];
      const val = row[3 + i];
      if (val !== null && val !== undefined && val !== '') {
        extras[colName] = val;
      }
    }

    const classification = classifyUrl(urlStr, { contentType, indexability });
    if (classification.is_page) pagesCount++;
    else otherCount++;
    byType[classification.type] = (byType[classification.type] || 0) + 1;

    return {
      url: urlStr,
      extras: Object.keys(extras).length > 0 ? extras : null,
      type: classification.type,
      label: classification.label,
      is_page: classification.is_page,
    };
  });

  return json({
    month,
    issue_name: issueName,
    urls,
    count: urls.length,
    pages_count: pagesCount,
    other_count: otherCount,
    by_type: byType,
    source: 'derived',
    source_table: table,
  });
}
