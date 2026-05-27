// Admin CSV upload endpoint.
//
// Accepts:
//   - a single 'file' (legacy) OR multiple 'files' in the same
//     formData (batch). The batch path lets the client send N files
//     in ONE request instead of N separate ones; avoids tripping
//     Cloudflare's burst-detection / WAF on a full Screaming Frog
//     export folder (100+ files in a few seconds).
//   - .zip archives: server unzips and processes each CSV inside as
//     its own upload row. Per the data-ingestion overhaul: GSC
//     Performance exports and Ubersuggest site audits ship as ZIPs.
//
// Per-file result is returned in an array so the UI can render
// success/error chips for each. Errors on one file do not stop the
// rest. A ZIP that contains N CSVs returns N result rows.

import type { APIRoute } from 'astro';
import JSZip from 'jszip';
import { ingestCSV } from '../../../../lib/csv/index';
import { logger } from '../../../../lib/logger';
import { logActivity } from '../../../../lib/activity';
import { syncDetectedDomains, syncPerSitePageCounts } from '../../../../lib/client-sites';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const MAX_BYTES_PER_FILE = 10 * 1024 * 1024;
const MAX_ROWS_PER_FILE = 50000;
const MAX_FILES_PER_BATCH = 50;
const MAX_BYTES_PER_ZIP = 25 * 1024 * 1024;
const MAX_CSVS_PER_ZIP = 100;

interface PerFileResult {
  filename: string;
  upload_id?: string;
  format?: string;
  row_count?: number;
  error?: string;
  headers?: string[];
}

// Ingest one raw CSV string. Shared between the direct .csv path and
// the unzip path so the size + row checks + activity log + result
// shape are identical for both.
async function ingestOneCsv(
  filename: string,
  raw: string,
  sizeBytes: number,
  clientId: string,
  month: string,
  userId: string,
  userName: string,
): Promise<PerFileResult> {
  if (sizeBytes > MAX_BYTES_PER_FILE) {
    return { filename, error: 'CSV file must be under 10MB' };
  }
  const lineCount = (raw.match(/\n/g) || []).length + 1;
  if (lineCount > MAX_ROWS_PER_FILE) {
    return { filename, error: `CSV exceeds ${MAX_ROWS_PER_FILE} row maximum (${lineCount} rows submitted)` };
  }
  try {
    const result = await ingestCSV(raw, clientId, month, filename, userId);
    await logActivity({
      clientId,
      userId,
      action: 'uploaded',
      entityType: 'csv_upload',
      entityId: result.uploadId,
      summary: `${userName} uploaded CSV "${filename}" (${result.format}${result.error ? ', failed' : `, ${result.rowCount} rows`})`,
    });
    return {
      filename,
      upload_id: result.uploadId,
      format: result.format,
      row_count: result.rowCount,
      error: result.error,
      headers: result.headers,
    };
  } catch (err: any) {
    logger.error('CSV upload error', err);
    return { filename, error: err?.message || 'Upload failed' };
  }
}

