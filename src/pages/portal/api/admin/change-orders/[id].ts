import type { APIRoute } from 'astro';
import { getChangeOrder, updateChangeOrder, approveChangeOrder } from '../../../../../lib/invoices';
import { logActivity } from '../../../../../lib/activity';
import { logger } from '../../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals, params }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const co = await getChangeOrder(params.id!);
    if (!co) return json({ error: 'Not found' }, 404);
    return json(co);
  } catch (err) {
    logger.error('Get change order error', err);
    return json({ error: 'Failed to load change order' }, 500);
  }
};

export const PUT: APIRoute = async ({ locals, params, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const co = await getChangeOrder(params.id!);
    if (!co) return json({ error: 'Not found' }, 404);

    const body = await request.json();

    // Handle approval action
    if (body.action === 'approve') {
      await approveChangeOrder(params.id!, locals.user!.id);

      await logActivity({
        userId: locals.user!.id,
        action: 'approved',
        entityType: 'change_order',
        entityId: params.id!,
        summary: `${locals.user!.name} approved change order: "${co.title}"`,
      });

      return json({ ok: true });
    }

    // Standard field updates
    await updateChangeOrder(params.id!, {
      ...(body.title !== undefined && { title: body.title.trim() }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.status !== undefined && { status: body.status }),
      ...(body.cost_impact !== undefined && { cost_impact: Number(body.cost_impact) }),
      ...(body.time_impact_days !== undefined && { time_impact_days: Number(body.time_impact_days) }),
    });

    await logActivity({
      userId: locals.user!.id,
      action: 'updated',
      entityType: 'change_order',
      entityId: params.id!,
      summary: `${locals.user!.name} updated change order: "${co.title}"`,
    });

    return json({ ok: true });
  } catch (err) {
    logger.error('Update change order error', err);
    return json({ error: 'Failed to update change order' }, 500);
  }
};
