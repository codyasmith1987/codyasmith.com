// Admin-triggered "Run billing now": the SAME daily billing cycle the machine
// cron runs (mark overdue, generate + auto-email recurring invoices, send due
// reminders, send overdue notices), but gated by the admin session instead of
// the machine ADMIN_API_TOKEN. Lets an admin run and observe the automatic
// pipeline on demand without the server token. POST ?dry=1 for a read-only
// preview (writes nothing, sends nothing).

import type { APIRoute } from 'astro';
import { previewDailyCron } from '../../../../../lib/billing';
import { runDailyBilling } from '../../../../../lib/billing-cron';
import { logActivity } from '../../../../../lib/activity';
import { logger } from '../../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    if (new URL(request.url).searchParams.get('dry') === '1') {
      const preview = await previewDailyCron();
      return json({ ok: true, dry_run: true, ran_at: new Date().toISOString(), preview });
    }

    const result = await runDailyBilling();

    await logActivity({
      userId: locals.user!.id,
      action: 'ran',
      entityType: 'billing',
      entityId: 'daily',
      summary: `${locals.user!.name} ran the daily billing cycle on demand`,
    });

    return json(result);
  } catch (err) {
    logger.error('Admin run-daily billing error', err);
    return json({ error: 'Failed to run billing' }, 500);
  }
};
