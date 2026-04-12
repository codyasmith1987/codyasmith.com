import type { APIRoute } from 'astro';
import { getMilestone, updateMilestone, deleteMilestone, getProject } from '../../../../../lib/contracts';
import { logActivity } from '../../../../../lib/activity';
import { logger } from '../../../../../lib/logger';
import { onMilestoneCompleted } from '../../../../../lib/triggers';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals, params }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const milestone = await getMilestone(params.id!);
    if (!milestone) return json({ error: 'Not found' }, 404);
    return json(milestone);
  } catch (err) {
    logger.error('Get milestone error', err);
    return json({ error: 'Failed to load milestone' }, 500);
  }
};

export const PUT: APIRoute = async ({ locals, params, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const milestone = await getMilestone(params.id!);
    if (!milestone) return json({ error: 'Not found' }, 404);

    const body = await request.json();

    // Auto-set completed_at when status changes to completed
    const updates: any = {};
    if (body.title !== undefined) updates.title = body.title.trim();
    if (body.description !== undefined) updates.description = body.description;
    if (body.status !== undefined) {
      updates.status = body.status;
      if (body.status === 'completed' && !milestone.completed_at) {
        updates.completed_at = new Date().toISOString();
      }
    }
    if (body.due_date !== undefined) updates.due_date = body.due_date;
    if (body.sort_order !== undefined) updates.sort_order = body.sort_order;
    if (body.client_visible !== undefined) updates.client_visible = body.client_visible ? 1 : 0;
    if (body.client_update_text !== undefined) updates.client_update_text = body.client_update_text;

    await updateMilestone(params.id!, updates);

    const project = await getProject(milestone.project_id);
    await logActivity({
      clientId: project?.client_id,
      userId: locals.user!.id,
      action: 'updated',
      entityType: 'milestone',
      entityId: params.id!,
      summary: `${locals.user!.name} updated milestone "${milestone.title}"`,
    });

    if (updates.status === 'completed' && milestone.status !== 'completed') {
      await onMilestoneCompleted(params.id!);
    }

    return json({ ok: true });
  } catch (err) {
    logger.error('Update milestone error', err);
    return json({ error: 'Failed to update milestone' }, 500);
  }
};

export const DELETE: APIRoute = async ({ locals, params }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const milestone = await getMilestone(params.id!);
    if (!milestone) return json({ error: 'Not found' }, 404);

    const project = await getProject(milestone.project_id);
    await deleteMilestone(params.id!);

    await logActivity({
      clientId: project?.client_id,
      userId: locals.user!.id,
      action: 'deleted',
      entityType: 'milestone',
      entityId: params.id!,
      summary: `${locals.user!.name} deleted milestone "${milestone.title}"`,
    });

    return json({ ok: true });
  } catch (err) {
    logger.error('Delete milestone error', err);
    return json({ error: 'Failed to delete milestone' }, 500);
  }
};
