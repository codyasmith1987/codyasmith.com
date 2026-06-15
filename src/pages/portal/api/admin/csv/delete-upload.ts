// Admin endpoint: delete a single csv_uploads row and any child rows
// across the data tables that reference it.
//
// POST { upload_id }
//
// Tables walked: every table in CSV_CHILD_TABLES (the canonical child
// list). Child deletes run before the parent so foreign-key constraints
// stay clean, and each table delete is individually guarded so one
// missing table on a stale schema can't 500 the whole delete (mirrors
// the resilience in clear-superseded.ts).

import type { APIRoute } from 'astro';
import turso from '../../../../../lib/turso';
import { logger } from '../../../../../lib/logger';
import { logActivity } from '../../../../../lib/activity';
import { CSV_CHILD_TABLES as CHILD_TABLES } from '../../../../../lib/csv-child-tables';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  let body: any;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const uploadId = (body?.upload_id || '').toString().trim();
  if (!uploadId) return json({ error: 'upload_id is required' }, 400);

  // Look up the row for logging context before deleting it.
  const row = await turso.execute({
    sql: 'SELECT id, client_id, original_name FROM csv_uploads WHERE id = ? LIMIT 1',
    args: [uploadId],
  });
  if (row.rows.length === 0) return json({ error: 'Upload not found' }, 404);
  const r = row.rows[0] as any;
  const clientId = String(r[1] || '');
  const originalName = String(r[2] || '');

  try {
    let totalChildDeletes = 0;
    for (const table of CHILD_TABLES) {
      try {
        const del = await turso.execute({
          sql: `DELETE FROM ${table} WHERE csv_upload_id = ?`,
          args: [uploadId],
        });
        totalChildDeletes += del.rowsAffected || 0;
      } catch (err: any) {
        const msg: string = err?.message || '';
        // A missing table/column is expected on a stale schema — skip it so
        // one absent child table can't 500 the whole delete. Anything else
        // is a real failure: surface it (outer catch -> 500) rather than
        // silently orphaning child rows and deleting the parent anyway.
        if (msg.includes('no such table') || msg.includes('no such column')) continue;
        logger.error(`Child delete failed for table ${table} on upload ${uploadId}`, err);
        throw err;
      }
    }
    await turso.execute({
      sql: 'DELETE FROM csv_uploads WHERE id = ?',
      args: [uploadId],
    });

    await logActivity({
      clientId,
      userId: locals.user!.id,
      action: 'deleted',
      entityType: 'csv_upload',
      entityId: uploadId,
      summary: `${locals.user!.name} deleted CSV upload "${originalName}" (${totalChildDeletes} child rows removed)`,
    });

    return json({ ok: true, deleted_id: uploadId, child_rows_removed: totalChildDeletes });
  } catch (err: any) {
    logger.error('Delete CSV upload failed', err);
    return json({ error: err?.message || 'Delete failed' }, 500);
  }
};
