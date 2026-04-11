import type { APIRoute } from 'astro';
import turso from '../../../../lib/turso';
import { ensurePortalTables } from '../../../../lib/auth';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals, url }) => {
  if (!locals.user) return json({ error: 'Unauthorized' }, 401);

  await ensurePortalTables();

  const clientId = locals.user.role === 'admin'
    ? (url.searchParams.get('client_id') || null)
    : locals.user.client_id;

  if (!clientId) return json({ error: 'No client specified' }, 400);

  const category = url.searchParams.get('category') || 'traffic';
  const months = parseInt(url.searchParams.get('months') || '6');

  const result = await turso.execute({
    sql: `SELECT month, metric_key, metric_value
          FROM metrics
          WHERE client_id = ? AND category = ?
          ORDER BY month DESC
          LIMIT ?`,
    args: [clientId, category, months * 20], // generous limit for multiple metrics per month
  });

  // Group by month
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
