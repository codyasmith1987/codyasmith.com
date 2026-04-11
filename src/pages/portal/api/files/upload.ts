import type { APIRoute } from 'astro';
import { uploadFile } from '../../../../lib/storage';
import turso from '../../../../lib/turso';
import { ensurePortalTables } from '../../../../lib/auth';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const clientId = formData.get('client_id') as string;
    const month = formData.get('month') as string;
    const category = (formData.get('category') as string) || 'general';

    if (!file || !clientId || !month) {
      return json({ error: 'File, client_id, and month are required' }, 400);
    }

    if (!/^\d{4}-\d{2}$/.test(month)) {
      return json({ error: 'Month must be in YYYY-MM format' }, 400);
    }

    // Get client slug for S3 path
    await ensurePortalTables();
    const clientResult = await turso.execute({
      sql: 'SELECT slug FROM clients WHERE id = ?',
      args: [clientId],
    });
    if (clientResult.rows.length === 0) {
      return json({ error: 'Client not found' }, 404);
    }
    const clientSlug = clientResult.rows[0][0] as string;

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await uploadFile(
      clientSlug,
      month,
      file.name,
      buffer,
      file.type,
      clientId,
      locals.user.id,
      category,
    );

    return json({ id: result.id, filename: file.name, size: buffer.length });
  } catch (err: any) {
    console.error('File upload error:', err);
    return json({ error: err.message || 'Upload failed' }, 500);
  }
};
