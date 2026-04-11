// Client-facing: pending approvals that need client response

import type { APIRoute } from 'astro';
import { getPendingApprovals, getApproval, respondToApproval } from '../../../../lib/invoices';
import { getContract } from '../../../../lib/contracts';
import { logActivity } from '../../../../lib/activity';
import { logger } from '../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals }) => {
  if (!locals.user?.client_id) return json({ error: 'Forbidden' }, 403);

  try {
    // Get all pending approvals, filter to ones belonging to this client's contracts
    const allPending = await getPendingApprovals();
    const clientApprovals = [];

    for (const approval of allPending) {
      const contract = await getContract(approval.contract_id);
      if (contract?.client_id === locals.user.client_id) {
        clientApprovals.push({
          id: approval.id,
          title: approval.title,
          description: approval.description,
          status: approval.status,
          requested_at: approval.requested_at,
        });
      }
    }

    return json(clientApprovals);
  } catch (err) {
    logger.error('Client approvals error', err);
    return json({ error: 'Failed to load approvals' }, 500);
  }
};

// Client responds to an approval
export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user?.client_id) return json({ error: 'Forbidden' }, 403);

  try {
    const { id, status, response_note } = await request.json();

    if (!id || !['approved', 'rejected', 'revision_requested'].includes(status)) {
      return json({ error: 'id and valid status required' }, 400);
    }

    // Verify this approval belongs to the client
    const approval = await getApproval(id);
    if (!approval) return json({ error: 'Not found' }, 404);

    const contract = await getContract(approval.contract_id);
    if (contract?.client_id !== locals.user.client_id) {
      return json({ error: 'Forbidden' }, 403);
    }

    const accepted = await respondToApproval(id, {
      status,
      responded_by: locals.user.id,
      response_note: response_note?.trim() || undefined,
    });

    if (!accepted) {
      return json({ error: 'Approval has already been resolved' }, 409);
    }

    await logActivity({
      clientId: locals.user.client_id,
      userId: locals.user.id,
      action: status,
      entityType: 'approval',
      entityId: id,
      summary: `${locals.user.name} ${status} approval: "${approval.title}"`,
    });

    return json({ ok: true });
  } catch (err) {
    logger.error('Client approval response error', err);
    return json({ error: 'Failed to respond to approval' }, 500);
  }
};