async function processOne(
  file: File,
  clientId: string,
  month: string,
  userId: string,
  userName: string,
): Promise<PerFileResult | PerFileResult[]> {
  const lowerName = file.name.toLowerCase();

  // ZIP path. GSC Performance exports and Ubersuggest site audits
  // ship as ZIPs; unpack server-side and process each CSV inside as
  // its own upload row. Return an array of results so the UI shows
  // one chip per CSV instead of one chip for the ZIP.
  if (lowerName.endsWith('.zip')) {
    if (file.size > MAX_BYTES_PER_ZIP) {
      return { filename: file.name, error: `ZIP must be under ${MAX_BYTES_PER_ZIP / (1024 * 1024)}MB` };
    }
    const buf = Buffer.from(await file.arrayBuffer());
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(buf);
    } catch (err: any) {
      return { filename: file.name, error: `ZIP could not be opened: ${err?.message || 'invalid archive'}` };
    }

    const csvEntries = Object.values(zip.files).filter(entry =>
      !entry.dir && entry.name.toLowerCase().endsWith('.csv')
    );
    if (csvEntries.length === 0) {
      return { filename: file.name, error: 'ZIP contains no CSV files' };
    }
    if (csvEntries.length > MAX_CSVS_PER_ZIP) {
      return { filename: file.name, error: `ZIP contains ${csvEntries.length} CSVs; limit is ${MAX_CSVS_PER_ZIP}` };
    }

    const results: PerFileResult[] = [];
    for (const entry of csvEntries) {
      const raw = await entry.async('string');
      // Strip any path inside the ZIP — the filename downstream is
      // just the basename so the detector's filename-based routing
      // works the same as if the file had been uploaded standalone.
      const baseName = entry.name.replace(/^.*[\\/]/, '');
      const sizeBytes = raw.length; // approximate; rows still bounded
      results.push(await ingestOneCsv(`${file.name}:${baseName}`, raw, sizeBytes, clientId, month, userId, userName));
    }
    return results;
  }

  // CSV path.
  if (!lowerName.endsWith('.csv')) {
    return { filename: file.name, error: 'Only CSV or ZIP files are accepted' };
  }
  const raw = await file.text();
  // The folder-picker (webkitdirectory) hands back a name like
  // "2026.05.24.15.21.38/issues_reports/response_codes_external_client_error_(4xx)_inlinks.csv"
  // — relative path included. The detector and parsers expect the
  // basename only. Strip the directory prefix so filename-based
  // routing matches the same way it would for a single-file pick.
  const baseName = file.name.replace(/^.*[\\/]/, '');
  return ingestOneCsv(baseName, raw, file.size, clientId, month, userId, userName);
}

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (err: any) {
    // Multipart parse can throw on malformed bodies, oversized
    // payloads, or premature client disconnect. Return a clean JSON
    // 400 so the wizard surfaces a useful message rather than
    // letting Astro emit an empty 5xx that Cloudflare wraps as 520.
    logger.error('CSV upload formData parse failed', err);
    return json({ error: `Could not read upload body: ${err?.message || 'parse failed'}` }, 400);
  }

  try {
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

    // Process the batch in parallel. Earlier comment claimed sequential
    // was required to avoid hammering Turso and to keep supersede
    // semantics simple; in practice Turso handles concurrent writes
    // fine and supersede operates per-filename per-client per-month
    // (no contention between different filenames). Sequential was the
    // direct cause of the Cloudflare 524 timeouts on large SF batches
    // where 4-5 big link CSVs (6000+ rows each) would push a 25-file
    // batch past CF's 100s origin response window even though no
    // single file is slow. Parallel makes the batch limited by the
    // SLOWEST file, not the sum.
    //
    // processOne can return a single result OR an array (for ZIPs
    // that fan out to multiple CSV uploads); flatten so the UI gets
    // one chip per ingested CSV. Promise.allSettled so one parser
    // throw doesn't fail the whole batch.
    const settled = await Promise.allSettled(
      files.map(file => processOne(file, clientId, month, userId, userName))
    );
    const results: PerFileResult[] = [];
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      if (s.status === 'fulfilled') {
        if (Array.isArray(s.value)) results.push(...s.value);
        else results.push(s.value);
      } else {
        results.push({
          filename: files[i].name,
          error: s.reason?.message || 'processing failed',
        });
      }
    }

    // Auto-bind detected domains + per-site page counts to
    // client_sites. The data has already landed in crawl_urls and
    // keyword_rankings; this propagates that into the canonical
    // sites table so the proposal wizard, Schedule A, and pricing
    // pipeline see a populated record without requiring a wizard
    // visit to trigger sync. Runs once per batch.
    //
    // Wrapped in try/catch so a sync failure never breaks the
    // upload response — the data is already saved and the user
    // sees their chips. Errors logged for diagnosis.
    try {
      await syncDetectedDomains(clientId);
      await syncPerSitePageCounts(clientId);
    } catch (err) {
      logger.error('post-upload client_sites sync failed', err);
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
