// Daily billing automation, provider-agnostic.
//
// Runs the recurring billing tasks that previously only fired when an
// admin happened to load a page: mark overdue invoices, generate the
// upcoming recurring invoices (issued ~7 days ahead per contract 5.3),
// and send due reminders. Point any scheduler at this once a day:
// the n8n recurring-automation initiative is the intended home, but it
// works equally with a DO Function cron, a GitHub Actions schedule, or
// cron-job.org as an interim trigger.
//
// Auth: POST with header X-Admin-Token matching ADMIN_API_TOKEN (the same
// machine-auth pattern as the bulk-ingest endpoint). Safe to call more
// than once a day: each task is idempotent (period dedup, status guards).

import type { APIRoute } from 'astro';
import turso from '../../../lib/turso';
import { logger } from '../../../lib/logger';
import { markOverdueInvoices, generateRecurringInvoices, sendDueReminders, previewDailyCron } from '../../../lib/billing';

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

  // Read-only dry run (?dry=1): report exactly what each task would do,
  // writing nothing and sending no email. Lets the trigger be verified
  // before it ever generates or sends a real invoice. Per the Production
  // Safety SOP: verify without writing to prod.
  if (new URL(request.url).searchParams.get('dry') === '1') {
    const preview = await previewDailyCron();
    return json({ ok: true, dry_run: true, ran_at: new Date().toISOString(), preview });
  }

  // generateRecurringInvoices stamps created_by, which is a FK to users.
  // Run invoice generation as the earliest admin (a system actor).
  const adminRow = await turso.execute("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1");
  const systemUserId = (adminRow.rows[0]?.[0] as string | undefined) || undefined;

  const result: Record<string, unknown> = { ok: true, ran_at: new Date().toISOString() };

  try {
    result.overdue_marked = await markOverdueInvoices();
  } catch (err: any) {
    logger.error('cron: markOverdueInvoices failed', err);
    result.overdue_error = err?.message || 'failed';
  }

  if (systemUserId) {
    try {
      const gen = await generateRecurringInvoices(systemUserId);
      result.invoices_generated = gen.generated.length;
      result.invoices_skipped = gen.skipped.length;
    } catch (err: any) {
      logger.error('cron: generateRecurringInvoices failed', err);
      result.invoices_error = err?.message || 'failed';
    }
  } else {
    result.invoices_skipped_reason = 'no admin user found for created_by';
  }

  try {
    result.reminders_sent = await sendDueReminders();
  } catch (err: any) {
    logger.error('cron: sendDueReminders failed', err);
    result.reminders_error = err?.message || 'failed';
  }

  logger.info(`cron/daily ran: ${JSON.stringify(result)}`);
  return json(result);
};
