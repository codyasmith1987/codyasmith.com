// Honest page counts for the site-health page. Replaces the misleading
// "354 page instances" rollup that summed `affected_urls` across every
// issue category (a 20-page site with 17 categories shows ~340).
//
// Returns:
//   - total_html_pages: distinct HTML URLs the crawler found (status 200,
//     content-type contains "html"). The "real pages" number a human
//     would name when asked "how many pages does my site have."
//   - distinct_affected_urls: distinct URL count across site_issue_urls
//     (the union of per-issue URL lists). The honest "how many of my
//     pages have at least one issue" number.

import type { APIRoute } from 'astro';
import turso from '../../../../lib/turso';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals, url }) => {
  if (!locals.user) return json({ error: 'Unauthorized' }, 401);

  const clientId = locals.user.role === 'admin'
    ? (url.searchParams.get('client_id') || null)
    : locals.user.client_id;
  if (!clientId) return json({ error: 'No client specified' }, 400);

  // Total HTML pages from the most recent crawl. crawl_urls holds one
  // row per URL per upload; filter to status 200 and content-type
  // containing "html". indexability is left unfiltered so noindex'd
  // pages still count as "pages on the site" — they exist even if
  // search engines don't index them.
  const pagesResult = await turso.execute({
    sql: `SELECT COUNT(DISTINCT url) AS n
          FROM crawl_urls
          WHERE client_id = ?
            AND status_code = 200
            AND LOWER(IFNULL(content_type, '')) LIKE '%html%'`,
    args: [clientId],
  });
  const totalHtmlPages = (pagesResult.rows[0]?.[0] as number) || 0;

  // Distinct URLs across site_issue_urls (latest month). When the
  // per-issue parser has not run yet, this returns 0 and the caller
  // can fall back to summing affected_urls from /api/dashboard/issues.
  const monthResult = await turso.execute({
    sql: 'SELECT DISTINCT month FROM site_issue_urls WHERE client_id = ? ORDER BY month DESC LIMIT 1',
    args: [clientId],
  });
  let distinctAffectedUrls = 0;
  let month: string | null = null;
  if (monthResult.rows.length > 0) {
    month = monthResult.rows[0][0] as string;
    const affectedResult = await turso.execute({
      sql: 'SELECT COUNT(DISTINCT url) AS n FROM site_issue_urls WHERE client_id = ? AND month = ?',
      args: [clientId, month],
    });
    distinctAffectedUrls = (affectedResult.rows[0]?.[0] as number) || 0;
  }

  return json({
    total_html_pages: totalHtmlPages,
    distinct_affected_urls: distinctAffectedUrls,
    month,
  });
};
