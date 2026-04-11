import type { APIRoute } from 'astro';
import { createChangeOrder, getChangeOrdersByContract } from '../../../../../lib/invoices';
import { logActivity } from '../../../../../lib/activity';
import { logger } from '../../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals, url }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const contractId = url.searchParams.get('contract_id');
    if (!contractId) return json({ error: 'contract_id required' }, 400);
    return json(await getChangeOrdersByContract(contractId));
  } catch (err) {
    logger.error('List change orders error', err);
    return json({ error: 'Failed to load change orders' }, 500);
  }
};

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const { contract_id, title, description, cost_impact, time_impact_days } = await request.json();

    if (!contract_id?.trim() || !title?.trim()) {
      return json({ error: 'contract_id and title are required' }, 400);
    }

    const id = await createChangeOrder({
      contract_id: contract_id.trim(),
      title: title.trim(),
      description: description?.trim() || undefined,
      cost_impact: cost_impact != null ? Number(cost_impact) : undefined,
      time_impact_days: time_impact_days != null ? Number(time_impact_days) : undefined,
      requested_by: locals.user!.id,
    });

    await logActivity({
      userId: locals.user!.id,
      action: 'created',
      entityType: 'change_order',
      entityId: id,
      summary: `${locals.user!.name} created change order: "${title.trim()}"`,
    });

    return json({ id }, 201);
  } catch (err) {
    logger.error('Create change order error', err);
    return json({ error: 'Failed to create change order' }, 500);
  }
};
