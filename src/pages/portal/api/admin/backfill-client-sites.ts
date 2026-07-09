// One-shot admin endpoint: re-runs the post-upload auto-bind logic
// against every client. Use case: PR #175 added the auto-bind to
// the upload endpoint going forward, but existing clients with
// historical CSVs need the backfill applied once for already-
// uploaded data to populate client_sites + page_count.
//
// Idempotent. syncDetectedDomains only inserts missing rows;
// syncPerSitePageCounts only fills NULL page_count values. Safe to
// hit multiple times.
//
// GET: returns per-client summary as JSON.

import type { APIRoute } from 'astro';
import turso from '../../../../lib/turso';
import { syncDetectedDomains, syncPerSitePageCounts } from '../../../../lib/client-sites';
import { logger } from '../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const clientsRes = await turso.execute('SELECT id, name, domain FROM clients ORDER BY name');
    const results: Array<{
      client: string;
      sites_inserted: number;
      page_counts_filled: number;
      domain_before: string | null;
      domain_after: string | null;
    }> = [];

    let totalSites = 0;
    let totalCounts = 0;

    for (const row of clientsRes.rows as any[]) {
      const id = row[0] as string;
      const name = row[1] as string;
      const domainBefore = (row[2] as string | null) ?? null;

      // Per-client try/catch: one bad client must NOT kill the
      // whole batch. Without this, an exception on (say) client #3
      // bails the outer handler with 500 and discards results from
      // clients #1 and #2. The admin sees nothing and has no idea
      // which client failed.
      try {
        const inserted = await syncDetectedDomains(id);
        const updated = await syncPerSitePageCounts(id);
        totalSites += inserted;
        totalCounts += updated;

        const afterRes = await turso.execute({
          sql: 'SELECT domain FROM clients WHERE id = ?',
          args: [id],
        });
        const domainAfter = ((afterRes.rows[0]?.[0] as string | null) ?? null);

        results.push({
          client: name,
          sites_inserted: inserted,
          page_counts_filled: updated,
          domain_before: domainBefore,
          domain_after: domainAfter,
        });
      } catch (perClientErr: any) {
        logger.error(`backfill-client-sites failed for client ${name}`, perClientErr);
        results.push({
          client: name,
          sites_inserted: 0,
          page_counts_filled: 0,
          domain_before: domainBefore,
          domain_after: domainBefore,
          error: perClientErr?.message || 'failed',
        } as any);
      }
    }

    return json({
      ok: true,
      total_clients: clientsRes.rows.length,
      total_sites_inserted: totalSites,
      total_page_counts_filled: totalCounts,
      results,
    });
  } catch (err: any) {
    logger.error('backfill-client-sites failed', err);
    return json({ error: err?.message || 'Backfill failed' }, 500);
  }
};
