// Admin endpoint: bulk delete csv_uploads rows that were marked as
// superseded by the format-level sweep in ingestCSV. The sweep sets
// `error = 'Superseded by newer upload'` on the older upload after
// deleting its child rows. The csv_uploads row sticks around as an
// audit trail; this endpoint removes the audit row too once you're
// confident the newer upload is the right one.
//
// Distinct from clear-failed, which catches any error or zero-row
// upload (broader). This endpoint targets only the supersede marker
// so genuine parser failures are not lumped together.
//
// POST { client_id? }
// If client_id is supplied, only that client's superseded uploads
// are removed; otherwise sweeps all clients.

import type { APIRoute } from 'astro';
import turso from '../../../../../lib/turso';
import { logger } from '../../../../../lib/logger';
import { logActivity } from '../../../../../lib/activity';
import { getCsvUploadChildTables } from '../../../../../lib/csv-child-tables';

export const prerender = false;

const SUPERSEDED_MARKER = 'Superseded by newer upload';

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  let body: any = {};
  try { body = await request.json(); }
  catch { /* allow empty body to mean "sweep all clients" */ }
  const clientId = body?.client_id ? String(body.client_id).trim() : null;

  const whereClause = clientId
    ? 'WHERE error = ? AND client_id = ?'
    : 'WHERE error = ?';
  const whereArgs: any[] = clientId
    ? [SUPERSEDED_MARKER, clientId]
    : [SUPERSEDED_MARKER];

  const ids: string[] = [];
  try {
    const rows = await turso.execute({
      sql: `SELECT id FROM csv_uploads ${whereClause}`,
      args: whereArgs,
    });
    for (const r of rows.rows as any[]) ids.push(String(r[0]));
  } catch (err) {
    logger.error('Failed to enumerate superseded uploads', err);
    return json({ error: 'Failed to enumerate superseded uploads' }, 500);
  }

  if (ids.length === 0) {
    return json({ ok: true, deleted: 0, child_rows_removed: 0 });
  }

  try {
    const CHILD_TABLES = await getCsvUploadChildTables();
    let totalChildDeletes = 0;
    // Chunked IN-clause to stay well under SQLite's parameter limit.
    const CHUNK = 100;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      // Child rows for superseded uploads should already be empty
      // (the sweep deletes them at supersede time), but we still
      // wipe by csv_upload_id in case a partial write left orphans.
      for (const table of CHILD_TABLES) {
        try {
          const del = await turso.execute({
            sql: `DELETE FROM ${table} WHERE csv_upload_id IN (${placeholders})`,
            args: chunk,
          });
          totalChildDeletes += Number(del.rowsAffected) || 0;
        } catch {
          // Table might not exist if a migration hasn't run yet on
          // this branch; skip.
        }
      }
      await turso.execute({
        sql: `DELETE FROM csv_uploads WHERE id IN (${placeholders})`,
        args: chunk,
      });
    }

    await logActivity({
      clientId: clientId || 'all',
      userId: locals.user!.id,
      action: 'deleted',
      entityType: 'csv_upload',
      entityId: 'bulk_superseded',
      summary: `${locals.user!.name} cleared ${ids.length} superseded CSV upload(s) (${totalChildDeletes} orphan rows removed)`,
    });

    return json({ ok: true, deleted: ids.length, child_rows_removed: totalChildDeletes });
  } catch (err: any) {
    logger.error('Clear superseded CSV uploads error', err);
    return json({ error: err?.message || 'Clear superseded failed' }, 500);
  }
};
