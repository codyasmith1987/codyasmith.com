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

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const SOURCE_LABELS: Record<string, string> = {
  traffic: 'analytics',
  search: 'search performance',
  health: 'site health',
};

export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return json({ error: 'Unauthorized' }, 401);

  let body: any = {};
  try { body = await request.json(); } catch { /* tolerate empty body */ }

  const clientId = locals.user.role === 'admin'
    ? (body.client_id || null)
    : locals.user.client_id;
  if (!clientId) return json({ error: 'No client specified' }, 400);

  const sourceKey = String(body.source || '').toLowerCase();
  const sourceLabel = SOURCE_LABELS[sourceKey] || 'site';

  const clientRes = await turso.execute({ sql: 'SELECT name FROM clients WHERE id = ?', args: [clientId] });
  const clientName = (clientRes.rows[0]?.[0] as string) || 'a client';

  await onDataUpdateRequested({
    clientId,
    clientName,
    sourceLabel,
    requestedByName: locals.user.name || 'A client',
  });

  return json({ ok: true });
};
