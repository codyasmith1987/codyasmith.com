import type { APIRoute } from 'astro';
import turso from '../../../../lib/turso';
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

  const sort = url.searchParams.get('sort') || 'position';
  const order = url.searchParams.get('order') || 'ASC';
  const source = url.searchParams.get('source') || 'position_tracking';
  // Clamp limit to [1, 500]. Without this an attacker could request
  // tens of thousands of rows in a single LIMIT clause and DoS the DB.
  // See security-audit-2026-05-12 round 2 SEC2-004.
  const rawLimit = parseInt(url.searchParams.get('limit') || '100', 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 500) : 100;

  // Per-site scoping for multi-site clients (Phase 1c): ?site=<domain>,
  // default primary; single-site clients get undefined scope = unchanged.
  // The response carries the site list so the page draws its chips once.
  const scope = await resolveSiteScope(clientId, url.searchParams.get('site'));
  const siteMeta = scope ? { sites: scope.sites, site: scope.domain } : {};
  const s = uploadScopeFragment(clientId, scope);

  // Get latest month with keyword data
  const monthResult = await turso.execute({
    sql: `SELECT DISTINCT month FROM keyword_rankings WHERE client_id = ? AND source = ?${s.frag} ORDER BY month DESC LIMIT 1`,
    args: [clientId, source, ...s.args],
  });

  if (monthResult.rows.length === 0) {
    return json({ month: null, keywords: [], ...siteMeta });
  }

  const month = monthResult.rows[0][0] as string;

  const validSort = ['position', 'search_volume', 'keyword', 'seo_difficulty'].includes(sort) ? sort : 'position';
  const validOrder = order.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

  const result = await turso.execute({
    sql: `SELECT keyword, position, search_volume, url, change_val, seo_difficulty
          FROM keyword_rankings
          WHERE client_id = ? AND month = ? AND source = ?${s.frag}
          ORDER BY ${validSort} ${validOrder} NULLS LAST
          LIMIT ?`,
    args: [clientId, month, source, ...s.args, limit],
  });

  const keywords = result.rows.map(row => ({
    keyword: row[0] as string,
    position: row[1] as number | null,
    search_volume: row[2] as number | null,
    url: row[3] as string | null,
    change: row[4] as number | null,
    seo_difficulty: row[5] as number | null,
  }));

  return json({ month, keywords, ...siteMeta });
};
