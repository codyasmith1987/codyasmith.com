// Daily billing automation, provider-agnostic (machine trigger).
//
// Runs the recurring billing tasks that previously only fired when an admin
// happened to load a page: mark overdue invoices, generate + auto-email the
// upcoming recurring invoices, send due reminders, send overdue notices. Point
// any scheduler at this once a day (the n8n recurring-automation initiative is
// the intended home; a DO Function cron / GitHub Actions schedule / cron-job.org
// work equally). The exact same cycle is also runnable on demand by an admin via
// POST /portal/api/admin/billing/run-daily (both call runDailyBilling).
//
// Auth: POST with header X-Admin-Token matching ADMIN_API_TOKEN (machine auth,
// same pattern as the bulk-ingest endpoint). Safe to call more than once a day:
// each task is idempotent (period dedup, status guards, cadence guards).

import type { APIRoute } from 'astro';
import { previewDailyCron } from '../../../lib/billing';
import { runDailyBilling } from '../../../lib/billing-cron';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ request }) => {
  const expected = import.meta.env.ADMIN_API_TOKEN || '';
  const provided = request.headers.get('X-Admin-Token') || '';
  if (!expected || expected.length < 16) {
    return json({ error: 'ADMIN_API_TOKEN is not configured on this server' }, 503);
  }
  if (provided.length !== expected.length) return json({ error: 'Forbidden' }, 403);
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  if (mismatch !== 0) return json({ error: 'Forbidden' }, 403);

  // Read-only dry run (?dry=1): report exactly what each task would do, writing
  // nothing and sending no email. Lets the trigger be verified before it ever
  // generates or sends a real invoice (Production Safety SOP: verify without
  // writing to prod).
  if (new URL(request.url).searchParams.get('dry') === '1') {
    const preview = await previewDailyCron();
    return json({ ok: true, dry_run: true, ran_at: new Date().toISOString(), preview });
  }

  const result = await runDailyBilling();
  return json(result);
};
