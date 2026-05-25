// Admin endpoint: pull the last N days of Cloudflare analytics for
// one client site (or all sites of a client) and store as daily
// aggregates.
//
// POST { client_id, site_id?, days? }
//
//   - client_id: required. Whose sites to sync.
//   - site_id: optional. If given, sync just that site. Otherwise
//     sync every client_sites row with cloudflare_zone_id +
//     cloudflare_api_token configured.
//   - days: optional. Default 30. Caps at 60 (Cloudflare's
//     httpRequests1dGroups limit per query).
//
// Idempotent — re-running for the same window overwrites the
// existing daily rows. Lets Cody refresh on demand without
// accumulating duplicates.

import type { APIRoute } from 'astro';
import { nanoid } from 'nanoid';
import turso from '../../../../../lib/turso';
import { logger } from '../../../../../lib/logger';
import { logActivity } from '../../../../../lib/activity';
import { fetchTrafficDaily, fetchSecurityDaily } from '../../../../../lib/cloudflare';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

interface SyncResult {
  site_id: string;
  domain: string;
  traffic_days: number;
  security_days: number;
  error?: string;
}

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  let body: any = {};
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON body' }, 400); }

  const clientId = body?.client_id ? String(body.client_id).trim() : '';
  if (!clientId) return json({ error: 'client_id is required' }, 400);

  const siteId = body?.site_id ? String(body.site_id).trim() : null;
  const days = Math.min(60, Math.max(1, Number(body?.days) || 30));

  // Compute window. `until` is yesterday because CF's daily aggregate
  // typically lags by 4-6 hours after midnight UTC; pulling "today"
  // returns partial data that looks wrong.
  const today = new Date();
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const since = new Date(yesterday.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  const untilDate = yesterday.toISOString().slice(0, 10);
  const sinceDate = since.toISOString().slice(0, 10);
  // Datetime versions for the security query.
  const untilISO = yesterday.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/T.*$/, 'T23:59:59Z');
  const sinceISO = since.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/T.*$/, 'T00:00:00Z');

  // Account-level token fallback. If a site has its own
  // cloudflare_api_token set, that wins; otherwise the account token
  // is used. The auto-link flow at /portal/admin/clients sets
  // cloudflare_zone_id from the account; sync just needs SOMETHING
  // that can read the zone.
  const accountCfgRes = await turso.execute({
    sql: `SELECT api_token FROM cloudflare_account_config WHERE id = 'default'`,
  });
  const accountToken: string | null = accountCfgRes.rows.length > 0
    ? String((accountCfgRes.rows[0] as any)[0])
    : null;

  // Resolve which sites to sync. Token requirement is RELAXED: a
  // site needs cloudflare_zone_id, plus either its own token or the
  // account token. The token resolution happens per row below.
  const sitesQuery = siteId
    ? `SELECT id, domain, cloudflare_zone_id, cloudflare_api_token
       FROM client_sites
       WHERE id = ? AND client_id = ?
         AND cloudflare_zone_id IS NOT NULL`
    : `SELECT id, domain, cloudflare_zone_id, cloudflare_api_token
       FROM client_sites
       WHERE client_id = ?
         AND cloudflare_zone_id IS NOT NULL`;
  const sitesArgs = siteId ? [siteId, clientId] : [clientId];

  const sitesRes = await turso.execute({ sql: sitesQuery, args: sitesArgs });
  if (sitesRes.rows.length === 0) {
    return json({
      ok: false,
      error: 'No client_sites rows have a cloudflare_zone_id set. Configure a zone manually, or set the account token and click Auto-link.',
    });
  }

  const results: SyncResult[] = [];
  for (const siteRow of sitesRes.rows) {
    const sId = siteRow[0] as string;
    const domain = siteRow[1] as string;
    const zoneId = siteRow[2] as string;
    const perSiteToken = siteRow[3] ? String(siteRow[3]) : null;
    const token = perSiteToken || accountToken;
    if (!token) {
      results.push({
        site_id: sId,
        domain,
        traffic_days: 0,
        security_days: 0,
        error: 'No token available — set the account token at the top of /portal/admin/clients, or paste a per-site token below.',
      });
      continue;
    }

    try {
      // Traffic. Fetch + upsert daily rows.
      const traffic = await fetchTrafficDaily(token, zoneId, sinceDate, untilDate);
      // Clear the window for this site before re-inserting so the
      // upsert is destructive and a re-sync replaces stale rows
      // instead of accumulating.
      await turso.execute({
        sql: `DELETE FROM cloudflare_traffic_daily
              WHERE client_id = ? AND site_id = ?
                AND date >= ? AND date <= ?`,
        args: [clientId, sId, sinceDate, untilDate],
      });
      for (const t of traffic) {
        await turso.execute({
          sql: `INSERT INTO cloudflare_traffic_daily
                  (id, client_id, site_id, date,
                   requests, cached_requests, bytes, cached_bytes,
                   threats, page_views)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            nanoid(), clientId, sId, t.date,
            t.requests, t.cachedRequests, t.bytes, t.cachedBytes,
            t.threats, t.pageViews,
          ],
        });
      }

      // Security. Same destructive-window pattern.
      const security = await fetchSecurityDaily(token, zoneId, sinceISO, untilISO);
      await turso.execute({
        sql: `DELETE FROM cloudflare_security_daily
              WHERE client_id = ? AND site_id = ?
                AND date >= ? AND date <= ?`,
        args: [clientId, sId, sinceDate, untilDate],
      });
      for (const s of security) {
        await turso.execute({
          sql: `INSERT INTO cloudflare_security_daily
                  (id, client_id, site_id, date,
                   total_events, block_events, challenge_events,
                   managed_challenge_events, js_challenge_events,
                   log_events, rate_limit_events)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            nanoid(), clientId, sId, s.date,
            s.total, s.block, s.challenge,
            s.managedChallenge, s.jsChallenge,
            s.log, s.rateLimit,
          ],
        });
      }

      // Mark the site as synced.
      await turso.execute({
        sql: `UPDATE client_sites SET cloudflare_last_synced_at = datetime('now') WHERE id = ?`,
        args: [sId],
      });

      results.push({
        site_id: sId,
        domain,
        traffic_days: traffic.length,
        security_days: security.length,
      });
    } catch (err: any) {
      logger.error(`CF sync failed for site ${sId}`, err);
      results.push({
        site_id: sId,
        domain,
        traffic_days: 0,
        security_days: 0,
        error: err?.detail || err?.message || 'Unknown error',
      });
    }
  }

  await logActivity({
    clientId,
    userId: locals.user!.id,
    action: 'synced',
    entityType: 'cloudflare',
    entityId: siteId || 'all',
    summary: `${locals.user!.name} synced Cloudflare data for ${results.length} site(s) over ${days} day(s)`,
  });

  return json({
    ok: true,
    window: { since: sinceDate, until: untilDate, days },
    results,
  });
};
