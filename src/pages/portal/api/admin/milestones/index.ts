import type { APIRoute } from 'astro';
import { createMilestone, getMilestonesByProject, getProject } from '../../../../../lib/contracts';
import { logActivity } from '../../../../../lib/activity';
import { logger } from '../../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals, url }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const projectId = url.searchParams.get('project_id');
    if (!projectId) return json({ error: 'project_id required' }, 400);
    return json(await getMilestonesByProject(projectId));
  } catch (err) {
    logger.error('List milestones error', err);
    return json({ error: 'Failed to load milestones' }, 500);
  }
};

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const { project_id, title, description, due_date, client_visible, client_update_text } = await request.json();

    if (!project_id?.trim() || !title?.trim()) {
      return json({ error: 'project_id and title are required' }, 400);
    }

    const project = await getProject(project_id);
    if (!project) return json({ error: 'Project not found' }, 404);

    const id = await createMilestone({
      project_id: project_id.trim(),
      title: title.trim(),
      description: description?.trim() || undefined,
      due_date: due_date || undefined,
      client_visible: client_visible !== false,
      client_update_text: client_update_text?.trim() || undefined,
    });

    await logActivity({
      clientId: project.client_id,
      userId: locals.user!.id,
      action: 'created',
      entityType: 'milestone',
      entityId: id,
      summary: `${locals.user!.name} created milestone "${title.trim()}" in ${project.title}`,
    });

    return json({ id }, 201);
  } catch (err) {
    logger.error('Create milestone error', err);
    return json({ error: 'Failed to create milestone' }, 500);
  }
};
