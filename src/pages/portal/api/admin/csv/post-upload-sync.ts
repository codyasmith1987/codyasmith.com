// Post-upload client_sites sync — run ONCE after a CSV upload session.
//
// Why this exists: the upload route used to run syncDetectedDomains +
// syncPerSitePageCounts on EVERY batch POST. Both scan the client's entire
// crawl_urls set; as a client's data grows (e.g. ZipKit = ZKH + MVP) those
// queries get heavier, and running them ~13x for a 128-file upload (once per
// batch) added enough per-batch overhead to push batches past Cloudflare's
// ~100s edge window -> 504/524. The result is identical whether the sync runs
// per batch or once at the end, so the client now calls this endpoint ONCE
// after the whole upload loop completes instead.
//
// POST { client_id }  admin-only.

import type { APIRoute } from 'astro';
import { syncDetectedDomains, syncPerSitePageCounts } from '../../../../../lib/client-sites';
import { logger } from '../../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  let body: any;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }
  const clientId = (body?.client_id || '').toString().trim();
  if (!clientId) return json({ error: 'client_id is required' }, 400);

  try {
    const t0 = Date.now();
    const inserted = await syncDetectedDomains(clientId);
    const pageCountsUpdated = await syncPerSitePageCounts(clientId);
    logger.info(`[post-upload-sync] client ${clientId}: ${inserted} site(s) added, ${pageCountsUpdated} page-count(s) updated in ${Date.now() - t0}ms`);
    return json({ ok: true, sites_added: inserted, page_counts_updated: pageCountsUpdated });
  } catch (err: any) {
    logger.error('post-upload-sync failed', err);
    return json({ error: err?.message || 'sync failed' }, 500);
  }
};
