import type { APIRoute } from 'astro';
import turso from '../../../../lib/turso';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// Reads from metric_snapshots joined to periods. The client-visible
// `current_month` / `previous_month` keys still return 'YYYY-MM' labels
// derived from period_start so the existing frontend doesn't need to
// change.

export const GET: APIRoute = async ({ locals, url }) => {
  if (!locals.user) return json({ error: 'Unauthorized' }, 401);

  const clientId = locals.user.role === 'admin'
    ? (url.searchParams.get('client_id') || null)
    : locals.user.client_id;

  if (!clientId) return json({ error: 'No client specified' }, 400);

  // Latest two periods that actually have metrics.
  const periodsResult = await turso.execute({
    sql: `SELECT p.id, SUBSTR(p.period_start, 1, 7) AS month_label
          FROM periods p
          WHERE p.client_id = ?
            AND EXISTS (SELECT 1 FROM metric_snapshots m WHERE m.period_id = p.id)
          ORDER BY p.period_start DESC
          LIMIT 2`,
    args: [clientId],
  });

  if (periodsResult.rows.length === 0) {
    return json({ current_month: null, metrics: [], previous: [] });
  }

  const currentPeriodId = periodsResult.rows[0][0] as string;
  const currentMonth = periodsResult.rows[0][1] as string;
  const prevPeriodId = periodsResult.rows.length > 1 ? (periodsResult.rows[1][0] as string) : null;
  const prevMonth = periodsResult.rows.length > 1 ? (periodsResult.rows[1][1] as string) : null;

  const currentResult = await turso.execute({
    sql: `SELECT category, metric_key, metric_value
          FROM metric_snapshots
          WHERE client_id = ? AND period_id = ?
          ORDER BY category, metric_key`,
    args: [clientId, currentPeriodId],
  });

  const metrics = currentResult.rows.map(row => ({
    category: row[0] as string,
    key: row[1] as string,
    value: row[2] as number,
  }));

  let previous: typeof metrics = [];
  if (prevPeriodId) {
    const prevResult = await turso.execute({
      sql: `SELECT category, metric_key, metric_value
            FROM metric_snapshots
            WHERE client_id = ? AND period_id = ?`,
      args: [clientId, prevPeriodId],
    });
    previous = prevResult.rows.map(row => ({
      category: row[0] as string,
      key: row[1] as string,
      value: row[2] as number,
    }));
  }

  return json({ current_month: currentMonth, previous_month: prevMonth, metrics, previous });
};
