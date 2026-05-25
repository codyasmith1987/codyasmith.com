// Admin endpoint: manage the Cloudflare ACCOUNT-LEVEL API token.
//
// One token scoped to "All zones in account, Analytics:Read" replaces
// per-site token paste. Stored in cloudflare_account_config with
// id='default'. Per-site tokens on client_sites stay as overrides
// for cross-account scenarios.
//
// GET                  → { configured, label, last_synced_at }
// POST { api_token, label? } → validates by listing zones, then upserts.
//                              Response: { ok, zone_count, sample_zones }
// DELETE               → clears the row

import type { APIRoute } from 'astro';
import turso from '../../../../../lib/turso';
import { logActivity } from '../../../../../lib/activity';
import { listZones } from '../../../../../lib/cloudflare';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const CONFIG_ID = 'default';

export const GET: APIRoute = async ({ locals }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  const res = await turso.execute({
    sql: `SELECT label, last_zone_list_synced_at, api_token
          FROM cloudflare_account_config
          WHERE id = ?`,
    args: [CONFIG_ID],
  });
  if (res.rows.length === 0) {
    return json({ configured: false });
  }
  const row = res.rows[0] as any;
  return json({
    configured: !!row[2],
    label: row[0] || null,
    last_zone_list_synced_at: row[1] || null,
  });
};

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  let body: any = {};
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON body' }, 400); }

  const apiToken = body?.api_token ? String(body.api_token).trim() : '';
  const label = body?.label ? String(body.label).trim() : '';
  if (!apiToken) return json({ error: 'api_token is required' }, 400);

  // Validate by listing zones. A token with the wrong scope or wrong
  // value fails here before we ever store it, so the configured state
  // always reflects a working token.
  let zones;
  try {
    zones = await listZones(apiToken);
  } catch (err: any) {
    return json({
      ok: false,
      error: err?.detail || err?.message || 'Failed to validate token against Cloudflare /zones',
    }, 400);
  }

  await turso.execute({
    sql: `INSERT INTO cloudflare_account_config
            (id, label, api_token, last_zone_list_synced_at, updated_at)
          VALUES (?, ?, ?, datetime('now'), datetime('now'))
          ON CONFLICT(id) DO UPDATE SET
            label = excluded.label,
            api_token = excluded.api_token,
            last_zone_list_synced_at = excluded.last_zone_list_synced_at,
            updated_at = excluded.updated_at`,
    args: [CONFIG_ID, label || 'Cloudflare account', apiToken],
  });

  await logActivity({
    userId: locals.user!.id,
    action: 'configured',
    entityType: 'cloudflare_account',
    entityId: CONFIG_ID,
    summary: `${locals.user!.name} set the Cloudflare account token (${zones.length} zones visible)`,
  });

  return json({
    ok: true,
    zone_count: zones.length,
    sample_zones: zones.slice(0, 5).map(z => z.name),
  });
};

export const DELETE: APIRoute = async ({ locals }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  await turso.execute({
    sql: `DELETE FROM cloudflare_account_config WHERE id = ?`,
    args: [CONFIG_ID],
  });

  await logActivity({
    userId: locals.user!.id,
    action: 'cleared',
    entityType: 'cloudflare_account',
    entityId: CONFIG_ID,
    summary: `${locals.user!.name} cleared the Cloudflare account token`,
  });

  return json({ ok: true });
};
