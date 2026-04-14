// Slice 16 — POST /portal/api/admin/periods/[id]/unlock
//
// Unfreezes a locked period. Admin-only, CSRF-protected. 409 if the
// period is not currently locked (no-op guard — "unlock" on an
// already-unlocked period is a meaningful mistake, not a tolerable
// noop, so the caller gets a clear error).

import type { APIRoute } from 'astro';
import { unlockPeriod, getPeriodById, PeriodLockConflictError } from '../../../../../../lib/periods';
import { logActivity } from '../../../../../../lib/activity';
import { logger } from '../../../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ locals, params }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);
  const id = String(params.id ?? '');
  if (!id) return json({ error: 'id required' }, 400);

  try {
    const period = await getPeriodById(id);
    if (!period) return json({ error: 'period not found' }, 404);

    let result: { was_locked_at: string };
    try {
      result = await unlockPeriod(id);
    } catch (err) {
      if (err instanceof PeriodLockConflictError) {
        return json({ error: err.message }, 409);
      }
      throw err;
    }

    await logActivity({
      clientId: period.client_id,
      userId: locals.user!.id,
      action: 'unlocked',
      entityType: 'period',
      entityId: id,
      summary: `${locals.user!.name} unlocked period ${period.period_start} → ${period.period_end} (was locked at ${result.was_locked_at})`,
    });

    return json({ ok: true, id, was_locked_at: result.was_locked_at });
  } catch (err: any) {
    logger.error('unlock period error', err);
    return json({ error: err?.message ?? 'failed' }, 500);
  }
};
