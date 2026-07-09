// Admin endpoint: update a client's mutable fields (name, domain,
// discount_rate). Slug is intentionally NOT mutable here: slug
// changes propagate to URLs and proposal slugs and need a separate
// thought-through migration path.
//
// POST { client_id, name?, domain?, discount_rate? }
//
// discount_rate is a decimal: 0.10 = 10% off. Clamped to [0, 1] at
// the data layer.

import type { APIRoute } from 'astro';
import { updateClient, getClientById } from '../../../../../lib/auth';
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
  if (!clientId) return json({ error: 'client_id is required' }, 400);

  const before = await getClientById(clientId);
  if (!before) return json({ error: 'Client not found' }, 404);

  const updates: { name?: string; domain?: string | null; discount_rate?: number } = {};
  const changes: string[] = [];

  if (typeof body.name === 'string') {
    const name = body.name.trim();
    if (!name) return json({ error: 'Name cannot be empty' }, 400);
    if (name !== before.name) {
      updates.name = name;
      changes.push(`name "${before.name}" -> "${name}"`);
    }
  }

  if (body.domain !== undefined) {
    const raw = (body.domain ?? '').toString().trim();
    let domainClean: string | null = null;
    if (raw) {
      const d = raw.toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) {
        return json({ error: 'Domain must look like example.com (no protocol, no path)' }, 400);
      }
      domainClean = d;
    }
    if (domainClean !== before.domain) {
      updates.domain = domainClean;
      changes.push(`domain "${before.domain || '(none)'}" -> "${domainClean || '(none)'}"`);
    }
  }

  if (body.discount_rate !== undefined && body.discount_rate !== null && body.discount_rate !== '') {
    const raw = body.discount_rate;
    const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      return json({ error: 'discount_rate must be a number between 0 and 1 (e.g., 0.10 for 10%)' }, 400);
    }
    if (n !== before.discount_rate) {
      updates.discount_rate = n;
      changes.push(`discount_rate ${(before.discount_rate * 100).toFixed(1)}% -> ${(n * 100).toFixed(1)}%`);
    }
  }

  if (Object.keys(updates).length === 0) {
    return json({ ok: true, client_id: clientId, changes: [] });
  }

  try {
    await updateClient(clientId, updates);
  } catch (err: any) {
    logger.error('Update client failed', err);
    return json({ error: err?.message || 'Failed to update client' }, 500);
  }

  await logActivity({
    clientId,
    userId: locals.user!.id,
    action: 'updated',
    entityType: 'client',
    entityId: clientId,
    summary: `${locals.user!.name} updated client: ${changes.join(', ')}`,
  });

  return json({ ok: true, client_id: clientId, changes });
};
