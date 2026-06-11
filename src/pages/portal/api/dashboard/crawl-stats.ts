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
import { realUserPageRowFilters, realUserPageUrlExclusions } from '../../../../lib/csv/page-count-sql';
import { resolveSiteScope, uploadScopeFragment } from '../../../../lib/site-scope';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals, url }) => {
  if (!locals.user) return json({ error: 'Unauthorized' }, 401);

  const clientId = locals.user.role === 'admin'
    ? (url.searchParams.get('client_id') || null)
    : locals.user.client_id;
  if (!clientId) return json({ error: 'No client specified' }, 400);

  // Per-site scoping for multi-site clients (Phase 1b): same semantics as the
  // issues endpoint, so the headline X-of-Y and the issues panel describe the
  // same site. Single-site clients are unscoped and unchanged.
  const scope = await resolveSiteScope(clientId, url.searchParams.get('site'));
  const S = uploadScopeFragment(clientId, scope);

  // Resolve the latest crawl cycle so the page count Y is ONE cycle, not
  // all-time. With 2+ crawls loaded, an all-months DISTINCT url denominator
  // mixes cycles and disagrees with the month-scoped numerator below. (M5)
  const crawlMonthRes = await turso.execute({
    sql: `SELECT MAX(month) AS m FROM crawl_urls WHERE client_id = ?${S.frag}`,
    args: [clientId, ...S.args],
  });
  const crawlMonth = (crawlMonthRes.rows[0]?.[0] as string | null) ?? null;

  // Navigable pages: the friendly count. This is the "Y" in "X of
  // your Y pages need attention" on the health page headline.
  const pagesResult = await turso.execute({
    sql: `SELECT COUNT(DISTINCT url) AS n
          FROM crawl_urls
          WHERE client_id = ?
          ${crawlMonth ? 'AND month = ?' : ''}${S.frag}
          ${realUserPageRowFilters()}
          ${realUserPageUrlExclusions('url')}`,
    args: crawlMonth ? [clientId, crawlMonth, ...S.args] : [clientId, ...S.args],
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
            AND LOWER(IFNULL(content_type, '')) LIKE '%html%'${S.frag}`,
    args: [clientId, ...S.args],
  });
  const urlsCrawled = (urlsResult.rows[0]?.[0] as number) || 0;

  // Distinct affected URLs: pages with at least one issue at the
  // latest month, run through the same utility filter so the X
  // numerator and the Y denominator describe the same set. Joined
  // back to crawl_urls so we can apply realUserPageRowFilters (status,
  // content-type, indexability live there, not on site_issue_urls).
  // The JOIN needs a table-qualified scope column to avoid ambiguity.
  const Ssiu = uploadScopeFragment(clientId, scope, 'siu.csv_upload_id');
  const monthResult = await turso.execute({
    sql: `SELECT DISTINCT month FROM site_issue_urls WHERE client_id = ?${S.frag} ORDER BY month DESC LIMIT 1`,
    args: [clientId, ...S.args],
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
              AND cu.month = siu.month
            WHERE siu.client_id = ?
              AND siu.month = ?${Ssiu.frag}
            ${realUserPageRowFilters('cu')}
            ${realUserPageUrlExclusions('siu.url')}`,
      args: [clientId, month, ...Ssiu.args],
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
