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
import { nanoid } from 'nanoid';
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

  // Bootstrap path: client has no client_sites rows yet. Fall back to
  // clients.domain and create a primary managed site if a zone matches.
  // This is the common case for clients added via the create-client
  // form (which doesn't capture a domain field). Admin sets the
  // Domain via Edit, then Auto-link creates the site row.
  if (sitesRes.rows.length === 0) {
    const clientRes = await turso.execute({
      sql: `SELECT domain FROM clients WHERE id = ?`,
      args: [clientId],
    });
    if (clientRes.rows.length === 0) {
      return json({ ok: false, error: 'Client not found.' }, 404);
    }
    const clientDomain = (clientRes.rows[0] as any)[0]
      ? String((clientRes.rows[0] as any)[0]).trim()
      : '';
    if (!clientDomain) {
      return json({
        ok: false,
        error: 'This client has no sites and no domain set. Click Edit above and set the Domain field, then try Auto-link again. Visible zones in your account: ' + zones.map(z => z.name).join(', '),
      }, 400);
    }
    const matchingZone = zoneByName.get(normalize(clientDomain));
    if (!matchingZone) {
      return json({
        ok: false,
        error: `No zone in your CF account matches "${clientDomain}". Visible zones: ${zones.map(z => z.name).join(', ')}. Add the zone to CF or update the client's Domain to match an existing zone.`,
      }, 400);
    }

    // Create the primary managed site row + set zone_id in one INSERT.
    const newId = nanoid();
    await turso.execute({
      sql: `INSERT INTO client_sites
            (id, client_id, domain, is_primary, is_managed, label, sort_order, cloudflare_zone_id)
            VALUES (?, ?, ?, 1, 1, ?, 0, ?)`,
      args: [newId, clientId, clientDomain, clientDomain, matchingZone.id],
    });

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
      summary: `${locals.user!.name} bootstrapped Cloudflare site ${clientDomain} from clients.domain (1 zone matched)`,
    });

    return json({
      ok: true,
      matched: [{
        site_id: newId,
        domain: clientDomain,
        zone_id: matchingZone.id,
        zone_name: matchingZone.name,
        created_site: true,
      }],
      unmatched: [],
      total_zones_in_account: zones.length,
    });
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
