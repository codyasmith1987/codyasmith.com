import type { APIRoute } from 'astro';
import { createTask, getTasksByMilestone, getTasksByAssignee, getMilestone, getProject } from '../../../../../lib/contracts';
import { logActivity } from '../../../../../lib/activity';
import { logger } from '../../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals, url }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const milestoneId = url.searchParams.get('milestone_id');
    const assigneeId = url.searchParams.get('assigned_to');

    if (milestoneId) return json(await getTasksByMilestone(milestoneId));
    if (assigneeId) return json(await getTasksByAssignee(assigneeId));
    return json({ error: 'milestone_id or assigned_to required' }, 400);
  } catch (err) {
    logger.error('List tasks error', err);
    return json({ error: 'Failed to load tasks' }, 500);
  }
};

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const body = await request.json();
    const { milestone_id, title, description, priority, assigned_to, estimated_hours, due_date, client_visible, client_update_text } = body;

    if (!milestone_id?.trim() || !title?.trim()) {
      return json({ error: 'milestone_id and title are required' }, 400);
    }

    const milestone = await getMilestone(milestone_id);
    if (!milestone) return json({ error: 'Milestone not found' }, 404);

    const id = await createTask({
      milestone_id: milestone_id.trim(),
      title: title.trim(),
      description: description?.trim() || undefined,
      priority: priority || undefined,
      assigned_to: assigned_to || undefined,
      estimated_hours: estimated_hours != null ? Number(estimated_hours) : undefined,
      due_date: due_date || undefined,
      client_visible: !!client_visible,
      client_update_text: client_update_text?.trim() || undefined,
    });

    const project = await getProject(milestone.project_id);
    await logActivity({
      clientId: project?.client_id,
      userId: locals.user!.id,
      action: 'created',
      entityType: 'task',
      entityId: id,
      summary: `${locals.user!.name} created task "${title.trim()}" in ${milestone.title}`,
    });

    return json({ id }, 201);
  } catch (err) {
    logger.error('Create task error', err);
    return json({ error: 'Failed to create task' }, 500);
  }
};
