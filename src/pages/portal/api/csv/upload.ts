import type { APIRoute } from 'astro';
import { ingestCSVViaSnapshots } from '../../../../lib/csv/ingest-v2';
import { logger } from '../../../../lib/logger';
import { logActivity } from '../../../../lib/activity';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// Cut over to ingest-v2 (snapshot-based, idempotent by content_hash).
// Response shape extended with a top-level `status` so the admin UI can
// distinguish 'applied' / 'noop' / 'failed'. The old fields
// (upload_id, format, row_count, error) are preserved for back-compat.

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const clientId = formData.get('client_id') as string;
    const month = formData.get('month') as string;

    if (!file || !clientId || !month) {
      return json({ error: 'File, client_id, and month are required' }, 400);
    }

    if (!file.name.toLowerCase().endsWith('.csv')) {
      return json({ error: 'Only CSV files are accepted' }, 400);
    }

    if (file.size > 10 * 1024 * 1024) {
      return json({ error: 'CSV file must be under 10MB' }, 400);
    }

    const raw = await file.text();
    const result = await ingestCSVViaSnapshots(raw, clientId, month, file.name, locals.user.id);

    const summaryParts: string[] = [result.format];
    if (result.status === 'noop') summaryParts.push('no-op: identical content already imported');
    else if (result.status === 'failed') summaryParts.push(`failed: ${result.error ?? 'unknown'}`);
    else summaryParts.push(`${result.rowCount} rows`);

    await logActivity({
      clientId,
      userId: locals.user!.id,
      action: 'uploaded',
      entityType: 'csv_upload',
      entityId: result.importId,
      summary: `${locals.user!.name} uploaded CSV "${file.name}" (${summaryParts.join(', ')})`,
    });

    if (result.status === 'failed') {
      return json(
        {
          status: 'failed',
          upload_id: result.importId,
          format: result.format,
          row_count: 0,
          error: result.error,
          headers: result.headers,
        },
        422
      );
    }

    return json({
      status: result.status,
      upload_id: result.importId,
      format: result.format,
      row_count: result.rowCount,
    });
  } catch (err: any) {
    logger.error('CSV upload error', err);
    return json({ error: err.message || 'Upload failed' }, 500);
  }
};
