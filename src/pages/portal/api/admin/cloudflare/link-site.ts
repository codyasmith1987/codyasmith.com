// Admin endpoint: assign a Cloudflare zone to a client.
//
// If the client already has a client_sites row with the zone's
// hostname, set cloudflare_zone_id on that row. Otherwise INSERT
// a new managed site row (is_managed=1, is_primary=1 if this is
// the client's first site).
//
// If the zone is currently linked to a DIFFERENT client's site,
// unset that linkage (one zone, one site, no stale dual ownership).
// The previous site row stays — just loses its CF link.
//
// POST { zone_id, zone_name, client_id }
// Response: { ok, site_id, site_created: boolean, displaced?: { client_id, site_id } }

import type { APIRoute } from 'astro';
import { nanoid } from 'nanoid';
import turso from '../../../../../lib/turso';
import { logActivity } from '../../../../../lib/activity';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

function normalize(host: string): string {
  return host.toLowerCase().replace(/^www\./, '').trim();
}

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  let body: any = {};
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON body' }, 400); }

  const zoneId = body?.zone_id ? String(body.zone_id).trim() : '';
  const zoneName = body?.zone_name ? String(body.zone_name).trim() : '';
  const clientId = body?.client_id ? String(body.client_id).trim() : '';
  if (!zoneId || !zoneName || !clientId) {
    return json({ error: 'zone_id, zone_name, and client_id are required' }, 400);
  }
  const normalizedZoneName = normalize(zoneName);

  // Displace existing linkage if the zone is on a different site.
  // We update the row to null out the zone_id; we don't delete the
  // site row (the admin may have other data tied to it).
  let displaced: any = null;
  const existingLink = await turso.execute({
    sql: `SELECT id, client_id FROM client_sites WHERE cloudflare_zone_id = ?`,
    args: [zoneId],
  });
  for (const row of existingLink.rows as any[]) {
    const existingSiteId = String(row[0]);
    const existingClientId = String(row[1]);
    if (existingClientId !== clientId) {
      await turso.execute({
        sql: `UPDATE client_sites SET cloudflare_zone_id = NULL WHERE id = ?`,
        args: [existingSiteId],
      });
      displaced = { client_id: existingClientId, site_id: existingSiteId };
    }
  }

  // Does this client already have a site for this hostname?
  const existingSiteRes = await turso.execute({
    sql: `SELECT id, domain FROM client_sites WHERE client_id = ?`,
    args: [clientId],
  });
  let targetSiteId: string | null = null;
  for (const row of existingSiteRes.rows as any[]) {
    if (normalize(String(row[1])) === normalizedZoneName) {
      targetSiteId = String(row[0]);
      break;
    }
  }

  let siteCreated = false;
  if (targetSiteId) {
    await turso.execute({
      sql: `UPDATE client_sites SET cloudflare_zone_id = ? WHERE id = ?`,
      args: [zoneId, targetSiteId],
    });
  } else {
    // First site for this client gets is_primary=1.
    const isFirstSite = existingSiteRes.rows.length === 0;
    targetSiteId = nanoid();
    await turso.execute({
      sql: `INSERT INTO client_sites
            (id, client_id, domain, is_primary, is_managed, label, sort_order, cloudflare_zone_id)
            VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
      args: [
        targetSiteId,
        clientId,
        zoneName,
        isFirstSite ? 1 : 0,
        zoneName,
        existingSiteRes.rows.length,
        zoneId,
      ],
    });
    siteCreated = true;

    // If this is the first site, mirror to clients.domain when empty.
    if (isFirstSite) {
      await turso.execute({
        sql: `UPDATE clients SET domain = ? WHERE id = ? AND (domain IS NULL OR domain = '')`,
        args: [zoneName, clientId],
      });
    }
  }

  await logActivity({
    clientId,
    userId: locals.user!.id,
    action: 'assigned',
    entityType: 'cloudflare_zone',
    entityId: zoneId,
    summary: `${locals.user!.name} assigned Cloudflare zone ${zoneName} to ${clientId}${siteCreated ? ' (created new site)' : ''}${displaced ? ` (displaced from client ${displaced.client_id})` : ''}`,
  });

  return json({
    ok: true,
    site_id: targetSiteId,
    site_created: siteCreated,
    displaced,
  });
};
