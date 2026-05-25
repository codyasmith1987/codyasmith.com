// Admin endpoint: for one client, list the Cloudflare zones the
// account token can see and link each of the client's sites whose
// hostname matches a zone name. Sets cloudflare_zone_id on the
// matching client_sites rows.
//
// Overwrites existing cloudflare_zone_id values to keep the linking
// idempotent — if a zone moves or is renamed, the next click
// re-resolves. Per-site cloudflare_api_token is left untouched
// (admin manages overrides explicitly).
//
// POST { client_id }
// Response:
//   {
//     ok: true,
//     matched: [{ site_id, domain, zone_id, zone_name }],
//     unmatched: [{ site_id, domain }],
//     total_zones_in_account: N
//   }

import type { APIRoute } from 'astro';
import turso from '../../../../../lib/turso';
import { listZones } from '../../../../../lib/cloudflare';
import { logActivity } from '../../../../../lib/activity';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const CONFIG_ID = 'default';

function normalize(host: string): string {
  return host.toLowerCase().replace(/^www\./, '').trim();
}

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  let body: any = {};
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON body' }, 400); }

  const clientId = body?.client_id ? String(body.client_id).trim() : '';
  if (!clientId) return json({ error: 'client_id is required' }, 400);

  const cfgRes = await turso.execute({
    sql: `SELECT api_token FROM cloudflare_account_config WHERE id = ?`,
    args: [CONFIG_ID],
  });
  if (cfgRes.rows.length === 0) {
    return json({
      ok: false,
      error: 'No Cloudflare account token configured. Set one at the top of /portal/admin/clients first.',
    }, 400);
  }
  const token = String((cfgRes.rows[0] as any)[0]);

  const sitesRes = await turso.execute({
    sql: `SELECT id, domain FROM client_sites
          WHERE client_id = ? AND status = 'active'`,
    args: [clientId],
  });
  if (sitesRes.rows.length === 0) {
    return json({ ok: true, matched: [], unmatched: [], total_zones_in_account: 0 });
  }

  let zones;
  try {
    zones = await listZones(token);
  } catch (err: any) {
    return json({
      ok: false,
      error: err?.detail || err?.message || 'Failed to list zones from Cloudflare',
    }, 502);
  }

  const zoneByName = new Map<string, { id: string; name: string }>();
  for (const z of zones) {
    zoneByName.set(normalize(z.name), { id: z.id, name: z.name });
  }

  const matched: any[] = [];
  const unmatched: any[] = [];
  for (const row of sitesRes.rows) {
    const siteId = row[0] as string;
    const domain = row[1] as string;
    const key = normalize(domain);
    const zone = zoneByName.get(key);
    if (zone) {
      await turso.execute({
        sql: `UPDATE client_sites SET cloudflare_zone_id = ? WHERE id = ?`,
        args: [zone.id, siteId],
      });
      matched.push({ site_id: siteId, domain, zone_id: zone.id, zone_name: zone.name });
    } else {
      unmatched.push({ site_id: siteId, domain });
    }
  }

  await turso.execute({
    sql: `UPDATE cloudflare_account_config
          SET last_zone_list_synced_at = datetime('now')
          WHERE id = ?`,
    args: [CONFIG_ID],
  });

  await logActivity({
    clientId,
    userId: locals.user!.id,
    action: 'auto_linked',
    entityType: 'cloudflare',
    entityId: clientId,
    summary: `${locals.user!.name} auto-linked Cloudflare zones for ${matched.length} of ${matched.length + unmatched.length} sites`,
  });

  return json({
    ok: true,
    matched,
    unmatched,
    total_zones_in_account: zones.length,
  });
};
