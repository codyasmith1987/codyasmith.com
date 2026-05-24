// Page counts framed the way clients name pages.
//
// A client thinks of "a page" as a piece of content they intentionally
// published: the homepage, an about page, a blog post, a service page.
// They do NOT think of:
//   - Tag / category / author archives (CMS auto-generates these even
//     when the client has no idea they exist)
//   - Pagination URLs like /blog/page/2/
//   - RSS / Atom feeds
//   - WordPress system endpoints (/wp-content/, /wp-json/, etc.)
//   - Attachment or embed URLs
//   - URLs Google refuses to index anyway (canonicalised, noindex,
//     blocked by robots.txt; SF tags these "Non-Indexable")
//
// The crawler legitimately reports all of the above. The portal must
// not — "X of your Y pages need attention" only reads as honest when
// X and Y count the same thing the client would count if they listed
// their pages by hand.
//
// Returns:
//   - navigable_pages: the friendly count. URL passes the utility
//     filter, is indexable, status 200, HTML content-type. This is
//     what the health-page headline uses for the denominator.
//   - urls_crawled: every distinct HTML 200 URL the crawler saw.
//     Diagnostic / admin number — surfaced as a small admin subline
//     so Cody can see the gap between crawler reach and client mental
//     model. NOT shown to clients.
//   - distinct_affected_urls: count of pages (same utility filter)
//     that have at least one issue this month. Joined back through
//     crawl_urls so the X and Y in the framing use the same universe.
//   - total_html_pages: legacy alias of navigable_pages so older
//     cached health pages don't blank out during deploy. Remove after
//     a deploy cycle.
//
// Per the page-trust work (KelseyVerse asked: "I really only have two
// pages and like 18 blog posts tops" — portal had been reporting in
// the high double digits) and Cody's reframe: clients think of pages
// as pages, not URLs.

import type { APIRoute } from 'astro';
import turso from '../../../../lib/turso';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// URL-shape exclusions for utility URLs. Same patterns apply to any
// column holding a URL, so the helper takes the qualified column
// expression. LIKE handles literal substring matches; GLOB lets us
// match digits in pagination paths.
//
// Adding a pattern: add the LIKE / GLOB line here. Both queries that
// use this helper (the page count and the affected-page count) get
// the new exclusion automatically.
function urlPatternExclusions(col: string): string {
  return `
    AND ${col} NOT LIKE '%/tag/%'
    AND ${col} NOT LIKE '%/category/%'
    AND ${col} NOT LIKE '%/author/%'
    AND ${col} NOT LIKE '%/feed/%'
    AND ${col} NOT LIKE '%/feed'
    AND ${col} NOT LIKE '%/embed/%'
    AND ${col} NOT LIKE '%/embed'
    AND ${col} NOT LIKE '%/attachment/%'
    AND ${col} NOT LIKE '%/wp-content/%'
    AND ${col} NOT LIKE '%/wp-includes/%'
    AND ${col} NOT LIKE '%/wp-admin/%'
    AND ${col} NOT LIKE '%/wp-json/%'
    AND ${col} NOT LIKE '%/cdn-cgi/%'
    AND ${col} NOT LIKE '%?attachment_id=%'
    AND ${col} NOT LIKE '%?attachment=%'
    AND ${col} NOT LIKE '%?replytocom=%'
    AND ${col} NOT LIKE '%?p=%'
    AND ${col} NOT LIKE '%?paged=%'
    AND ${col} NOT GLOB '*/page/[0-9]*'
  `;
}

// Crawl-row filters: status 200, HTML content-type, not flagged
// "Non-Indexable" by Screaming Frog. SF tags non-indexable for
// canonicalised, noindex, and robots-blocked URLs — none of which a
// client would list as a page.
function pageRowFilters(prefix: string = ''): string {
  const p = prefix ? `${prefix}.` : '';
  return `
    AND ${p}status_code = 200
    AND LOWER(IFNULL(${p}content_type, '')) LIKE '%html%'
    AND LOWER(IFNULL(${p}indexability, '')) != 'non-indexable'
  `;
}

export const GET: APIRoute = async ({ locals, url }) => {
  if (!locals.user) return json({ error: 'Unauthorized' }, 401);

  const clientId = locals.user.role === 'admin'
    ? (url.searchParams.get('client_id') || null)
    : locals.user.client_id;
  if (!clientId) return json({ error: 'No client specified' }, 400);

  // Navigable pages: the friendly count. This is the "Y" in "X of
  // your Y pages need attention" on the health page headline.
  const pagesResult = await turso.execute({
    sql: `SELECT COUNT(DISTINCT url) AS n
          FROM crawl_urls
          WHERE client_id = ?
          ${pageRowFilters()}
          ${urlPatternExclusions('url')}`,
    args: [clientId],
  });
  const navigablePages = (pagesResult.rows[0]?.[0] as number) || 0;

  // URLs crawled: status 200 + HTML, no utility filter, no
  // indexability filter. The raw crawler reach. Admin diagnostic
  // only — never surfaced to clients.
  const urlsResult = await turso.execute({
    sql: `SELECT COUNT(DISTINCT url) AS n
          FROM crawl_urls
          WHERE client_id = ?
            AND status_code = 200
            AND LOWER(IFNULL(content_type, '')) LIKE '%html%'`,
    args: [clientId],
  });
  const urlsCrawled = (urlsResult.rows[0]?.[0] as number) || 0;

  // Distinct affected URLs: pages with at least one issue at the
  // latest month, run through the same utility filter so the X
  // numerator and the Y denominator describe the same set. Joined
  // back to crawl_urls so we can apply pageRowFilters (status,
  // content-type, indexability live there, not on site_issue_urls).
  const monthResult = await turso.execute({
    sql: 'SELECT DISTINCT month FROM site_issue_urls WHERE client_id = ? ORDER BY month DESC LIMIT 1',
    args: [clientId],
  });
  let distinctAffectedUrls = 0;
  let month: string | null = null;
  if (monthResult.rows.length > 0) {
    month = monthResult.rows[0][0] as string;
    const affectedResult = await turso.execute({
      sql: `SELECT COUNT(DISTINCT siu.url) AS n
            FROM site_issue_urls siu
            INNER JOIN crawl_urls cu
              ON cu.url = siu.url AND cu.client_id = siu.client_id
            WHERE siu.client_id = ?
              AND siu.month = ?
            ${pageRowFilters('cu')}
            ${urlPatternExclusions('siu.url')}`,
      args: [clientId, month],
    });
    distinctAffectedUrls = (affectedResult.rows[0]?.[0] as number) || 0;
  }

  return json({
    navigable_pages: navigablePages,
    urls_crawled: urlsCrawled,
    distinct_affected_urls: distinctAffectedUrls,
    month,
    // Legacy alias kept for one deploy cycle. health.astro reads
    // navigable_pages directly going forward; this guards a cached
    // client during the rollout.
    total_html_pages: navigablePages,
  });
};
