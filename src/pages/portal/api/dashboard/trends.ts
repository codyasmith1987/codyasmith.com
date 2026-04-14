import type { APIRoute } from 'astro';
import turso from '../../../../lib/turso';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// Reads from metric_snapshots joined to periods. Time axis uses
// SUBSTR(period_start, 1, 7) to retain 'YYYY-MM' labels on the wire so
// the existing frontend doesn't need to change.

export const GET: APIRoute = async ({ locals, url }) => {
  if (!locals.user) return json({ error: 'Unauthorized' }, 401);

  const clientId = locals.user.role === 'admin'
    ? (url.searchParams.get('client_id') || null)
    : locals.user.client_id;

  if (!clientId) return json({ error: 'No client specified' }, 400);

  const category = url.searchParams.get('category') || 'traffic';
  const months = parseInt(url.searchParams.get('months') || '6');

  const result = await turso.execute({
    sql: `SELECT SUBSTR(p.period_start, 1, 7) AS month, m.metric_key, m.metric_value
          FROM metric_snapshots m
          JOIN periods p ON p.id = m.period_id
          WHERE m.client_id = ? AND m.category = ?
          ORDER BY p.period_start DESC
          LIMIT ?`,
    args: [clientId, category, months * 20],
  });

  const byMonth = new Map<string, Record<string, number>>();
  for (const row of result.rows) {
    const month = row[0] as string;
    if (!byMonth.has(month)) byMonth.set(month, {});
    byMonth.get(month)![row[1] as string] = row[2] as number;
  }

  const data = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, metrics]) => ({ month, ...metrics }));

  return json({ category, data });
};
