// GA4 dashboard data endpoint.
//
// Returns the latest month of GA4 ingestion for one client in the shape
// /portal/traffic renders. The reads live in src/lib/ga4-read.ts so this
// endpoint and the monthly report generator share one query path. This
// file is now just: resolve scope, delegate, wrap.

import type { APIRoute } from 'astro';
import { getGa4DashboardWithPrior } from '../../../../lib/ga4-read';
import { resolveSiteScope } from '../../../../lib/site-scope';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals, url }) => {
  if (!locals.user) return json({ error: 'Unauthorized' }, 401);

  const clientId = locals.user.role === 'admin'
    ? (url.searchParams.get('client_id') || null)
    : locals.user.client_id;
  if (!clientId) return json({ error: 'No client specified' }, 400);

  // Per-site scoping for multi-site clients (Phase 1c): ?site=<domain>,
  // default primary; single-site clients get undefined scope = unchanged.
  // The response carries the site list so the page draws its chips once.
  const scope = await resolveSiteScope(clientId, url.searchParams.get('site'));
  const siteMeta = scope ? { sites: scope.sites, site: scope.domain } : {};

  const data = await getGa4DashboardWithPrior(clientId, scope);
  return json({ ...data, ...siteMeta });
};
