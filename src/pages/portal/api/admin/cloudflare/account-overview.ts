// Admin endpoint: list every zone the account token can see + which
// client_sites row (if any) is linked to each. Powers the
// "Browse account zones" admin UI on /portal/admin/clients.
//
// Each step wrapped in try/catch + console-logged timing so DO logs
// show exactly where it hangs when the response 504s. ?skip_zones=1
// query param skips the CF API call as a diagnostic.

import type { APIRoute } from 'astro';
import turso from '../../../../../lib/turso';
import { listZones } from '../../../../../lib/cloudflare';
import { logger } from '../../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const CONFIG_ID = 'default';

export const GET: APIRoute = async ({ locals, url }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  const skipZones = url.searchParams.get('skip_zones') === '1';
  const overallStart = Date.now();
  const timings: Record<string, number> = {};
  const stepStart = () => Date.now();
  const stepEnd = (name: string, t0: number) => {
    timings[name] = Date.now() - t0;
    logger.info(`[account-overview] ${name}: ${timings[name]}ms`);
  };

  // Step 1: token
  let token: string;
  try {
    const t0 = stepStart();
    const cfgRes = await turso.execute({
      sql: `SELECT api_token FROM cloudflare_account_config WHERE id = ?`,
      args: [CONFIG_ID],
    });
    stepEnd('select_token', t0);
    if (cfgRes.rows.length === 0) {
      return json({
        error: 'No Cloudflare account token configured. Set one in the banner above first.',
        debug: { timings, overall_ms: Date.now() - overallStart },
      }, 400);
    }
    token = String((cfgRes.rows[0] as any)[0]);
  } catch (err: any) {
    logger.error('[account-overview] select_token failed', err);
    return json({
      error: `Step select_token failed: ${err?.message || err}`,
      debug: { timings, overall_ms: Date.now() - overallStart },
    }, 500);
  }

  // Step 2: list zones from CF (skippable)
  let zones: any[] = [];
  if (!skipZones) {
    try {
      const t0 = stepStart();
      zones = await listZones(token);
      stepEnd('list_zones', t0);
    } catch (err: any) {
      const errPayload = {
        name: err?.name,
        message: err?.message,
        detail: err?.detail,
        stack: err?.stack?.split('\n').slice(0, 3).join(' | '),
        raw: typeof err === 'string' ? err : JSON.stringify(err).slice(0, 1000),
      };
      logger.error(`[account-overview] list_zones failed: ${JSON.stringify(errPayload)}`);
      // Return 200 not 502 because Cloudflare appears to transform
      // 5xx origin responses to their own 504 HTML, swallowing the
      // JSON. ok:false lets the client know it failed.
      return json({
        ok: false,
        step: 'list_zones',
        error: errPayload,
        debug: { timings, overall_ms: Date.now() - overallStart },
      }, 200);
    }
  }

  // Step 3: linked sites JOIN
  const linkedByZone = new Map<string, any>();
  try {
    const t0 = stepStart();
    const linkedRes = await turso.execute({
      sql: `SELECT cs.cloudflare_zone_id, cs.id, cs.domain, c.id, c.name
            FROM client_sites cs
            JOIN clients c ON c.id = cs.client_id
            WHERE cs.cloudflare_zone_id IS NOT NULL`,
    });
    stepEnd('select_linked', t0);
    for (const row of linkedRes.rows as any[]) {
      linkedByZone.set(String(row[0]), {
        site_id: String(row[1]),
        site_domain: String(row[2]),
        client_id: String(row[3]),
        client_name: String(row[4]),
      });
    }
  } catch (err: any) {
    logger.error('[account-overview] select_linked failed', err);
    return json({
      error: `Step select_linked failed: ${err?.message || err}`,
      debug: { timings, overall_ms: Date.now() - overallStart },
    }, 500);
  }

  // Step 4: client list
  let clients: any[] = [];
  try {
    const t0 = stepStart();
    const clientsRes = await turso.execute({
      sql: `SELECT id, name FROM clients WHERE active = 1 ORDER BY name`,
    });
    stepEnd('select_clients', t0);
    clients = (clientsRes.rows as any[]).map(r => ({
      id: String(r[0]),
      name: String(r[1]),
    }));
  } catch (err: any) {
    logger.error('[account-overview] select_clients failed', err);
    return json({
      error: `Step select_clients failed: ${err?.message || err}`,
      debug: { timings, overall_ms: Date.now() - overallStart },
    }, 500);
  }

  const totalMs = Date.now() - overallStart;
  logger.info(`[account-overview] total: ${totalMs}ms (skip_zones=${skipZones})`);

  return json({
    zones: zones.map(z => ({
      zone_id: z.id,
      zone_name: z.name,
      account_id: z.account_id,
      account_name: z.account_name,
      linked: linkedByZone.get(z.id) || null,
    })),
    clients,
    debug: { timings, overall_ms: totalMs, skipped_zones: skipZones },
  });
};
