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
  getGscLatestMonth, getGscTotals, getGscChart, getGscDimension, getGscFilters,
} from '../../../../lib/gsc-read';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals, url }) => {
  if (!locals.user) return json({ error: 'Unauthorized' }, 401);

  const clientId = locals.user.role === 'admin'
    ? (url.searchParams.get('client_id') || null)
    : locals.user.client_id;
  if (!clientId) return json({ error: 'No client specified' }, 400);

  const month = await getGscLatestMonth(clientId);
  if (!month) return json({ month: null, has_data: false });

  const totals = await getGscTotals(clientId, month);
  const chart = await getGscChart(clientId, month);
  const [queries, pages, countries, devices, searchAppearance] = await Promise.all([
    getGscDimension(clientId, month, 'query', 25),
    getGscDimension(clientId, month, 'page', 25),
    getGscDimension(clientId, month, 'country', 15),
    getGscDimension(clientId, month, 'device', 10),
    getGscDimension(clientId, month, 'search_appearance', 10),
  ]);
  const filters = await getGscFilters(clientId, month);

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
  });
};
