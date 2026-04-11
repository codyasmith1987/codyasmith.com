import type { APIRoute } from 'astro';
import { getProject, updateProject, deleteProject } from '../../../../../lib/contracts';
import { logActivity } from '../../../../../lib/activity';
import { logger } from '../../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals, params }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const project = await getProject(params.id!);
    if (!project) return json({ error: 'Not found' }, 404);
    return json(project);
  } catch (err) {
    logger.error('Get project error', err);
    return json({ error: 'Failed to load project' }, 500);
  }
};

export const PUT: APIRoute = async ({ locals, params, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const project = await getProject(params.id!);
    if (!project) return json({ error: 'Not found' }, 404);

    const body = await request.json();
    await updateProject(params.id!, {
      ...(body.title !== undefined && { title: body.title.trim() }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.status !== undefined && { status: body.status }),
      ...(body.sort_order !== undefined && { sort_order: body.sort_order }),
      ...(body.client_visible !== undefined && { client_visible: body.client_visible ? 1 : 0 }),
    });

    await logActivity({
      clientId: project.client_id,
      userId: locals.user!.id,
      action: 'updated',
      entityType: 'project',
      entityId: params.id!,
      summary: `${locals.user!.name} updated project "${project.title}"`,
    });

    return json({ ok: true });
  } catch (err) {
    logger.error('Update project error', err);
    return json({ error: 'Failed to update project' }, 500);
  }
};

export const DELETE: APIRoute = async ({ locals, params }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const project = await getProject(params.id!);
    if (!project) return json({ error: 'Not found' }, 404);

    await deleteProject(params.id!);

    await logActivity({
      clientId: project.client_id,
      userId: locals.user!.id,
      action: 'deleted',
      entityType: 'project',
      entityId: params.id!,
      summary: `${locals.user!.name} deleted project "${project.title}"`,
    });

    return json({ ok: true });
  } catch (err) {
    logger.error('Delete project error', err);
    return json({ error: 'Failed to delete project' }, 500);
  }
};
