// Admin endpoint: wipe ALL csv_uploads for a single client plus every
// child row across the upload-derived tables. Distinct from
// clear-failed.ts, which only removes rows with error or zero
// row_count. This one is the "reset this client's data" hammer for
// re-test workflows.
//
// POST { client_id, confirm: 'WIPE' }
//
// The confirm token is intentionally specific so a misclick somewhere
// else cannot reach this. The client UI passes the exact string.

import type { APIRoute } from 'astro';
import turso from '../../../../../lib/turso';
import { logger } from '../../../../../lib/logger';
import { logActivity } from '../../../../../lib/activity';
import { CSV_CHILD_TABLES } from '../../../../../lib/csv-child-tables';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  let body: any;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const clientId = (body?.client_id || '').toString().trim();
  const confirm = (body?.confirm || '').toString();
  if (!clientId) return json({ error: 'client_id is required' }, 400);
  if (confirm !== 'WIPE') {
    return json({ error: 'Missing confirm token. UI must pass confirm:"WIPE".' }, 400);
  }

  try {
    // First: delete child rows directly by client_id. Some child tables
    // (metrics, site_issues, keyword_rankings) have client_id directly,
    // so we can drop everything for this client in one statement per
    // table without enumerating upload ids.
    let totalChildDeletes = 0;
    for (const table of CSV_CHILD_TABLES) {
      const del = await turso.execute({
        sql: `DELETE FROM ${table} WHERE client_id = ?`,
        args: [clientId],
      });
      totalChildDeletes += del.rowsAffected || 0;
    }

    // Then: delete the csv_uploads rows for this client.
    const uploadDel = await turso.execute({
      sql: 'DELETE FROM csv_uploads WHERE client_id = ?',
      args: [clientId],
    });
    const uploadsRemoved = uploadDel.rowsAffected || 0;

    await logActivity({
      clientId,
      userId: locals.user!.id,
      action: 'deleted',
      entityType: 'csv_upload',
      entityId: 'all',
      summary: `${locals.user!.name} wiped ${uploadsRemoved} upload(s) and ${totalChildDeletes} child row(s) for this client`,
    });

    return json({
      ok: true,
      uploads_removed: uploadsRemoved,
      child_rows_removed: totalChildDeletes,
    });
  } catch (err: any) {
    logger.error('Wipe all uploads for client failed', err);
    return json({ error: err?.message || 'Wipe failed' }, 500);
  }
};
