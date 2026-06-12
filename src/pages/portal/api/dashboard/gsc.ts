// Google Search Console dashboard data endpoint.
//
// Aggregates the latest month's GSC data into the shape /portal/search
// renders. Returns has_data:false when nothing has been uploaded yet so
// the UI can show an empty state without erroring.
//
// The reads live in src/lib/gsc-read.ts so this endpoint and the monthly
// report generator share one query path and can never drift. This file is
// now just: resolve scope, fan out the reads, assemble the response.

import type { APIRoute } from 'astro';
import {
  getGscLatestMonth, getGscPriorMonth, getGscTotals, getGscChart, getGscDimension, getGscFilters,
} from '../../../../lib/gsc-read';
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

  const month = await getGscLatestMonth(clientId, scope);
  if (!month) return json({ month: null, has_data: false, ...siteMeta });

  const totals = await getGscTotals(clientId, month, scope);
  const chart = await getGscChart(clientId, month, scope);
  const [queries, pages, countries, devices, searchAppearance] = await Promise.all([
    getGscDimension(clientId, month, 'query', 25, scope),
    getGscDimension(clientId, month, 'page', 25, scope),
    getGscDimension(clientId, month, 'country', 15, scope),
    getGscDimension(clientId, month, 'device', 10, scope),
    getGscDimension(clientId, month, 'search_appearance', 10, scope),
  ]);
  const filters = await getGscFilters(clientId, month, scope);

  // Prior cycle totals for the live page's "vs last month" comparison
  // (additive; null in the first cycle). Only the totals are needed for the
  // chips, not the full prior breakdown.
  const priorMonth = await getGscPriorMonth(clientId, month, scope);
  const priorTotals = priorMonth ? await getGscTotals(clientId, priorMonth, scope) : null;

  return json({
    month,
    has_data: true,
    totals,
    chart,
    queries,
    pages,
    countries,
    devices,
    search_appearance: searchAppearance,
    filters,
    prior_month: priorMonth,
    prior_totals: priorTotals,
    ...siteMeta,
  });
};
