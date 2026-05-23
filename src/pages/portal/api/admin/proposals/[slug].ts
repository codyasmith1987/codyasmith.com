// Admin endpoint for managing a single proposal by slug. Phase 3 of the
// proposal-builder refactor only needs DELETE; later phases (an Edit
// flow, status transitions) will add PUT/PATCH on the same route.
//
// proposals -> proposal_drafts is NOT a cascade in the Phase 1 schema,
// so DELETE removes both the proposal row and any matching draft row
// in one batch.

import type { APIRoute } from 'astro';
import turso from '../../../../../lib/turso';
import { logActivity } from '../../../../../lib/activity';
import { logger } from '../../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const DELETE: APIRoute = async ({ locals, params }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  const slug = params.slug;
  if (!slug) return json({ error: 'slug is required' }, 400);

  try {
    // Look up the proposal first so we can log a useful summary and
    // grab the client_id for the matching proposal_drafts delete.
    const existing = await turso.execute({
      sql: 'SELECT id, client_id, title FROM proposals WHERE slug = ?',
      args: [slug],
    });
    if (existing.rows.length === 0) return json({ error: 'Proposal not found' }, 404);

    const proposalId = existing.rows[0][0] as string;
    const clientId = existing.rows[0][1] as string;
    const title = existing.rows[0][2] as string;

    // Atomic delete of both the proposal row and its draft row.
    await turso.batch([
      { sql: 'DELETE FROM proposal_drafts WHERE client_id = ? AND slug = ?', args: [clientId, slug] },
      { sql: 'DELETE FROM proposals WHERE id = ?', args: [proposalId] },
    ], 'write');

    await logActivity({
      clientId,
      userId: locals.user!.id,
      action: 'deleted',
      entityType: 'proposal',
      entityId: slug,
      summary: `${locals.user!.name} deleted proposal "${title}"`,
    });

    return json({ ok: true });
  } catch (err: any) {
    logger.error('Delete proposal error', err);
    return json({ error: 'Failed to delete proposal' }, 500);
  }
};
