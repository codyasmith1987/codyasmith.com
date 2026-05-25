// Admin endpoint: list every zone the account token can see + which
// client_sites row (if any) is linked to each. Powers the
// "Browse account zones" admin UI on /portal/admin/clients.
//
// GET → {
//   zones: [
//     {
//       zone_id, zone_name, account_id, account_name,
//       linked: { client_id, client_name, site_id, site_domain } | null
//     }
//   ],
//   clients: [{ id, name }]   // for the assignment dropdowns
// }

import type { APIRoute } from 'astro';
import turso from '../../../../../lib/turso';
import { listZones } from '../../../../../lib/cloudflare';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const CONFIG_ID = 'default';

export const GET: APIRoute = async ({ locals }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  const cfgRes = await turso.execute({
    sql: `SELECT api_token FROM cloudflare_account_config WHERE id = ?`,
    args: [CONFIG_ID],
  });
  if (cfgRes.rows.length === 0) {
    return json({
      error: 'No Cloudflare account token configured. Set one in the banner above first.',
    }, 400);
  }
  const token = String((cfgRes.rows[0] as any)[0]);

  let zones;
  try {
    zones = await listZones(token);
  } catch (err: any) {
    return json({
      error: err?.detail || err?.message || 'Failed to list zones from Cloudflare',
    }, 502);
  }

  // Look up every linked site once. JOIN gives us client name in
  // the same row so the dropdown can render without a second round.
  const linkedRes = await turso.execute({
    sql: `SELECT cs.cloudflare_zone_id, cs.id, cs.domain, c.id, c.name
          FROM client_sites cs
          JOIN clients c ON c.id = cs.client_id
          WHERE cs.cloudflare_zone_id IS NOT NULL`,
  });
  const linkedByZone = new Map<string, any>();
  for (const row of linkedRes.rows as any[]) {
    linkedByZone.set(String(row[0]), {
      site_id: String(row[1]),
      site_domain: String(row[2]),
      client_id: String(row[3]),
      client_name: String(row[4]),
    });
  }

  // Client list for assignment dropdowns. Active only — inactive
  // clients shouldn't get new zone assignments.
  const clientsRes = await turso.execute({
    sql: `SELECT id, name FROM clients WHERE active = 1 ORDER BY name`,
  });
  const clients = (clientsRes.rows as any[]).map(r => ({
    id: String(r[0]),
    name: String(r[1]),
  }));

  return json({
    zones: zones.map(z => ({
      zone_id: z.id,
      zone_name: z.name,
      account_id: z.account_id,
      account_name: z.account_name,
      linked: linkedByZone.get(z.id) || null,
    })),
    clients,
  });
};
