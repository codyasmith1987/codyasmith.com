import type { APIRoute } from 'astro';
import { getTask, updateTask, deleteTask, getMilestone, getProject } from '../../../../../lib/contracts';
import { logActivity } from '../../../../../lib/activity';
import { logger } from '../../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals, params }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const task = await getTask(params.id!);
    if (!task) return json({ error: 'Not found' }, 404);
    return json(task);
  } catch (err) {
    logger.error('Get task error', err);
    return json({ error: 'Failed to load task' }, 500);
  }
};

export const PUT: APIRoute = async ({ locals, params, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const task = await getTask(params.id!);
    if (!task) return json({ error: 'Not found' }, 404);

    const body = await request.json();

    const updates: any = {};
    if (body.title !== undefined) updates.title = body.title.trim();
    if (body.description !== undefined) updates.description = body.description;
    if (body.status !== undefined) {
      updates.status = body.status;
      if (body.status === 'done' && !task.completed_at) {
        updates.completed_at = new Date().toISOString();
      }
    }
    if (body.priority !== undefined) updates.priority = body.priority;
    if (body.assigned_to !== undefined) updates.assigned_to = body.assigned_to || null;
    if (body.estimated_hours !== undefined) updates.estimated_hours = body.estimated_hours;
    if (body.actual_hours !== undefined) updates.actual_hours = body.actual_hours;
    if (body.due_date !== undefined) updates.due_date = body.due_date;
    if (body.sort_order !== undefined) updates.sort_order = body.sort_order;
    if (body.client_visible !== undefined) updates.client_visible = body.client_visible ? 1 : 0;
    if (body.client_update_text !== undefined) updates.client_update_text = body.client_update_text;

    await updateTask(params.id!, updates);

    const milestone = await getMilestone(task.milestone_id);
    const project = milestone ? await getProject(milestone.project_id) : null;
    await logActivity({
      clientId: project?.client_id,
      userId: locals.user!.id,
      action: 'updated',
      entityType: 'task',
      entityId: params.id!,
      summary: `${locals.user!.name} updated task "${task.title}"`,
    });

    return json({ ok: true });
  } catch (err) {
    logger.error('Update task error', err);
    return json({ error: 'Failed to update task' }, 500);
  }
};

export const DELETE: APIRoute = async ({ locals, params }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const task = await getTask(params.id!);
    if (!task) return json({ error: 'Not found' }, 404);

    const milestone = await getMilestone(task.milestone_id);
    const project = milestone ? await getProject(milestone.project_id) : null;

    await deleteTask(params.id!);

    await logActivity({
      clientId: project?.client_id,
      userId: locals.user!.id,
      action: 'deleted',
      entityType: 'task',
      entityId: params.id!,
      summary: `${locals.user!.name} deleted task "${task.title}"`,
    });

    return json({ ok: true });
  } catch (err) {
    logger.error('Delete task error', err);
    return json({ error: 'Failed to delete task' }, 500);
  }
};
