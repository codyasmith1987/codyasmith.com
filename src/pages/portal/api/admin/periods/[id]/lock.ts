// Slice 16 — POST /portal/api/admin/periods/[id]/lock
//
// Freezes a period so snapshot-replace ingestion of that (client,
// period_start, source) triple is blocked until an admin explicitly
// unlocks. Admin-only (middleware enforces role) and CSRF-protected
// (middleware enforces on /portal/api/*). 409 if the period is
// already locked.

import type { APIRoute } from 'astro';
import { lockPeriod, getPeriodById, PeriodLockConflictError } from '../../../../../../lib/periods';
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

    let result: { locked_at: string };
    try {
      result = await lockPeriod(id);
    } catch (err) {
      if (err instanceof PeriodLockConflictError) {
        return json({ error: err.message }, 409);
      }
      throw err;
    }

    await logActivity({
      clientId: period.client_id,
      userId: locals.user!.id,
      action: 'locked',
      entityType: 'period',
      entityId: id,
      summary: `${locals.user!.name} locked period ${period.period_start} → ${period.period_end} (locked_at=${result.locked_at})`,
    });

    return json({ ok: true, id, locked_at: result.locked_at });
  } catch (err: any) {
    logger.error('lock period error', err);
    return json({ error: err?.message ?? 'failed' }, 500);
  }
};
