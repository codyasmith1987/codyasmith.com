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
import { getCsvUploadChildTables } from '../../../../../lib/csv-child-tables';

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
    const childTables = await getCsvUploadChildTables();
    // This client's upload ids — every child table is guaranteed to have a
    // csv_upload_id column, so that is the reliable key to sweep on.
    const idsRes = await turso.execute({
      sql: 'SELECT id FROM csv_uploads WHERE client_id = ?',
      args: [clientId],
    });
    const ids = (idsRes.rows as any[]).map(r => String(r[0]));

    let totalChildDeletes = 0;
    const CHUNK = 100;
    for (const table of childTables) {
      // 1) Rows tied to this client's uploads (by csv_upload_id).
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        const placeholders = chunk.map(() => '?').join(',');
        const del = await turso.execute({
          sql: `DELETE FROM ${table} WHERE csv_upload_id IN (${placeholders})`,
          args: chunk,
        });
        totalChildDeletes += Number(del.rowsAffected) || 0;
      }
      // 2) Rows keyed directly to the client but not to an upload (e.g.
      //    backfilled coverage rows with csv_upload_id NULL, manually-entered
      //    metrics). Skipped for tables that have no client_id column.
      try {
        const del = await turso.execute({
          sql: `DELETE FROM ${table} WHERE client_id = ?`,
          args: [clientId],
        });
        totalChildDeletes += Number(del.rowsAffected) || 0;
      } catch (err: any) {
        if (!String(err?.message || '').includes('no such column')) throw err;
      }
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
