import type { APIRoute } from 'astro';
import turso from '../../../../lib/turso';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals, url }) => {
  if (!locals.user) return json({ error: 'Unauthorized' }, 401);

  // Admin can query any client, clients see their own
  const clientId = locals.user.role === 'admin'
    ? (url.searchParams.get('client_id') || null)
    : locals.user.client_id;

  if (!clientId) return json({ error: 'No client specified' }, 400);

  // Get the latest month with data
  const latestResult = await turso.execute({
    sql: 'SELECT DISTINCT month FROM metrics WHERE client_id = ? ORDER BY month DESC LIMIT 2',
    args: [clientId],
  });

  if (latestResult.rows.length === 0) {
    return json({ current_month: null, metrics: [], previous: [] });
  }

  const currentMonth = latestResult.rows[0][0] as string;
  const prevMonth = latestResult.rows.length > 1 ? latestResult.rows[1][0] as string : null;

  // Get current month metrics
  const currentResult = await turso.execute({
    sql: 'SELECT category, metric_key, metric_value FROM metrics WHERE client_id = ? AND month = ? ORDER BY category, metric_key',
    args: [clientId, currentMonth],
  });

  const metrics = currentResult.rows.map(row => ({
    category: row[0] as string,
    key: row[1] as string,
    value: row[2] as number,
  }));

  // Get previous month for deltas
  let previous: typeof metrics = [];
  if (prevMonth) {
    const prevResult = await turso.execute({
      sql: 'SELECT category, metric_key, metric_value FROM metrics WHERE client_id = ? AND month = ?',
      args: [clientId, prevMonth],
    });
    previous = prevResult.rows.map(row => ({
      category: row[0] as string,
      key: row[1] as string,
      value: row[2] as number,
    }));
  }

  return json({ current_month: currentMonth, previous_month: prevMonth, metrics, previous });
};
