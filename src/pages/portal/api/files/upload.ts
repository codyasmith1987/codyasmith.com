import type { APIRoute } from 'astro';
import { uploadFile, FILE_CATEGORY_LABELS } from '../../../../lib/storage';
import turso from '../../../../lib/turso';
import { logger } from '../../../../lib/logger';
import { logActivity } from '../../../../lib/activity';

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
    // Allowlist the category against the canonical taxonomy so the UI and
    // storage.ts can't silently drift (e.g. a select option referencing a
    // category that no longer exists). Unknown/absent -> 'general'.
    const categoryRaw = (formData.get('category') as string) || 'general';
    const category = Object.prototype.hasOwnProperty.call(FILE_CATEGORY_LABELS, categoryRaw) ? categoryRaw : 'general';
    // Optional per-site attribution (multi-site clients). Empty/absent = null
    // (engagement-level / not site-specific). Validated against the client's
    // managed sites below so a stray id can't be stored.
    const siteIdRaw = ((formData.get('site_id') as string | null) || '').trim();

    if (!file || !clientId || !month) {
      return json({ error: 'File, client_id, and month are required' }, 400);
    }

    if (!/^\d{4}-\d{2}$/.test(month)) {
      return json({ error: 'Month must be in YYYY-MM format' }, 400);
    }

    // Get client slug for S3 path
    const clientResult = await turso.execute({
      sql: 'SELECT slug FROM clients WHERE id = ?',
      args: [clientId],
    });
    if (clientResult.rows.length === 0) {
      return json({ error: 'Client not found' }, 404);
    }
    const clientSlug = clientResult.rows[0][0] as string;

    // Validate the optional site_id belongs to this client; otherwise store
    // null (engagement-level) rather than a stray/foreign site id.
    let siteId: string | null = null;
    if (siteIdRaw) {
      const siteCheck = await turso.execute({
        sql: 'SELECT id FROM client_sites WHERE id = ? AND client_id = ? LIMIT 1',
        args: [siteIdRaw, clientId],
      });
      if (siteCheck.rows.length > 0) siteId = siteIdRaw;
    }

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
      siteId,
    );

    await logActivity({
      clientId,
      userId: locals.user!.id,
      action: 'uploaded',
      entityType: 'file',
      entityId: result.id,
      summary: `${locals.user!.name} uploaded "${file.name}"`,
    });

    return json({ id: result.id, filename: file.name, size: buffer.length });
  } catch (err: any) {
    logger.error('File upload error', err);
    return json({ error: 'Upload failed' }, 500);
  }
};
