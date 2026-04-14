import type { APIRoute } from 'astro';
import turso from '../../../../lib/turso';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// Reads from keyword_snapshots joined to periods. Response shape
// unchanged: { month: 'YYYY-MM', keywords: [...] }.

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

  // Latest period that has data for this source.
  const periodResult = await turso.execute({
    sql: `SELECT p.id, SUBSTR(p.period_start, 1, 7) AS month_label
          FROM periods p
          WHERE p.client_id = ?
            AND EXISTS (SELECT 1 FROM keyword_snapshots k WHERE k.period_id = p.id AND k.source = ?)
          ORDER BY p.period_start DESC
          LIMIT 1`,
    args: [clientId, source],
  });

  if (periodResult.rows.length === 0) {
    return json({ month: null, keywords: [] });
  }

  const periodId = periodResult.rows[0][0] as string;
  const month = periodResult.rows[0][1] as string;

  const validSort = ['position', 'search_volume', 'keyword', 'seo_difficulty'].includes(sort) ? sort : 'position';
  const validOrder = order.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

  const result = await turso.execute({
    sql: `SELECT keyword, position, search_volume, url, change_val, seo_difficulty
          FROM keyword_snapshots
          WHERE client_id = ? AND period_id = ? AND source = ?
          ORDER BY ${validSort} ${validOrder} NULLS LAST, keyword
          LIMIT ?`,
    args: [clientId, periodId, source, limit],
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
