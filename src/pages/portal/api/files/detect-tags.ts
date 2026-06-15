// Server-side auto-tag probe for the batch document upload UI.
//
// The browser sends the picked client + the filenames; we run the single
// source-of-truth filename tagger (src/lib/files/auto-tag.ts) against that
// client's managed sites and return a best-guess {site_id, category, month}
// per file, PLUS the client's sites (so the UI can render the editable Site
// dropdown). No file content moves here — the actual upload still goes through
// /portal/api/files/upload. Keeping detection server-side means the tagger
// lives in exactly one place (no inline browser copy to drift).
//
// POST { client_id, filenames: string[] }  admin-only.

import type { APIRoute } from 'astro';
import { listManagedSites } from '../../../../lib/client-sites';
import { detectFileTags } from '../../../../lib/files/auto-tag';
import { logger } from '../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  let body: any;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const clientId = (body?.client_id || '').toString().trim();
  const filenames: string[] = Array.isArray(body?.filenames)
    ? body.filenames.map((f: any) => String(f)).slice(0, 200)
    : [];
  if (!clientId) return json({ error: 'client_id is required' }, 400);

  try {
    const sites = await listManagedSites(clientId);
    const tagInput = sites.map(s => ({
      id: s.id, domain: s.domain, label: s.label, aliases: s.aliases, is_primary: s.is_primary,
    }));
    const results = filenames.map(filename => {
      const t = detectFileTags(filename, tagInput);
      return {
        filename,
        site_id: t.siteId,
        site_domain: t.siteDomain,
        category: t.category,
        month: t.month,
      };
    });
    // Sites for the UI's per-file Site dropdown (only meaningful when 2+).
    return json({
      ok: true,
      sites: sites.map(s => ({ id: s.id, domain: s.domain, is_primary: !!s.is_primary })),
      results,
    });
  } catch (err: any) {
    logger.error('detect-tags failed', err);
    return json({ error: err?.message || 'detect-tags failed' }, 500);
  }
};
