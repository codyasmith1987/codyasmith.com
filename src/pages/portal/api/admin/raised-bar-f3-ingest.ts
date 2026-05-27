// Admin-session wrapper for the bundled Raised Bar / F3 CSV ingest.
// The older /api/admin/bulk-ingest-f3-csvs endpoint requires an
// ADMIN_API_TOKEN, which made it easy to deploy the bundled files but
// never actually attach them to the Raised Bar prod client. This route
// uses the normal portal admin session so Cody can run chunks from the
// browser and immediately verify counts in schema-diagnostic.

import type { APIRoute } from 'astro';
import { ingestRaisedBarF3CsvChunk } from '../../../../lib/raised-bar-f3-ingest';
import { syncDetectedDomains, syncPerSitePageCounts } from '../../../../lib/client-sites';
import { logger } from '../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { 'Content-Type': 'application/json' } });

const run: APIRoute = async ({ locals, url }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
  const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit') || '100', 10) || 100));

  try {
    const { summary, results } = await ingestRaisedBarF3CsvChunk({ offset, limit });

    let sitesInserted = 0;
    let pageCountsFilled = 0;
    try {
      sitesInserted = await syncDetectedDomains(summary.client_id);
      pageCountsFilled = await syncPerSitePageCounts(summary.client_id);
    } catch (syncErr: any) {
      logger.error('Raised Bar F3 post-ingest client_sites sync failed', syncErr);
      return json({
        ok: true,
        warning: `CSV chunk ingested, but client_sites sync failed: ${syncErr?.message || 'unknown error'}`,
        summary,
        results,
        next_url: summary.next_offset == null
          ? null
          : `/portal/api/admin/raised-bar-f3-ingest?offset=${summary.next_offset}&limit=${summary.limit}`,
      });
    }

    return json({
      ok: true,
      summary,
      sites_inserted_after_chunk: sitesInserted,
      page_counts_filled_after_chunk: pageCountsFilled,
      next_url: summary.next_offset == null
        ? null
        : `/portal/api/admin/raised-bar-f3-ingest?offset=${summary.next_offset}&limit=${summary.limit}`,
      results,
    });
  } catch (err: any) {
    logger.error('Raised Bar F3 portal ingest failed', err);
    return json({ error: err?.message || String(err) }, 500);
  }
};

export const GET: APIRoute = run;
export const POST: APIRoute = run;
