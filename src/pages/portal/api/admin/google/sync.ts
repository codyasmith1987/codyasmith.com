// POST /portal/api/admin/google/sync
//
// Runs a GSC sync for one binding synchronously and returns the
// result. The scheduled_jobs runner is not wired for GSC in this
// slice — manual sync gives Cody immediate feedback on row count,
// API errors, or lock rejections. Auto-scheduling lands in Slice 18b.
//
// body: { binding_id, month }  (month: YYYY-MM, e.g. '2026-04')

import type { APIRoute } from 'astro';
import { syncGscForBinding, syncGa4ForBinding } from '../../../../../lib/google/sync';
import { getBindingById } from '../../../../../lib/data-sources';
import { logger } from '../../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const body = await request.json();
    const bindingId = String(body.binding_id ?? '').trim();
    const month = String(body.month ?? '').trim();

    if (!bindingId) return json({ error: 'binding_id required' }, 400);
    if (!/^\d{4}-\d{2}$/.test(month)) return json({ error: 'month must be YYYY-MM' }, 400);

    // Slice 18b — dispatch on binding.source so the same endpoint
    // handles GSC and GA4 without branching UI. The admin page uses
    // one "sync now" button per binding regardless of kind.
    const binding = await getBindingById(bindingId);
    if (!binding) return json({ error: 'binding not found' }, 404);

    let result;
    if (binding.source === 'gsc') {
      result = await syncGscForBinding(bindingId, month, locals.user!.id);
    } else if (binding.source === 'ga4') {
      result = await syncGa4ForBinding(bindingId, month, locals.user!.id);
    } else {
      return json(
        { error: `binding source '${binding.source}' is not syncable via Google` },
        400
      );
    }

    const status = result.status === 'applied' ? 200 : 409;
    return json(result, status);
  } catch (err) {
    logger.error('google sync error', err);
    return json({ error: String((err as Error)?.message ?? err) }, 500);
  }
};
