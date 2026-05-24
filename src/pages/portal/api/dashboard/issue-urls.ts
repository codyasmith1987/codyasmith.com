// Per-issue URL list for the health page's expandable issue cards.
// Powered by site_issue_urls (populated by the per-issue CSV parser
// during upload) and enriched with classification from crawl_urls.
//
// Returns the URLs with a given issue at the latest month for the
// client, each labeled by what KIND of URL it is — page, tag archive,
// image, feed, attachment, etc. The popout renders pages in one
// section and other URLs in another so a client reading the list
// never sees a tag archive or an image labeled "page."
//
// The LEFT JOIN to crawl_urls supplies content_type and indexability
// when available so the classifier can distinguish indexable HTML
// pages from canonicalised / noindexed URLs. When site_issue_urls has
// a URL that does not exist in crawl_urls (some images come from
// images.csv, not the internal HTML export), the classifier falls
// back to URL-pattern-only inference, which is still strong enough
// to identify most non-page URL types.

import type { APIRoute } from 'astro';
import turso from '../../../../lib/turso';
import { classifyUrl, type UrlType } from '../../../../lib/url-classifier';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals, url }) => {
  if (!locals.user) return json({ error: 'Unauthorized' }, 401);

  const clientId = locals.user.role === 'admin'
    ? (url.searchParams.get('client_id') || null)
    : locals.user.client_id;
  const issueName = url.searchParams.get('issue_name') || '';
  if (!clientId) return json({ error: 'No client specified' }, 400);
  if (!issueName) return json({ error: 'issue_name is required' }, 400);

  // Find the latest month with rows for this client + issue. Matches
  // the health page's "latest month" behavior elsewhere.
  const monthResult = await turso.execute({
    sql: 'SELECT DISTINCT month FROM site_issue_urls WHERE client_id = ? AND issue_name = ? ORDER BY month DESC LIMIT 1',
    args: [clientId, issueName],
  });
  if (monthResult.rows.length === 0) {
    return json({
      month: null, issue_name: issueName,
      urls: [], pages_count: 0, other_count: 0, by_type: {},
    });
  }
  const month = monthResult.rows[0][0] as string;

  // LEFT JOIN to crawl_urls so we get content_type + indexability
  // when available. When the URL doesn't appear in crawl_urls (e.g.,
  // an image referenced only from images.csv), the joined columns
  // come back NULL and the classifier falls back to URL patterns.
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
    if (classification.is_page) {
      pagesCount++;
    } else {
      otherCount++;
    }
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
  });
};
