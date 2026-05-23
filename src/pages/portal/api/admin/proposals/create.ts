// Admin endpoint: create a proposal row from the wizard at
// /portal/admin/proposals/new. Validates slug shape and uniqueness,
// validates the config payload at a structural level (not deep
// schema), inserts the row, and returns the new id + slug so the
// caller can redirect to the index page.
//
// The config blob is stored verbatim as JSON text. The generic
// renderer (Phase 2) is the consumer; this endpoint just enforces the
// outer shape that the proposals table expects.

import type { APIRoute } from 'astro';
import { nanoid } from 'nanoid';
import turso from '../../../../../lib/turso';
import { logActivity } from '../../../../../lib/activity';
import { logger } from '../../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const slug = (body?.slug || '').toString().trim();
  const client_id = (body?.client_id || '').toString().trim();
  const title = (body?.title || '').toString().trim();
  const config = body?.config;
  const status = (body?.status || 'draft').toString().trim();

  if (!slug) return json({ error: 'Slug is required' }, 400);
  if (!SLUG_RE.test(slug)) return json({ error: 'Slug must be lowercase letters, numbers, and hyphens (no leading or trailing hyphen)' }, 400);
  if (!client_id) return json({ error: 'Client is required' }, 400);
  if (!title) return json({ error: 'Title is required' }, 400);
  if (!config || typeof config !== 'object') return json({ error: 'Config is required' }, 400);
  if (status !== 'draft' && status !== 'published') return json({ error: 'Status must be draft or published' }, 400);

  // Confirm the client exists.
  const clientCheck = await turso.execute({
    sql: 'SELECT id FROM clients WHERE id = ?',
    args: [client_id],
  });
  if (clientCheck.rows.length === 0) return json({ error: 'Client not found' }, 404);

  // Slug uniqueness.
  const existing = await turso.execute({
    sql: 'SELECT id FROM proposals WHERE slug = ?',
    args: [slug],
  });
  if (existing.rows.length > 0) {
    return json({ error: 'A proposal with that slug already exists' }, 409);
  }

  const id = nanoid();
  const configText = JSON.stringify(config);

  try {
    await turso.execute({
      sql: `INSERT INTO proposals (id, slug, client_id, title, config, status, created_by, published_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ${status === 'published' ? "datetime('now')" : 'NULL'})`,
      args: [id, slug, client_id, title, configText, status, locals.user!.id],
    });
  } catch (err: any) {
    if (err?.message?.includes('UNIQUE constraint')) {
      return json({ error: 'A proposal with that slug already exists' }, 409);
    }
    logger.error('Create proposal error', err);
    return json({ error: 'Failed to create proposal' }, 500);
  }

  await logActivity({
    clientId: client_id,
    userId: locals.user!.id,
    action: 'created',
    entityType: 'proposal',
    entityId: id,
    summary: `${locals.user!.name} created proposal "${title}" (${status})`,
  });

  return json({ ok: true, id, slug }, 201);
};
