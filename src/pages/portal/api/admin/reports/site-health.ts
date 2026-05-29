// Admin trigger: generate a Site Health Report DRAFT PDF for one site.
//
// Reads the Screaming Frog crawl rollup already in the portal, assembles the
// descriptive markdown, renders a PDF, stores it, and returns an admin
// download URL. Admin-only at this slice; no client-facing surface yet.
// The generated PDF is a DRAFT: descriptive findings + month-over-month
// deltas + a "Closed this month" list, with thesis, cause diagnoses, and the
// fix roadmap left to Cody (the roadmap lives in the Strategic Rec).
//
// POST (not GET): it writes, so it must inherit the CSRF + Origin gate.
// Re-running for the same client+month replaces the prior DRAFT.
//
// POST /portal/api/admin/reports/site-health?client_id=<id>[&period=<label>][&prior_month=YYYY-MM]

import type { APIRoute } from 'astro';
import turso from '../../../../../lib/turso';
import { logger } from '../../../../../lib/logger';
import { uploadFile, deleteFileFromStorage } from '../../../../../lib/storage';
import {
  getHealthLatestMonth, getHealthPriorMonth, getHealthMonthData,
  getNavigablePageCount, getResponseCodeCounts,
} from '../../../../../lib/crawl-read';
import { buildSiteHealthMarkdown } from '../../../../../lib/reports/site-health';
import { generateReportPdf } from '../../../../../lib/report-pdf';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function monthLabel(month: string | null): string {
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return month || 'this period';
  const [y, m] = month.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

export const POST: APIRoute = async ({ locals, url }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  const clientId = url.searchParams.get('client_id');
  if (!clientId) return json({ error: 'client_id is required' }, 400);

  const clientRes = await turso.execute({ sql: 'SELECT slug, name FROM clients WHERE id = ?', args: [clientId] });
  if (clientRes.rows.length === 0) return json({ error: 'Client not found' }, 404);
  const slug = clientRes.rows[0][0] as string;
  const siteName = (clientRes.rows[0][1] as string) || slug;

  const cycleMonth = await getHealthLatestMonth(clientId);
  if (!cycleMonth) return json({ error: 'No crawl / site-health data has been ingested for this client yet.' }, 422);
  const priorMonth = url.searchParams.get('prior_month') || await getHealthPriorMonth(clientId, cycleMonth);
  const period = url.searchParams.get('period') || monthLabel(cycleMonth);

  const current = await getHealthMonthData(clientId, cycleMonth);
  const prior = priorMonth ? await getHealthMonthData(clientId, priorMonth) : null;
  const navigablePages = await getNavigablePageCount(clientId, cycleMonth);
  const navigablePagesPrior = priorMonth ? await getNavigablePageCount(clientId, priorMonth) : null;

  // Response codes: derived from crawl_urls.status_code bands for each month.
  const curCodes = await getResponseCodeCounts(clientId, cycleMonth);
  const priorCodes = priorMonth ? await getResponseCodeCounts(clientId, priorMonth) : [];
  const priorByCode = new Map(priorCodes.map(r => [r.code, r.count]));
  const responseCodes = curCodes.map(r => ({
    code: r.code,
    current: r.count,
    prior: priorMonth ? (priorByCode.has(r.code) ? priorByCode.get(r.code)! : 0) : null,
  }));

  const markdown = buildSiteHealthMarkdown({
    siteName, periodLabel: period, current, prior, navigablePages, navigablePagesPrior, responseCodes,
  });

  let buffer: Buffer;
  try {
    buffer = await generateReportPdf({
      title: `Site Health Report, ${siteName}`,
      subtitle: `${period} (Web Management)`,
      draft: true,
      bodyMarkdown: markdown,
    });
  } catch (err: any) {
    logger.error('Site health PDF render failed', err);
    return json({ error: 'PDF render failed', detail: err?.message }, 500);
  }

  try {
    const filename = `${slug}-site-health-${cycleMonth}-DRAFT.pdf`;
    try {
      const priorFiles = await turso.execute({
        sql: `SELECT id, s3_key FROM files WHERE client_id = ? AND original_name = ? AND category = 'report'`,
        args: [clientId, filename],
      });
      for (const pf of priorFiles.rows) await deleteFileFromStorage(pf[1] as string, pf[0] as string);
    } catch (cleanupErr: any) {
      logger.error('prior site-health report cleanup failed (continuing)', cleanupErr);
    }
    const { id } = await uploadFile(slug, cycleMonth, filename, buffer, 'application/pdf', clientId, locals.user!.id, 'report');
    return json({
      ok: true,
      file_id: id,
      download_url: `/portal/api/files/download?id=${id}`,
      mode: prior ? 'trend' : 'baseline',
      health_month: cycleMonth,
      health_prior_month: priorMonth,
    });
  } catch (err: any) {
    logger.error('Site health storage failed', err);
    return json({ error: 'PDF generated but storage failed', detail: err?.message }, 500);
  }
};
