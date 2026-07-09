import type { APIRoute } from 'astro';
import turso from '../../../../lib/turso';
import { resolveSiteScope, uploadScopeFragment } from '../../../../lib/site-scope';

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

  // Per-site scoping for multi-site clients (Phase 1c): ?site=<domain>,
  // default primary; single-site clients get undefined scope = unchanged.
  // The response carries the site list so the page draws its chips once.
  const scope = await resolveSiteScope(clientId, url.searchParams.get('site'));
  const siteMeta = scope ? { sites: scope.sites, site: scope.domain } : {};
  const s = uploadScopeFragment(clientId, scope);

  // Get the latest month with data
  const latestResult = await turso.execute({
    sql: `SELECT DISTINCT month FROM metrics WHERE client_id = ?${s.frag} ORDER BY month DESC LIMIT 2`,
    args: [clientId, ...s.args],
  });

  if (latestResult.rows.length === 0) {
    return json({ current_month: null, metrics: [], previous: [], ...siteMeta });
  }

  const currentMonth = latestResult.rows[0][0] as string;
  const prevMonth = latestResult.rows.length > 1 ? latestResult.rows[1][0] as string : null;

  // Get current month metrics
  const currentResult = await turso.execute({
    sql: `SELECT category, metric_key, metric_value FROM metrics WHERE client_id = ? AND month = ?${s.frag} ORDER BY category, metric_key`,
    args: [clientId, currentMonth, ...s.args],
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
      sql: `SELECT category, metric_key, metric_value FROM metrics WHERE client_id = ? AND month = ?${s.frag}`,
      args: [clientId, prevMonth, ...s.args],
    });
    previous = prevResult.rows.map(row => ({
      category: row[0] as string,
      key: row[1] as string,
      value: row[2] as number,
    }));
  }

  return json({ current_month: currentMonth, previous_month: prevMonth, metrics, previous, ...siteMeta });
};
