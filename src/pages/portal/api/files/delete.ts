import type { APIRoute } from 'astro';
import { getFileById, deleteFileFromStorage } from '../../../../lib/storage';
import { logger } from '../../../../lib/logger';
import { logActivity } from '../../../../lib/activity';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const { file_id } = await request.json();
    if (!file_id) return json({ error: 'file_id is required' }, 400);

    const file = await getFileById(file_id);
    if (!file) return json({ error: 'File not found' }, 404);

    // Log before delete
    await logActivity({
      clientId: file.client_id,
      userId: locals.user!.id,
      action: 'deleted',
      entityType: 'file',
      entityId: file.id,
      summary: `${locals.user!.name} deleted "${file.original_name}"`,
    });

    await deleteFileFromStorage(file.s3_key, file.id);
    return json({ ok: true });
  } catch (err: any) {
    logger.error('File delete error', err);
    return json({ error: 'Delete failed' }, 500);
  }
};
