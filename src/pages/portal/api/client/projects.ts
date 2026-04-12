// Client-facing: project status with milestones and visible tasks
// Never exposes cost, hours, or internal task data

import type { APIRoute } from 'astro';
import { getClientVisibleProjects, getClientVisibleMilestones, getClientVisibleTasks } from '../../../../lib/contracts';
import { logger } from '../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals }) => {
  if (!locals.user?.client_id) return json({ error: 'Forbidden' }, 403);

  try {
    const projects = await getClientVisibleProjects(locals.user.client_id);

    // Enrich each project with its visible milestones and tasks
    const enriched = await Promise.all(projects.map(async (project) => {
      const milestones = await getClientVisibleMilestones(project.id);

      const milestonesWithTasks = await Promise.all(milestones.map(async (ms) => {
        const tasks = await getClientVisibleTasks(ms.id);

        return {
          id: ms.id,
          title: ms.title,
          description: ms.description,
          status: ms.status,
          due_date: ms.due_date,
          completed_at: ms.completed_at,
          client_update_text: ms.client_update_text,
          tasks: tasks.map(t => ({
            id: t.id,
            title: t.title,
            status: t.status,
            client_update_text: t.client_update_text,
          })),
        };
      }));

      return {
        id: project.id,
        title: project.title,
        description: project.description,
        status: project.status,
        milestones: milestonesWithTasks,
      };
    }));

    return json(enriched);
  } catch (err) {
    logger.error('Client projects error', err);
    return json({ error: 'Failed to load projects' }, 500);
  }
};
