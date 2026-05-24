// Per-issue URL list for the health page's expandable issue cards.
// Powered by site_issue_urls (populated by the per-issue CSV parser
// during upload). Returns the URLs that have a given issue at the
// latest month for the client, plus any per-URL extras the CSV
// carried (current title, current length, etc.) so the popout can
// show contextual detail next to each URL.

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
  const issueName = url.searchParams.get('issue_name') || '';
  if (!clientId) return json({ error: 'No client specified' }, 400);
  if (!issueName) return json({ error: 'issue_name is required' }, 400);

  // Find the latest month with rows for this client; matches the
  // health page's "latest month" behavior. Fall back to no data.
  const monthResult = await turso.execute({
    sql: 'SELECT DISTINCT month FROM site_issue_urls WHERE client_id = ? AND issue_name = ? ORDER BY month DESC LIMIT 1',
    args: [clientId, issueName],
  });
  if (monthResult.rows.length === 0) {
    return json({ month: null, issue_name: issueName, urls: [] });
  }
  const month = monthResult.rows[0][0] as string;

  const result = await turso.execute({
    sql: `SELECT url, extras FROM site_issue_urls
          WHERE client_id = ? AND month = ? AND issue_name = ?
          ORDER BY url ASC`,
    args: [clientId, month, issueName],
  });

  const urls = result.rows.map(row => {
    const extrasRaw = row[1] as string | null;
    let extras: any = null;
    if (extrasRaw) {
      try { extras = JSON.parse(extrasRaw); } catch { /* swallow */ }
    }
    return { url: row[0] as string, extras };
  });

  return json({ month, issue_name: issueName, urls, count: urls.length });
};
