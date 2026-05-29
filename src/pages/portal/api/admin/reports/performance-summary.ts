// Admin trigger: generate a Performance Summary DRAFT PDF for one site.
//
// Reads the GA4 + GSC data already in the portal (via the shared read
// modules), assembles the descriptive markdown, renders a PDF, stores it,
// and returns an admin download URL. Admin-only at this slice; there is no
// client-facing surface yet (that is a later slice). The generated PDF is a
// DRAFT: it carries the data tables + deltas + factual sentences, and
// leaves Cody's thesis and interpretation as placeholders to fill in.
//
// GET /portal/api/admin/reports/performance-summary
//   ?client_id=<id>
//   [&period=<label>] [&next_period=<label>]
//   [&gsc_current_start=YYYY-MM-DD&gsc_current_end=YYYY-MM-DD]   (end is EXCLUSIVE)
//   [&gsc_prior_start=...&gsc_prior_end=...]                     (omit => baseline mode)
//   [&pre_start=...&pre_end=...]
//
// POST (not GET): it writes (stores a PDF), so it must inherit the CSRF +
// Origin gate the middleware applies to mutating methods. Re-running for the
// same client+month replaces the prior DRAFT rather than piling up copies.

import type { APIRoute } from 'astro';
import turso from '../../../../../lib/turso';
import { logger } from '../../../../../lib/logger';
import { uploadFile, deleteFileFromStorage } from '../../../../../lib/storage';
import {
  getGscLatestMonth, getGscChartAll, getGscTotals, getGscDimension, getGscFilters,
} from '../../../../../lib/gsc-read';
import {
  getGa4LatestMonth, getGa4PriorMonth, getGa4MonthData,
} from '../../../../../lib/ga4-read';
import { datesAreIso } from '../../../../../lib/reports/windows';
import { buildPerformanceSummaryMarkdown } from '../../../../../lib/reports/performance-summary';
import type { ReportWindows } from '../../../../../lib/reports/performance-summary';
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
function addDayIso(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

export const POST: APIRoute = async ({ locals, url }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  const clientId = url.searchParams.get('client_id');
  if (!clientId) return json({ error: 'client_id is required' }, 400);

  // Site name + slug.
  const clientRes = await turso.execute({ sql: 'SELECT slug, name FROM clients WHERE id = ?', args: [clientId] });
  if (clientRes.rows.length === 0) return json({ error: 'Client not found' }, 404);
  const slug = clientRes.rows[0][0] as string;
  const siteName = (clientRes.rows[0][1] as string) || slug;

  // Resolve cycle months.
  const ga4Month = await getGa4LatestMonth(clientId);
  const gscMonth = await getGscLatestMonth(clientId);
  if (!ga4Month && !gscMonth) {
    return json({ error: 'No GA4 or GSC data has been ingested for this client yet.' }, 422);
  }
  const cycleMonth = gscMonth || ga4Month!;
  const period = url.searchParams.get('period') || monthLabel(cycleMonth);
  const nextPeriod = url.searchParams.get('next_period') || 'next month';

  // Read GA4 (current + prior month for deltas).
  const ga4Current = ga4Month ? await getGa4MonthData(clientId, ga4Month) : null;
  const ga4PriorMonth = ga4Month ? await getGa4PriorMonth(clientId, ga4Month) : null;
  const ga4Prior = ga4PriorMonth ? await getGa4MonthData(clientId, ga4PriorMonth) : null;

  // Read GSC.
  const gscChart = await getGscChartAll(clientId);
  if (gscChart.length > 0 && !datesAreIso(gscChart)) {
    return json({ error: 'GSC chart dates are not ISO (YYYY-MM-DD); the search arc cannot be sliced. Re-check the export.' }, 422);
  }
  const gscTotals = gscMonth ? await getGscTotals(clientId, gscMonth) : null;
  const gscQueries = gscMonth ? await getGscDimension(clientId, gscMonth, 'query', 15) : [];
  const gscPages = gscMonth ? await getGscDimension(clientId, gscMonth, 'page', 10) : [];
  const gscFilters = gscMonth ? await getGscFilters(clientId, gscMonth) : [];

  // Window config. Current GSC window defaults to the full ingested range;
  // prior + pre-engagement are explicit (they do not align with the upload
  // month). End dates are EXCLUSIVE.
  const curStart = url.searchParams.get('gsc_current_start') || gscTotals?.first_date || '';
  const curEndRaw = url.searchParams.get('gsc_current_end');
  const curEnd = curEndRaw || (gscTotals?.last_date ? addDayIso(gscTotals.last_date) : '');
  const windows: ReportWindows = {
    gscCurrent: { label: period, start: curStart, endExclusive: curEnd },
  };
  const priorStart = url.searchParams.get('gsc_prior_start');
  const priorEnd = url.searchParams.get('gsc_prior_end');
  if (priorStart && priorEnd) windows.gscPrior = { label: 'Prior period', start: priorStart, endExclusive: priorEnd };
  const preStart = url.searchParams.get('pre_start');
  const preEnd = url.searchParams.get('pre_end');
  if (preStart && preEnd) windows.gscPreEngagement = { label: 'Pre-engagement', start: preStart, endExclusive: preEnd };

  // Assemble (pure).
  const markdown = buildPerformanceSummaryMarkdown({
    siteName, periodLabel: period, nextPeriodLabel: nextPeriod, month: cycleMonth,
    ga4Current, ga4Prior, gscChart, gscTotals, gscQueries, gscPages, gscFilters, windows,
  });

  // Render PDF (try/catch isolated from storage, per the sign.ts pattern).
  let buffer: Buffer;
  try {
    buffer = await generateReportPdf({
      title: `Performance Summary, ${siteName}`,
      subtitle: `${period} (Web Management)`,
      draft: true,
      bodyMarkdown: markdown,
    });
  } catch (err: any) {
    logger.error('Performance summary PDF render failed', err);
    return json({ error: 'PDF render failed', detail: err?.message }, 500);
  }

  // Store.
  try {
    const storageMonth = cycleMonth;
    const filename = `${slug}-performance-summary-${cycleMonth}-DRAFT.pdf`;
    // Idempotency: drop any prior DRAFT of this same report (client + logical
    // name + report category) so re-running replaces it instead of piling up
    // duplicate rows and orphaned storage objects.
    try {
      const prior = await turso.execute({
        sql: `SELECT id, s3_key FROM files WHERE client_id = ? AND original_name = ? AND category = 'report'`,
        args: [clientId, filename],
      });
      for (const pf of prior.rows) {
        await deleteFileFromStorage(pf[1] as string, pf[0] as string);
      }
    } catch (cleanupErr: any) {
      logger.error('prior report cleanup failed (continuing to store new copy)', cleanupErr);
    }
    const { id } = await uploadFile(slug, storageMonth, filename, buffer, 'application/pdf', clientId, locals.user!.id, 'report');
    return json({
      ok: true,
      file_id: id,
      download_url: `/portal/api/files/download?id=${id}`,
      mode: ga4Prior || windows.gscPrior ? 'trend' : 'baseline',
      ga4_month: ga4Month,
      ga4_prior_month: ga4PriorMonth,
      gsc_month: gscMonth,
    });
  } catch (err: any) {
    logger.error('Performance summary storage failed', err);
    return json({ error: 'PDF generated but storage failed', detail: err?.message }, 500);
  }
};
