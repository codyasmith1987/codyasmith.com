// Admin endpoint: bulk delete csv_uploads rows that failed or
// produced zero data rows, plus any orphan child rows.
//
// POST { client_id? }
//
// If client_id is supplied, only that client's failed uploads are
// removed; otherwise all clients are swept. A "failed" upload is one
// where error IS NOT NULL OR row_count = 0.

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

  let body: any = {};
  try { body = await request.json(); }
  catch { /* allow empty body to mean "sweep all clients" */ }
  const clientId = body?.client_id ? String(body.client_id).trim() : null;

  const whereClause = clientId
    ? 'WHERE (error IS NOT NULL OR row_count = 0) AND client_id = ?'
    : 'WHERE error IS NOT NULL OR row_count = 0';
  const whereArgs: any[] = clientId ? [clientId] : [];

  // Collect the ids first so we can clean child rows by id (FK
  // referrers should be empty for failed uploads, but we sweep anyway
  // in case a partial write left rows behind).
  const ids: string[] = [];
  try {
    const rows = await turso.execute({
      sql: `SELECT id FROM csv_uploads ${whereClause}`,
      args: whereArgs,
    });
    for (const r of rows.rows as any[]) ids.push(String(r[0]));
  } catch (err) {
    logger.error('Failed to enumerate failed uploads', err);
    return json({ error: 'Failed to enumerate failed uploads' }, 500);
  }

  if (ids.length === 0) {
    return json({ ok: true, deleted: 0, child_rows_removed: 0 });
  }

  try {
    const CHILD_TABLES = await getCsvUploadChildTables();
    let totalChildDeletes = 0;
    // Chunked DELETE so the in-clause does not get too large.
    const CHUNK = 100;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      for (const table of CHILD_TABLES) {
        const del = await turso.execute({
          sql: `DELETE FROM ${table} WHERE csv_upload_id IN (${placeholders})`,
          args: chunk,
        });
        totalChildDeletes += del.rowsAffected || 0;
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
      entityId: 'bulk',
      summary: `${locals.user!.name} cleared ${ids.length} failed CSV upload(s) (${totalChildDeletes} child rows removed)`,
    });

    return json({ ok: true, deleted: ids.length, child_rows_removed: totalChildDeletes });
  } catch (err: any) {
    logger.error('Clear failed CSV uploads error', err);
    return json({ error: err?.message || 'Clear failed' }, 500);
  }
};
