// Admin endpoint: store Cloudflare zone ID + API token for a
// client_sites row. Used by the clients admin UI.
//
// POST { site_id, zone_id, api_token? }
//
//   - site_id: required.
//   - zone_id: required. Empty string clears the zone.
//   - api_token: optional. Omit to leave the existing token in
//     place (so the admin can update the zone without re-entering
//     the token). Empty string clears the token. Otherwise replaces.
//
// Token is stored plaintext for v1. Scope it to Zone Analytics:Read
// only when creating it in the Cloudflare dashboard to limit blast
// radius. A future migration will encrypt at rest.

import type { APIRoute } from 'astro';
import turso from '../../../../../lib/turso';
import { logActivity } from '../../../../../lib/activity';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  let body: any = {};
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON body' }, 400); }

  const siteId = body?.site_id ? String(body.site_id).trim() : '';
  if (!siteId) return json({ error: 'site_id is required' }, 400);

  const zoneId = typeof body?.zone_id === 'string' ? body.zone_id.trim() : null;
  const apiToken = typeof body?.api_token === 'string' ? body.api_token.trim() : undefined;

  // Validate the site exists + capture its client_id for the activity log.
  const siteRow = await turso.execute({
    sql: 'SELECT client_id, domain FROM client_sites WHERE id = ?',
    args: [siteId],
  });
  if (siteRow.rows.length === 0) return json({ error: 'Site not found' }, 404);
  const clientId = siteRow.rows[0][0] as string;
  const domain = siteRow.rows[0][1] as string;

  // Build the UPDATE depending on whether the token was supplied.
  // If not, we leave the existing token in place — the UI may be
  // updating just the zone ID, and we don't want to require the
  // admin to re-paste the token every time.
  if (apiToken === undefined) {
    await turso.execute({
      sql: 'UPDATE client_sites SET cloudflare_zone_id = ? WHERE id = ?',
      args: [zoneId || null, siteId],
    });
  } else {
    await turso.execute({
      sql: 'UPDATE client_sites SET cloudflare_zone_id = ?, cloudflare_api_token = ? WHERE id = ?',
      args: [zoneId || null, apiToken || null, siteId],
    });
  }

  // Activity log naming: do NOT echo the token. Mention only that
  // it was set/cleared so the audit trail doesn't leak secrets.
  const tokenAction = apiToken === undefined
    ? '(token unchanged)'
    : (apiToken ? '(token set)' : '(token cleared)');
  await logActivity({
    clientId,
    userId: locals.user!.id,
    action: 'configured',
    entityType: 'cloudflare',
    entityId: siteId,
    summary: `${locals.user!.name} updated Cloudflare config for ${domain}: zone=${zoneId || '(cleared)'} ${tokenAction}`,
  });

  return json({ ok: true });
};
