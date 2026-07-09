// Admin endpoint: delete a single csv_uploads row and every child row
// across the data tables that reference it.
//
// POST { upload_id }
//
// Child tables are DISCOVERED dynamically (every existing table with a
// csv_upload_id column) so the sweep can never miss one — a hardcoded list
// had drifted (data_coverage + the parse-everything tables), and the missed
// rows made the parent delete fail its foreign key. The children + parent
// run in ONE atomic batch (children first, parent last) so the FK is
// satisfied at commit and the whole delete is a single fast round-trip
// instead of ~30 sequential ones.

import type { APIRoute } from 'astro';
import turso from '../../../../../lib/turso';
import { logger } from '../../../../../lib/logger';
import { logActivity } from '../../../../../lib/activity';
import { getCsvUploadChildTables } from '../../../../../lib/csv-child-tables';

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
    const childTables = await getCsvUploadChildTables();
    // Children first, parent last, in one transaction: the FK is satisfied at
    // commit and it's a single round-trip. Every table is discovered to exist
    // and carry csv_upload_id, so no statement can fail on a missing
    // table/column.
    const stmts = childTables.map(t => ({
      sql: `DELETE FROM ${t} WHERE csv_upload_id = ?`,
      args: [uploadId],
    }));
    stmts.push({ sql: 'DELETE FROM csv_uploads WHERE id = ?', args: [uploadId] });
    const batchRes = await turso.batch(stmts, 'write');
    // Sum child rows removed (all results except the final parent delete).
    const totalChildDeletes = batchRes
      .slice(0, -1)
      .reduce((sum, r) => sum + (Number((r as any).rowsAffected) || 0), 0);

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
