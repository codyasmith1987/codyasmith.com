import type { APIRoute } from 'astro';
import { createApproval, getApprovalsByContract, getPendingApprovals } from '../../../../../lib/invoices';
import { logActivity } from '../../../../../lib/activity';
import { logger } from '../../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals, url }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const contractId = url.searchParams.get('contract_id');
    const pending = url.searchParams.get('pending');

    if (pending === 'true') return json(await getPendingApprovals(contractId || undefined));
    if (contractId) return json(await getApprovalsByContract(contractId));
    return json(await getPendingApprovals());
  } catch (err) {
    logger.error('List approvals error', err);
    return json({ error: 'Failed to load approvals' }, 500);
  }
};

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const { contract_id, milestone_id, title, description } = await request.json();

    if (!contract_id?.trim() || !title?.trim()) {
      return json({ error: 'contract_id and title are required' }, 400);
    }

    const id = await createApproval({
      contract_id: contract_id.trim(),
      milestone_id: milestone_id || undefined,
      title: title.trim(),
      description: description?.trim() || undefined,
      requested_by: locals.user!.id,
    });

    await logActivity({
      userId: locals.user!.id,
      action: 'created',
      entityType: 'approval',
      entityId: id,
      summary: `${locals.user!.name} requested approval: "${title.trim()}"`,
    });

    return json({ id }, 201);
  } catch (err) {
    logger.error('Create approval error', err);
    return json({ error: 'Failed to create approval' }, 500);
  }
};
