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

// Issue name → SQL fragment for deriving the URL list from
// crawl_urls. Each entry knows the WHERE predicate plus which
// extra columns to surface as `extras` (so the popout can show
// "title_length: 12 chars" next to the URL, matching the format
// the per-issue CSV would have provided).
//
// Only includes issues where the derivation is unambiguous from
// crawl_urls' hot columns. "H1: Multiple", "H2: Duplicate", etc.
// would need page-level aggregates or window functions and stay
// in Tier 3 until per-issue CSVs are uploaded.
interface IssueDerivation {
  where: string;
  extraColumns?: string[]; // crawl_urls columns to include as `extras`
}

const ISSUE_DERIVATION_MAP: Record<string, IssueDerivation> = {
  // Headings: missing
  'H1: Missing': { where: "(h1 IS NULL OR TRIM(h1) = '')" },
  'H2: Missing': { where: "(h2 IS NULL OR TRIM(h2) = '')" },
  // Page titles
  'Page Titles: Missing': { where: "(title IS NULL OR TRIM(title) = '')" },
  'Page Titles: Below 30 Characters': {
    where: "title_length > 0 AND title_length < 30",
    extraColumns: ['title_length'],
  },
  'Page Titles: Over 60 Characters': {
    where: "title_length > 60",
    extraColumns: ['title_length'],
  },
  // Meta descriptions
  'Meta Description: Missing': {
    where: "(meta_description IS NULL OR TRIM(meta_description) = '')",
  },
  'Meta Description: Over 155 Characters': {
    where: "meta_description_length > 155",
    extraColumns: ['meta_description_length'],
  },
  // Content
  'Content: Low Content Pages': {
    where: "word_count > 0 AND word_count < 200",
    extraColumns: ['word_count'],
  },
  // Response codes
  'Response Codes: Internal Client Error (4xx)': {
    where: "status_code >= 400 AND status_code < 500",
    extraColumns: ['status_code'],
  },
  'Response Codes: Internal Server Error (5xx)': {
    where: "status_code >= 500",
    extraColumns: ['status_code'],
  },
  // Canonicals
  'Canonicals: Missing': {
    where: "(canonical_url IS NULL OR TRIM(canonical_url) = '')",
  },
  // Deep pages / orphans
  'Links: Pages With High Crawl Depth': {
    where: "crawl_depth > 5",
    extraColumns: ['crawl_depth'],
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

  // ===== Tier 2: derive from crawl_urls =====
  const derivation = ISSUE_DERIVATION_MAP[issueName];
  if (derivation) {
    const result = await deriveFromCrawlUrls(clientId, issueName, derivation);
    if (result) return result;
  }

  // ===== Tier 3: empty with diagnostic =====
  // Check whether the client has ANY crawl data at all so we can
  // tailor the message: "no crawl uploaded" vs "crawl uploaded but
  // this specific issue isn't computable without the per-issue CSV."
  const crawlAvailable = await turso.execute({
    sql: 'SELECT COUNT(*) FROM crawl_urls WHERE client_id = ? LIMIT 1',
    args: [clientId],
  });
  const hasCrawl = Number(crawlAvailable.rows[0]?.[0]) > 0;
  const derivable = !!derivation;

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
    derivable,
  });
};

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

async function deriveFromCrawlUrls(
  clientId: string,
  issueName: string,
  derivation: IssueDerivation,
): Promise<Response | null> {
  // Pick the latest month with crawl data so the derived list
  // matches the same cycle the rest of the health page surfaces.
  const monthRow = await turso.execute({
    sql: 'SELECT DISTINCT month FROM crawl_urls WHERE client_id = ? ORDER BY month DESC LIMIT 1',
    args: [clientId],
  });
  if (monthRow.rows.length === 0) return null;
  const month = monthRow.rows[0][0] as string;

  // Select URL + content type + indexability for classification, plus
  // any extra columns the issue maps to so the popout can show
  // contextual data ("title_length: 12 chars") next to each URL.
  const extraColumns = derivation.extraColumns || [];
  const selectExtras = extraColumns.length > 0
    ? ', ' + extraColumns.join(', ')
    : '';
  const sql = `SELECT url, content_type, indexability${selectExtras}
               FROM crawl_urls
               WHERE client_id = ?
                 AND month = ?
                 AND ${derivation.where}
               ORDER BY url ASC
               LIMIT 500`;
  const result = await turso.execute({ sql, args: [clientId, month] });

  if (result.rows.length === 0) {
    // Crawl exists but no URLs match the predicate (legit zero case).
    // Return as derived source so the UI shows "no URLs match this
    // pattern in your crawl" instead of the more alarming "upload
    // the CSV" message.
    return json({
      month,
      issue_name: issueName,
      urls: [],
      count: 0,
      pages_count: 0,
      other_count: 0,
      by_type: {},
      source: 'crawl_urls_derived',
    });
  }

  let pagesCount = 0;
  let otherCount = 0;
  const byType: Partial<Record<UrlType, number>> = {};

  const urls = result.rows.map(row => {
    const urlStr = row[0] as string;
    const contentType = (row[1] as string | null) || null;
    const indexability = (row[2] as string | null) || null;

    // Build extras from the additional selected columns. Column
    // names mirror crawl_urls so the popout's existing extras
    // formatter (matches /length|pixel|character|count|word/i)
    // picks them up automatically.
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
    source: 'crawl_urls_derived',
  });
}
