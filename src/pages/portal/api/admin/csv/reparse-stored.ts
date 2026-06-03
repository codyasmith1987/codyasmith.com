// Admin endpoint: reparse one chunk of raw_csv_data through the CURRENT
// detector + ingest, moving files that were stored as unknown_stored
// (before a parser existed) into their typed tables. Non-destructive
// (raw rows are kept) and idempotent. Chunked so each request stays well
// under Cloudflare's 100s origin window — the admin UI loops it.
//
// POST { offset?, limit? }  (default limit 25)
// Returns the chunk summary plus a `total` count of raw_csv_data rows so
// the client knows when to stop paging.
//
// Mirrors clear-superseded.ts / clear-failed.ts for auth (admin role
// check; session + CSRF are enforced in middleware for all mutating
// requests) and response shape.

import type { APIRoute } from 'astro';
import turso from '../../../../../lib/turso';
import { logger } from '../../../../../lib/logger';
import { logActivity } from '../../../../../lib/activity';
import { reparseStoredChunk } from '../../../../../lib/csv/reparse-stored';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  let body: any = {};
  try { body = await request.json(); }
  catch { /* allow empty body -> defaults */ }

  const offset = Number.isFinite(Number(body?.offset)) ? Math.max(0, Math.floor(Number(body.offset))) : 0;
  const rawLimit = Number.isFinite(Number(body?.limit)) ? Math.floor(Number(body.limit)) : 25;
  const limit = Math.min(100, Math.max(1, rawLimit));

  try {
    // Total count so the looping client knows when it has covered every row.
    let total = 0;
    try {
      const countRes = await turso.execute('SELECT COUNT(*) AS n FROM raw_csv_data');
      total = Number((countRes.rows[0] as any).n) || 0;
    } catch {
      // raw_csv_data may not exist on a branch whose migration hasn't run.
      // Treat as nothing to do rather than 500.
      return json({ ok: true, total: 0, processed: 0, retyped: [], skippedUnknown: 0, errors: [] });
    }

    // uploaded_by is a NOT NULL FK to users(id); pass the real admin id so
    // the csv_uploads insert inside ingest does not fail the FK.
    const summary = await reparseStoredChunk(turso, { offset, limit, uploadedBy: locals.user!.id });

    // Log only when this chunk actually moved something, to avoid flooding the
    // activity log with empty-tail chunks during the loop.
    if (summary.retyped.length > 0) {
      await logActivity({
        clientId: 'all',
        userId: locals.user!.id,
        action: 'updated',
        entityType: 'csv_upload',
        entityId: 'reparse_stored',
        summary: `${locals.user!.name} reparsed ${summary.retyped.length} stored file(s) into typed tables (offset ${offset})`,
      });
    }

    return json({ ok: true, total, ...summary });
  } catch (err: any) {
    logger.error('Reparse stored CSV error', err);
    return json({ error: err?.message || 'Reparse stored failed' }, 500);
  }
};
