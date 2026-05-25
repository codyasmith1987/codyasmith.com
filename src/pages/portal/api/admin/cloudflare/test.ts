// Admin endpoint: run a quick credential check against the
// Cloudflare GraphQL API for a configured site. Used by the
// settings UI to give immediate feedback after the admin pastes
// a zone + token.
//
// POST { site_id }
// Returns { ok: true } on success, { ok: false, error: "..." } on
// failure with a concrete diagnostic so the admin can fix the
// credential rather than guess.

import type { APIRoute } from 'astro';
import turso from '../../../../../lib/turso';
import { testCredentials } from '../../../../../lib/cloudflare';

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

  const row = await turso.execute({
    sql: 'SELECT cloudflare_zone_id, cloudflare_api_token FROM client_sites WHERE id = ?',
    args: [siteId],
  });
  if (row.rows.length === 0) return json({ ok: false, error: 'Site not found' });
  const zoneId = row.rows[0][0] as string | null;
  const apiToken = row.rows[0][1] as string | null;
  if (!zoneId || !apiToken) {
    return json({ ok: false, error: 'Zone ID or API token not configured for this site.' });
  }

  const result = await testCredentials(apiToken, zoneId);
  return json(result);
};
