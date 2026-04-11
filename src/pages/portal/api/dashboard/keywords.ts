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

  const sort = url.searchParams.get('sort') || 'position';
  const order = url.searchParams.get('order') || 'ASC';
  const source = url.searchParams.get('source') || 'position_tracking';
  const limit = parseInt(url.searchParams.get('limit') || '100');

  // Get latest month with keyword data
  const monthResult = await turso.execute({
    sql: 'SELECT DISTINCT month FROM keyword_rankings WHERE client_id = ? AND source = ? ORDER BY month DESC LIMIT 1',
    args: [clientId, source],
  });

  if (monthResult.rows.length === 0) {
    return json({ month: null, keywords: [] });
  }

  const month = monthResult.rows[0][0] as string;

  const validSort = ['position', 'search_volume', 'keyword', 'seo_difficulty'].includes(sort) ? sort : 'position';
  const validOrder = order.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

  const result = await turso.execute({
    sql: `SELECT keyword, position, search_volume, url, change_val, seo_difficulty
          FROM keyword_rankings
          WHERE client_id = ? AND month = ? AND source = ?
          ORDER BY ${validSort} ${validOrder} NULLS LAST
          LIMIT ?`,
    args: [clientId, month, source, limit],
  });

  const keywords = result.rows.map(row => ({
    keyword: row[0] as string,
    position: row[1] as number | null,
    search_volume: row[2] as number | null,
    url: row[3] as string | null,
    change: row[4] as number | null,
    seo_difficulty: row[5] as number | null,
  }));

  return json({ month, keywords });
};
