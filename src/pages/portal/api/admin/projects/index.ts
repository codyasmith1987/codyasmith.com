import type { APIRoute } from 'astro';
import { createProject, getProjectsByContract, getProjectsByClient } from '../../../../../lib/contracts';
import { logActivity } from '../../../../../lib/activity';
import { logger } from '../../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals, url }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const contractId = url.searchParams.get('contract_id');
    const clientId = url.searchParams.get('client_id');

    if (contractId) return json(await getProjectsByContract(contractId));
    if (clientId) return json(await getProjectsByClient(clientId));
    return json({ error: 'contract_id or client_id required' }, 400);
  } catch (err) {
    logger.error('List projects error', err);
    return json({ error: 'Failed to load projects' }, 500);
  }
};

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const { contract_id, client_id, title, description, client_visible } = await request.json();

    if (!contract_id?.trim() || !client_id?.trim() || !title?.trim()) {
      return json({ error: 'contract_id, client_id, and title are required' }, 400);
    }

    const id = await createProject({
      contract_id: contract_id.trim(),
      client_id: client_id.trim(),
      title: title.trim(),
      description: description?.trim() || undefined,
      client_visible: client_visible !== false,
    });

    await logActivity({
      clientId: client_id.trim(),
      userId: locals.user!.id,
      action: 'created',
      entityType: 'project',
      entityId: id,
      summary: `${locals.user!.name} created project "${title.trim()}"`,
    });

    return json({ id }, 201);
  } catch (err) {
    logger.error('Create project error', err);
    return json({ error: 'Failed to create project' }, 500);
  }
};
