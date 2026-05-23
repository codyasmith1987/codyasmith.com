// Admin endpoint: set or update a client's primary domain.
//
// POST { client_id, domain }
//
// Used by the proposal wizard when the client picked doesn't yet have
// a domain on file. The research endpoint needs one to scope Serper
// queries; this is the canonical write path. Validates the shape
// (no protocol, host.tld), normalizes to lowercase, persists.

import type { APIRoute } from 'astro';
import { updateClientDomain } from '../../../../../lib/auth';
import { logger } from '../../../../../lib/logger';
import { logActivity } from '../../../../../lib/activity';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  let body: any;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const clientId = (body?.client_id || '').toString().trim();
  const rawDomain = (body?.domain || '').toString().trim();
  if (!clientId) return json({ error: 'client_id is required' }, 400);

  if (rawDomain === '') {
    // Empty domain clears the field; allowed.
    try {
      await updateClientDomain(clientId, null);
      return json({ ok: true, domain: null });
    } catch (err) {
      logger.error('Clear client domain failed', err);
      return json({ error: 'Failed to update domain' }, 500);
    }
  }

  const d = rawDomain.toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) {
    return json({ error: 'Domain must look like example.com (no protocol, no path)' }, 400);
  }

  try {
    await updateClientDomain(clientId, d);
    await logActivity({
      clientId,
      userId: locals.user!.id,
      action: 'updated',
      entityType: 'client',
      entityId: clientId,
      summary: `${locals.user!.name} set client domain to ${d}`,
    });
    return json({ ok: true, domain: d });
  } catch (err) {
    logger.error('Set client domain failed', err);
    return json({ error: 'Failed to update domain' }, 500);
  }
};
