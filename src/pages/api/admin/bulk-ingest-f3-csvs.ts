// Bulk-ingest the bundled F3 Properties Screaming Frog crawl into the
// Raised Bar Group portal. Token-authenticated so the work can be
// triggered programmatically from a deploy or a local Bash session
// without needing a portal session cookie.
//
// One-time use for the Raised Bar engagement seed. The 625 CSV files
// are bundled into the build via import.meta.glob (`raw` + `eager`),
// adding ~1.9MB to the server bundle. After ingestion is verified the
// source files can be removed; the migration row stays applied and
// future rebuilds skip the work.
//
// Auth: X-Admin-Token header must match ADMIN_API_TOKEN env var. NOT
// a CSRF-protected endpoint because it is not session-driven; the
// token IS the credential. Lives under /api/ (not /portal/api/) so it
// bypasses the portal session middleware.

import type { APIRoute } from 'astro';
import { ingestCSV } from '../../../lib/csv/index';
import { getClientBySlug } from '../../../lib/auth';
import { logger } from '../../../lib/logger';
import turso from '../../../lib/turso';

export const prerender = false;

// Bundle every CSV into the build as raw strings. Keyed by relative path.
const CSV_BUNDLE = import.meta.glob('../../../data/raised-bar-f3-csvs/*.csv', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const CLIENT_SLUG = 'raised-bar-group';
const MONTH = '2026-05';

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ request, url }) => {
  // Token check
  const expected = import.meta.env.ADMIN_API_TOKEN || '';
  const provided = request.headers.get('X-Admin-Token') || '';
  if (!expected || expected.length < 16) {
    return json({ error: 'ADMIN_API_TOKEN is not configured on this server' }, 503);
  }
  if (provided.length !== expected.length) {
    return json({ error: 'Forbidden' }, 403);
  }
  // Constant-time compare
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  if (mismatch !== 0) return json({ error: 'Forbidden' }, 403);

  // Chunking params so the request finishes within the platform timeout
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
  const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit') || '40', 10) || 40));

  try {
    const client = await getClientBySlug(CLIENT_SLUG);
    if (!client) return json({ error: `Client '${CLIENT_SLUG}' not found; run migration 014 first` }, 500);

    // Find an admin user for uploaded_by
    const adminLookup = await turso.execute("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1");
    if (adminLookup.rows.length === 0) return json({ error: 'No admin user found' }, 500);
    const adminUserId = adminLookup.rows[0][0] as string;

    // Sorted file list so chunked offsets are stable across requests
    const allEntries = Object.entries(CSV_BUNDLE).sort(([a], [b]) => a.localeCompare(b));
    const total = allEntries.length;
    const chunk = allEntries.slice(offset, offset + limit);

    const results: Array<{
      file: string;
      format: string;
      rows: number;
      skipped?: boolean;
      error?: string;
    }> = [];

    for (const [path, raw] of chunk) {
      const fileName = path.split('/').pop()!;

      // Idempotency: skip if a successful (no-error) upload already exists
      // for this client + month + filename.
      const existing = await turso.execute({
        sql: 'SELECT id, error FROM csv_uploads WHERE client_id = ? AND month = ? AND original_name = ? AND (error IS NULL OR error = ?)',
        args: [client.id, MONTH, fileName, ''],
      });
      if (existing.rows.length > 0) {
        results.push({ file: fileName, format: 'cached', rows: 0, skipped: true });
        continue;
      }

      try {
        const result = await ingestCSV(raw, client.id, MONTH, fileName, adminUserId);
        results.push({
          file: fileName,
          format: result.format,
          rows: result.rowCount,
          error: result.error,
        });
      } catch (err: any) {
        results.push({ file: fileName, format: 'error', rows: 0, error: err?.message || String(err) });
      }
    }

    const summary = {
      total_files: total,
      offset,
      limit,
      processed: chunk.length,
      next_offset: offset + chunk.length < total ? offset + chunk.length : null,
      skipped: results.filter(r => r.skipped).length,
      succeeded: results.filter(r => !r.error && !r.skipped).length,
      failed: results.filter(r => !!r.error).length,
      by_format: results.reduce((acc, r) => {
        const key = r.skipped ? 'skipped' : (r.error ? `error:${r.format}` : r.format);
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
    };

    return json({ ok: true, summary, results });
  } catch (err: any) {
    logger.error('Bulk F3 CSV ingest error', err);
    return json({ error: err?.message || String(err) }, 500);
  }
};
