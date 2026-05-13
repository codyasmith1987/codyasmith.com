import type { APIRoute } from 'astro';
import { ingestCSV } from '../../../../lib/csv/index';
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

    if (!file || !clientId || !month) {
      return json({ error: 'File, client_id, and month are required' }, 400);
    }

    if (!file.name.toLowerCase().endsWith('.csv')) {
      return json({ error: 'Only CSV files are accepted' }, 400);
    }

    // 10MB size limit for CSV files
    if (file.size > 10 * 1024 * 1024) {
      return json({ error: 'CSV file must be under 10MB' }, 400);
    }

    // Row count cap: 50k rows is generous for realistic SEO/keyword exports
    // and still bounds DoS risk. See security-audit-2026-05-12 SEC-019.
    const MAX_ROWS = 50000;
    const raw = await file.text();
    const lineCount = (raw.match(/\n/g) || []).length + 1;
    if (lineCount > MAX_ROWS) {
      return json({ error: `CSV exceeds ${MAX_ROWS} row maximum (${lineCount} rows submitted)` }, 400);
    }

    const result = await ingestCSV(raw, clientId, month, file.name, locals.user.id);

    await logActivity({
      clientId,
      userId: locals.user!.id,
      action: 'uploaded',
      entityType: 'csv_upload',
      entityId: result.uploadId,
      summary: `${locals.user!.name} uploaded CSV "${file.name}" (${result.format}${result.error ? ', failed' : `, ${result.rowCount} rows`})`,
    });

    if (result.error) {
      return json({
        upload_id: result.uploadId,
        format: result.format,
        row_count: result.rowCount,
        error: result.error,
        headers: result.headers,
      }, 422);
    }

    return json({
      upload_id: result.uploadId,
      format: result.format,
      row_count: result.rowCount,
    });
  } catch (err: any) {
    logger.error('CSV upload error', err);
    return json({ error: 'Upload failed' }, 500);
  }
};
