// Site-health issues dashboard endpoint.
//
// Reads through the shared crawl-read layer so the page, the report, and the
// health score all share one rollup + priority definition (no drift). The
// {month, issues} shape is unchanged for the existing UI; by_priority and
// the prior-cycle fields are additive, for the page's priority counts and
// the "vs last month" comparison.

import type { APIRoute } from 'astro';
import { getHealthLatestMonth, getHealthPriorMonth, getHealthMonthData } from '../../../../lib/crawl-read';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals, url }) => {
  if (!locals.user) return json({ error: 'Unauthorized' }, 401);

  const clientId = locals.user.role === 'admin'
    ? (url.searchParams.get('client_id') || null)
    : locals.user.client_id;
  if (!clientId) return json({ error: 'No client specified' }, 400);

  const month = await getHealthLatestMonth(clientId);
  if (!month) return json({ month: null, issues: [] });

  const current = await getHealthMonthData(clientId, month);
  const priorMonth = await getHealthPriorMonth(clientId, month);
  const prior = priorMonth ? await getHealthMonthData(clientId, priorMonth) : null;

  return json({
    month,
    issues: current.issues,
    advisories: current.advisories,           // optional hardening (not scored, not "problems")
    by_priority: current.byPriority,
    total_issues: current.totalIssues,
    prior_month: priorMonth,
    prior_by_priority: prior ? prior.byPriority : null,
    prior_total_issues: prior ? prior.totalIssues : null,
  });
};
