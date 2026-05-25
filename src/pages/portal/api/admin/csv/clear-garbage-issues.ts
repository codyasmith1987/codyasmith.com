// Admin endpoint: delete site_issues rows whose issue_name looks
// like a filename leak. Caused by a regression in the site_audit
// fallback parser where the upload route was passing through
// folder-picker filenames with directory paths intact, and the
// detector heuristic was routing *_inlinks files (which have a
// link-relationship schema, not an issue schema) into site_audit.
//
// Both root causes are fixed in the same PR (upload.ts strips the
// directory prefix, detector excludes inlinks/outlinks/anchor_text
// from site_audit). This endpoint mops up the historical bad rows
// that already polluted the table.
//
// POST { client_id? }
// If client_id is supplied, only that client's bad rows are
// removed; otherwise sweeps all clients. Returns the count and a
// sample of issue_names that were removed so admin can sanity-check.

import type { APIRoute } from 'astro';
import turso from '../../../../../lib/turso';
import { logger } from '../../../../../lib/logger';
import { logActivity } from '../../../../../lib/activity';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// Patterns that indicate a leaked filename rather than a real issue
// label. Mirrors looksLikeFilenameLeak() in site-audit.ts so future
// stricter additions can be coordinated.
const GARBAGE_PATTERNS = [
  "issue_name LIKE '%/%'",         // path separator
  "issue_name LIKE '%\\%'",        // path separator (windows)
  "issue_name LIKE '%inlinks%'",   // link-relationship file leaked in
  "issue_name LIKE '%outlinks%'",  // ditto
  "issue_name LIKE '%anchor text%'", // all_anchor_text dump
  "LENGTH(issue_name) > 100",      // implausibly long for an issue label
  "issue_name GLOB '[0-9][0-9][0-9][0-9].[0-9][0-9].[0-9][0-9]*'", // SF timestamp folder
];

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  let body: any = {};
  try { body = await request.json(); }
  catch { /* allow empty body */ }
  const clientId = body?.client_id ? String(body.client_id).trim() : null;

  const garbageClause = GARBAGE_PATTERNS.map(p => `(${p})`).join(' OR ');
  const whereClause = clientId
    ? `WHERE (${garbageClause}) AND client_id = ?`
    : `WHERE ${garbageClause}`;
  const whereArgs: any[] = clientId ? [clientId] : [];

  // Preview the bad rows first so the activity log + response can
  // name what got removed.
  let sampleNames: string[] = [];
  let count = 0;
  try {
    const preview = await turso.execute({
      sql: `SELECT issue_name FROM site_issues ${whereClause} LIMIT 50`,
      args: whereArgs,
    });
    sampleNames = preview.rows.map(r => r[0] as string);
    const countRes = await turso.execute({
      sql: `SELECT COUNT(*) FROM site_issues ${whereClause}`,
      args: whereArgs,
    });
    count = Number(countRes.rows[0]?.[0]) || 0;
  } catch (err) {
    logger.error('Failed to preview garbage site_issues rows', err);
    return json({ error: 'Failed to preview garbage rows' }, 500);
  }

  if (count === 0) {
    return json({ ok: true, deleted: 0, sample: [] });
  }

  try {
    const del = await turso.execute({
      sql: `DELETE FROM site_issues ${whereClause}`,
      args: whereArgs,
    });
    const deleted = Number(del.rowsAffected) || 0;
    await logActivity({
      clientId: clientId || 'all',
      userId: locals.user!.id,
      action: 'deleted',
      entityType: 'site_issue',
      entityId: 'bulk_garbage',
      summary: `${locals.user!.name} removed ${deleted} site_issues row(s) with filename-leak issue names`,
    });
    return json({ ok: true, deleted, sample: sampleNames });
  } catch (err: any) {
    logger.error('Clear garbage site_issues error', err);
    return json({ error: err?.message || 'Cleanup failed' }, 500);
  }
};
