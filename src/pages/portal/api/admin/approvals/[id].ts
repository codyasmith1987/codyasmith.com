import type { APIRoute } from 'astro';
import { getApproval, respondToApproval } from '../../../../../lib/invoices';
import { logActivity } from '../../../../../lib/activity';
import { logger } from '../../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals, params }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const approval = await getApproval(params.id!);
    if (!approval) return json({ error: 'Not found' }, 404);
    return json(approval);
  } catch (err) {
    logger.error('Get approval error', err);
    return json({ error: 'Failed to load approval' }, 500);
  }
};

// Respond to an approval (approve/reject/request revision)
export const PUT: APIRoute = async ({ locals, params, request }) => {
  // Approvals can be responded to by admin or the client user
  if (!locals.user) return json({ error: 'Forbidden' }, 403);

  try {
    const approval = await getApproval(params.id!);
    if (!approval) return json({ error: 'Not found' }, 404);

    const { status, response_note } = await request.json();
    if (!['approved', 'rejected', 'revision_requested'].includes(status)) {
      return json({ error: 'status must be approved, rejected, or revision_requested' }, 400);
    }

    const accepted = await respondToApproval(params.id!, {
      status,
      responded_by: locals.user!.id,
      response_note: response_note?.trim() || undefined,
    });

    if (!accepted) {
      return json({ error: 'Approval has already been resolved' }, 409);
    }

    await logActivity({
      userId: locals.user!.id,
      action: status,
      entityType: 'approval',
      entityId: params.id!,
      summary: `${locals.user!.name} ${status} approval: "${approval.title}"`,
    });

    return json({ ok: true });
  } catch (err) {
    logger.error('Respond to approval error', err);
    return json({ error: 'Failed to respond to approval' }, 500);
  }
};
