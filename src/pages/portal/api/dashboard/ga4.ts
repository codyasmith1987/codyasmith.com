// GA4 dashboard data endpoint.
//
// Returns the latest month of GA4 ingestion for one client in the shape
// /portal/traffic renders. The reads live in src/lib/ga4-read.ts so this
// endpoint and the monthly report generator share one query path. This
// file is now just: resolve scope, delegate, wrap.

import type { APIRoute } from 'astro';
import { getGa4DashboardWithPrior } from '../../../../lib/ga4-read';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals, url }) => {
  if (!locals.user) return json({ error: 'Unauthorized' }, 401);

  const clientId = locals.user.role === 'admin'
    ? (url.searchParams.get('client_id') || null)
    : locals.user.client_id;
  if (!clientId) return json({ error: 'No client specified' }, 400);

  const data = await getGa4DashboardWithPrior(clientId);
  return json(data);
};
