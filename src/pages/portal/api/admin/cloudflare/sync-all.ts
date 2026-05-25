// Admin endpoint: sync Cloudflare data for every site that has both
// a cloudflare_zone_id and an available token (per-site or account-
// level). Loops sites across all clients. Designed to be callable
// from a daily external cron (cron-job.org, DO scheduled function,
// GitHub Actions) so historical data accumulates without manual
// clicks. Manual UI button on /portal/admin/clients also POSTs here.
//
// POST { days? }
//   - days: optional, default 30, capped at 90
//
// Response:
//   {
//     ok: true,
//     window: { since, until, days },
//     synced: number, failed: number,
//     results: [{ client_id, site_id, domain, traffic_days, security_days, error? }]
//   }

import type { APIRoute } from 'astro';
import { nanoid } from 'nanoid';
import turso from '../../../../../lib/turso';
import { logger } from '../../../../../lib/logger';
import { logActivity } from '../../../../../lib/activity';
import { fetchTrafficDaily, fetchSecurityDaily } from '../../../../../lib/cloudflare';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  let body: any = {};
  try { body = await request.json(); } catch { /* empty body ok */ }
  const days = Math.min(90, Math.max(1, Number(body?.days) || 30));

  const accountCfgRes = await turso.execute({
    sql: `SELECT api_token FROM cloudflare_account_config WHERE id = 'default'`,
  });
  const accountToken: string | null = accountCfgRes.rows.length > 0
    ? String((accountCfgRes.rows[0] as any)[0])
    : null;

  const sitesRes = await turso.execute({
    sql: `SELECT cs.id, cs.client_id, cs.domain, cs.cloudflare_zone_id, cs.cloudflare_api_token, c.name
          FROM client_sites cs
          JOIN clients c ON c.id = cs.client_id
          WHERE cs.cloudflare_zone_id IS NOT NULL
            AND c.active = 1`,
  });
  if (sitesRes.rows.length === 0) {
    return json({ ok: true, synced: 0, failed: 0, results: [], message: 'No sites with cloudflare_zone_id set.' });
  }

  // Compute window (yesterday-back) once. Same convention as the
  // single-site sync endpoint.
  const today = new Date();
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const since = new Date(yesterday.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  const untilDate = yesterday.toISOString().slice(0, 10);
  const sinceDate = since.toISOString().slice(0, 10);
  const untilISO = yesterday.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/T.*$/, 'T23:59:59Z');
  const sinceISO = since.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/T.*$/, 'T00:00:00Z');

  const results: any[] = [];
  let synced = 0;
  let failed = 0;

  for (const row of sitesRes.rows) {
    const siteId = row[0] as string;
    const clientId = row[1] as string;
    const domain = row[2] as string;
    const zoneId = row[3] as string;
    const perSiteToken = row[4] ? String(row[4]) : null;
    const clientName = row[5] as string;
    const token = perSiteToken || accountToken;
    if (!token) {
      results.push({
        client_id: clientId,
        client_name: clientName,
        site_id: siteId,
        domain,
        traffic_days: 0,
        security_days: 0,
        error: 'No token available (no per-site token and no account token)',
      });
      failed++;
      continue;
    }

    try {
      const traffic = await fetchTrafficDaily(token, zoneId, sinceDate, untilDate);
      await turso.execute({
        sql: `DELETE FROM cloudflare_traffic_daily
              WHERE client_id = ? AND site_id = ?
                AND date >= ? AND date <= ?`,
        args: [clientId, siteId, sinceDate, untilDate],
      });
      for (const t of traffic) {
        await turso.execute({
          sql: `INSERT INTO cloudflare_traffic_daily
                  (id, client_id, site_id, date,
                   requests, cached_requests, bytes, cached_bytes,
                   threats, page_views)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            nanoid(), clientId, siteId, t.date,
            t.requests, t.cachedRequests, t.bytes, t.cachedBytes,
            t.threats, t.pageViews,
          ],
        });
      }

      const security = await fetchSecurityDaily(token, zoneId, sinceISO, untilISO);
      await turso.execute({
        sql: `DELETE FROM cloudflare_security_daily
              WHERE client_id = ? AND site_id = ?
                AND date >= ? AND date <= ?`,
        args: [clientId, siteId, sinceDate, untilDate],
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
            nanoid(), clientId, siteId, s.date,
            s.total, s.block, s.challenge,
            s.managedChallenge, s.jsChallenge,
            s.log, s.rateLimit,
          ],
        });
      }

      await turso.execute({
        sql: `UPDATE client_sites SET cloudflare_last_synced_at = datetime('now') WHERE id = ?`,
        args: [siteId],
      });

      results.push({
        client_id: clientId,
        client_name: clientName,
        site_id: siteId,
        domain,
        traffic_days: traffic.length,
        security_days: security.length,
      });
      synced++;
    } catch (err: any) {
      logger.error(`Sync-all failed for ${domain}`, err);
      results.push({
        client_id: clientId,
        client_name: clientName,
        site_id: siteId,
        domain,
        traffic_days: 0,
        security_days: 0,
        error: err?.detail || err?.message || 'Unknown error',
      });
      failed++;
    }
  }

  await logActivity({
    userId: locals.user!.id,
    action: 'synced_all',
    entityType: 'cloudflare',
    entityId: 'all',
    summary: `${locals.user!.name} ran sync-all: ${synced} succeeded, ${failed} failed across ${days} days`,
  });

  return json({
    ok: true,
    window: { since: sinceDate, until: untilDate, days },
    synced,
    failed,
    results,
  });
};
