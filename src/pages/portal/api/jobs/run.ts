// Phase 1 Step 5 — external trigger for the scheduled jobs runner.
//
// Hit this from an external cron or uptime monitor (e.g. cron-job.org,
// UptimeRobot, Cloudflare cron) once per hour. The request must carry
// `x-jobs-secret: <JOBS_RUNNER_SECRET>`. Without the header or with the
// wrong value, returns 401.
//
// Never called by browser users. Admin-triggered "run billing now"
// flows should continue to use /portal/api/admin/billing/generate.
//
// Runs at most 10 due jobs per invocation to bound runtime. The runner
// itself is idempotent under concurrent invocations via optimistic
// leasing.

import type { APIRoute } from 'astro';
import { runDueJobs } from '../../../../lib/jobs/runner';
import { logger } from '../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

function getConfiguredSecret(): string | null {
  const viteEnv = (import.meta as any).env as Record<string, string | undefined> | undefined;
  const source = viteEnv ?? process.env;
  const s = (source.JOBS_RUNNER_SECRET || '').trim();
  return s || null;
}

export const POST: APIRoute = async ({ request }) => {
  const configured = getConfiguredSecret();
  if (!configured) {
    return json({ error: 'JOBS_RUNNER_SECRET is not configured' }, 503);
  }
  const provided = request.headers.get('x-jobs-secret') ?? '';
  if (provided !== configured) {
    return json({ error: 'Unauthorized' }, 401);
  }

  try {
    const result = await runDueJobs(10);
    return json({
      ok: true,
      ran: result.ranJobIds,
      failed: result.failedJobIds,
      no_work: result.noWork,
    });
  } catch (err: any) {
    logger.error('[jobs/run] error', err);
    return json({ error: err?.message ?? 'runner error' }, 500);
  }
};
