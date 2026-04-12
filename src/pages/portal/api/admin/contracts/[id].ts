// GET: single contract
// PUT: update contract
// DELETE: delete contract

import type { APIRoute } from 'astro';
import { getContract, updateContract, deleteContract } from '../../../../../lib/contracts';
import { logActivity } from '../../../../../lib/activity';
import { logger } from '../../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals, params }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const contract = await getContract(params.id!);
    if (!contract) return json({ error: 'Not found' }, 404);
    return json(contract);
  } catch (err) {
    logger.error('Get contract error', err);
    return json({ error: 'Failed to load contract' }, 500);
  }
};

export const PUT: APIRoute = async ({ locals, params, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const contract = await getContract(params.id!);
    if (!contract) return json({ error: 'Not found' }, 404);

    const body = await request.json();
    const { title, description, status, type, total_value, start_date, end_date, signed_at,
            billing_cadence, billing_day, recurring_amount, included_hours, overage_rate, payment_terms_days } = body;

    await updateContract(params.id!, {
      ...(title !== undefined && { title: title.trim() }),
      ...(description !== undefined && { description }),
      ...(status !== undefined && { status }),
      ...(type !== undefined && { type }),
      ...(total_value !== undefined && { total_value: total_value != null ? Number(total_value) : null }),
      ...(start_date !== undefined && { start_date }),
      ...(end_date !== undefined && { end_date }),
      ...(signed_at !== undefined && { signed_at }),
      ...(billing_cadence !== undefined && { billing_cadence }),
      ...(billing_day !== undefined && { billing_day: billing_day != null ? Number(billing_day) : null }),
      ...(recurring_amount !== undefined && { recurring_amount: recurring_amount != null ? Number(recurring_amount) : null }),
      ...(included_hours !== undefined && { included_hours: included_hours != null ? Number(included_hours) : null }),
      ...(overage_rate !== undefined && { overage_rate: overage_rate != null ? Number(overage_rate) : null }),
      ...(payment_terms_days !== undefined && { payment_terms_days: payment_terms_days != null ? Number(payment_terms_days) : 30 }),
    });

    await logActivity({
      clientId: contract.client_id,
      userId: locals.user!.id,
      action: 'updated',
      entityType: 'contract',
      entityId: params.id!,
      summary: `${locals.user!.name} updated contract "${contract.title}"`,
    });

    return json({ ok: true });
  } catch (err) {
    logger.error('Update contract error', err);
    return json({ error: 'Failed to update contract' }, 500);
  }
};

export const DELETE: APIRoute = async ({ locals, params }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const contract = await getContract(params.id!);
    if (!contract) return json({ error: 'Not found' }, 404);

    await deleteContract(params.id!);

    await logActivity({
      clientId: contract.client_id,
      userId: locals.user!.id,
      action: 'deleted',
      entityType: 'contract',
      entityId: params.id!,
      summary: `${locals.user!.name} deleted contract "${contract.title}"`,
    });

    return json({ ok: true });
  } catch (err) {
    logger.error('Delete contract error', err);
    return json({ error: 'Failed to delete contract' }, 500);
  }
};
