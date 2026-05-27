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
import { ingestRaisedBarF3CsvChunk } from '../../../lib/raised-bar-f3-ingest';
import { logger } from '../../../lib/logger';

export const prerender = false;

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
    const { summary, results } = await ingestRaisedBarF3CsvChunk({ offset, limit });
    return json({ ok: true, summary, results });
  } catch (err: any) {
    logger.error('Bulk F3 CSV ingest error', err);
    return json({ error: err?.message || String(err) }, 500);
  }
};
