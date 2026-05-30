// Client-initiated "Request a data update" on a live page.
//
// Not every data source is auto-connected (a site crawl is a manual or paid
// step), so the live pages show a request button. Pressing it pings Cody to
// refresh that source. POST (writes a notification, so it inherits the CSRF
// gate). Any logged-in user may request for their own client; an admin may
// pass an explicit client_id.

import type { APIRoute } from 'astro';
import turso from '../../../lib/turso';
import { onDataUpdateRequested } from '../../../lib/triggers';
import { getRequestUsage, recordRequest } from '../../../lib/data-update-requests';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const SOURCE_LABELS: Record<string, string> = {
  traffic: 'analytics',
  search: 'search performance',
  health: 'site health',
};

// Resolve the client this request is about: a client user's own client, or
// an admin's explicit client_id.
function resolveClientId(user: { role: string; client_id?: string | null }, explicit: string | null): string | null {
  return user.role === 'admin' ? (explicit || null) : (user.client_id || null);
}

// Read the current month's usage (for the chip on the live pages).
export const GET: APIRoute = async ({ locals, url }) => {
  if (!locals.user) return json({ error: 'Unauthorized' }, 401);
  const clientId = resolveClientId(locals.user, url.searchParams.get('client_id'));
  if (!clientId) return json({ error: 'No client specified' }, 400);
  return json(await getRequestUsage(clientId));
};

export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: 'Unauthorized' }, 401);

  let body: any = {};
  try { body = await request.json(); } catch { /* tolerate empty body */ }

  const clientId = resolveClientId(locals.user, body.client_id || null);
  if (!clientId) return json({ error: 'No client specified' }, 400);

  // Enforce the twice-a-month cap server-side. The button disables itself
  // when out, but a client could still POST directly.
  const usage = await getRequestUsage(clientId);
  if (usage.remaining <= 0) {
    return json({ error: 'You have used both data updates for this month. They reset at the start of next month.', usage }, 429);
  }

  const sourceKey = String(body.source || '').toLowerCase();
  const sourceLabel = SOURCE_LABELS[sourceKey] || 'site';

  const clientRes = await turso.execute({ sql: 'SELECT name FROM clients WHERE id = ?', args: [clientId] });
  const clientName = (clientRes.rows[0]?.[0] as string) || 'a client';
  const requestedByName = locals.user.name || 'A client';

  await recordRequest({ clientId, source: sourceKey || 'site', requestedByName });
  await onDataUpdateRequested({ clientId, clientName, sourceLabel, requestedByName });

  return json({ ok: true, usage: await getRequestUsage(clientId) });
};
