// Admin CSV upload endpoint.
//
// Accepts either a single 'file' (legacy) OR multiple files via 'files'
// in the same formData (batch). The batch path lets the client send N
// files in ONE request instead of N separate ones; this avoids
// tripping Cloudflare's burst-detection / WAF when uploading a full
// Screaming Frog export folder (100+ files in a few seconds looks
// indistinguishable from a brute-force attack).
//
// Per-file result is returned in an array so the UI can render
// success/error chips for each. Errors on one file do not stop the
// rest.

import type { APIRoute } from 'astro';
import { ingestCSV } from '../../../../lib/csv/index';
import { logger } from '../../../../lib/logger';
import { logActivity } from '../../../../lib/activity';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const MAX_BYTES_PER_FILE = 10 * 1024 * 1024;
const MAX_ROWS_PER_FILE = 50000;
const MAX_FILES_PER_BATCH = 50;

interface PerFileResult {
  filename: string;
  upload_id?: string;
  format?: string;
  row_count?: number;
  error?: string;
  headers?: string[];
}

async function processOne(
  file: File,
  clientId: string,
  month: string,
  userId: string,
  userName: string,
): Promise<PerFileResult> {
  if (!file.name.toLowerCase().endsWith('.csv')) {
    return { filename: file.name, error: 'Only CSV files are accepted' };
  }
  if (file.size > MAX_BYTES_PER_FILE) {
    return { filename: file.name, error: 'CSV file must be under 10MB' };
  }
  const raw = await file.text();
  const lineCount = (raw.match(/\n/g) || []).length + 1;
  if (lineCount > MAX_ROWS_PER_FILE) {
    return { filename: file.name, error: `CSV exceeds ${MAX_ROWS_PER_FILE} row maximum (${lineCount} rows submitted)` };
  }

  try {
    const result = await ingestCSV(raw, clientId, month, file.name, userId);
    await logActivity({
      clientId,
      userId,
      action: 'uploaded',
      entityType: 'csv_upload',
      entityId: result.uploadId,
      summary: `${userName} uploaded CSV "${file.name}" (${result.format}${result.error ? ', failed' : `, ${result.rowCount} rows`})`,
    });
    return {
      filename: file.name,
      upload_id: result.uploadId,
      format: result.format,
      row_count: result.rowCount,
      error: result.error,
      headers: result.headers,
    };
  } catch (err: any) {
    logger.error('CSV upload error', err);
    return { filename: file.name, error: err?.message || 'Upload failed' };
  }
}

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const formData = await request.formData();
    const clientId = formData.get('client_id') as string;
    const month = formData.get('month') as string;

    if (!clientId || !month) {
      return json({ error: 'client_id and month are required' }, 400);
    }

    // Collect files: legacy single 'file' or batch 'files'.
    const files: File[] = [];
    const single = formData.get('file');
    if (single && single instanceof File) files.push(single);
    for (const v of formData.getAll('files')) {
      if (v instanceof File) files.push(v);
    }

    if (files.length === 0) {
      return json({ error: 'No files supplied' }, 400);
    }
    if (files.length > MAX_FILES_PER_BATCH) {
      return json({ error: `Batch is limited to ${MAX_FILES_PER_BATCH} files. Split across multiple requests.` }, 400);
    }

    const userId = locals.user!.id;
    const userName = locals.user!.name;

    // Process sequentially. Parallel would hammer Turso and complicate
    // the clearPreviousData / supersede logic.
    const results: PerFileResult[] = [];
    for (const file of files) {
      results.push(await processOne(file, clientId, month, userId, userName));
    }

    // Backward compat: when only one file was sent via legacy 'file'
    // field, return the old single-result shape so older callers
    // still work.
    if (files.length === 1 && single) {
      const r = results[0];
      if (r.error) {
        return json({
          upload_id: r.upload_id,
          format: r.format,
          row_count: r.row_count,
          error: r.error,
          headers: r.headers,
        }, 422);
      }
      return json({
        upload_id: r.upload_id,
        format: r.format,
        row_count: r.row_count,
      });
    }

    return json({ results });
  } catch (err: any) {
    logger.error('CSV upload batch error', err);
    return json({ error: err?.message || 'Upload failed' }, 500);
  }
};
