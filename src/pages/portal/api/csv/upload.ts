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
import { recomputeCategoryCoverage, FORMAT_TO_CATEGORY } from '../../../../lib/csv/coverage-signals';
import turso from '../../../../lib/turso';
import { logger } from '../../../../lib/logger';
import { logActivity } from '../../../../lib/activity';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// Run async work over items with at most `limit` in flight at once. Caps the
// number of concurrent per-file ingests so a 50-file folder upload does not
// fire 50x parallel turso.batch round-trips and saturate the remote libsql
// connection. Returns results in input order (like Promise.allSettled but
// bounded). Exported so the concurrency unit test can exercise it in isolation.
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<{ status: 'fulfilled'; value: R } | { status: 'rejected'; reason: any }>> {
  const results: Array<{ status: 'fulfilled'; value: R } | { status: 'rejected'; reason: any }> =
    new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

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

// Single-attempt ingest wrapper. Exported so tests can exercise it in isolation
// without importing the full Astro route.
//
// The multi-retry backoff loop that used to live here has been removed. It was
// designed to heal "concurrent upload" unique-index collisions that arose when
// all files ran fully parallel. Now that:
//   (a) mapLimit caps concurrency at 5 (bounded parallelism, not 50-at-once), and
//   (b) Class-A parsers run atomically inside a single turso.batch transaction
//       (Task 8), making the race impossible for supersede-class formats, and
//   (c) Class-B parsers self-dedup by key,
// the "concurrent upload" collision is vanishingly rare. If it does occur, it
// surfaces as the file's error and the user can re-upload that one file.
export async function ingestWithRetry<T extends { error?: string }>(
  ingestFn: () => Promise<T>,
): Promise<T> {
  return ingestFn();
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
  siteId: string | null = null,
): Promise<PerFileResult> {
  if (sizeBytes > MAX_BYTES_PER_FILE) {
    return { filename, error: 'CSV file must be under 10MB' };
  }
  const lineCount = (raw.match(/\n/g) || []).length + 1;
  if (lineCount > MAX_ROWS_PER_FILE) {
    return { filename, error: `CSV exceeds ${MAX_ROWS_PER_FILE} row maximum (${lineCount} rows submitted)` };
  }
  try {
    // deferCoverage=true: skip the per-file coverage recompute. The POST handler
    // recomputes each touched category ONCE after the whole batch (see below) —
    // identical result, without re-scanning the client's data on every file.
    const result = await ingestWithRetry(() => ingestCSV(raw, clientId, month, filename, userId, siteId, true));
    await logActivity({
      clientId,
      userId,
      action: 'uploaded',
      entityType: 'csv_upload',
      entityId: result.uploadId,
      summary: `${userName} uploaded CSV "${filename.split(/[\\/]/).pop()}" (${result.format}${result.error ? ', failed' : `, ${result.rowCount} rows`})`,
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
  siteId: string | null = null,
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
      // Pass the full ZIP-entry path as the identity key so that two
      // same-basename files in different subfolders (e.g. a Screaming
      // Frog folder export with issues_reports/foo.csv and top-level
      // foo.csv) get DISTINCT original_name values and both ingest.
      // detectFormat strips the path internally before routing, so
      // detection is unaffected.
      const sizeBytes = raw.length; // approximate; rows still bounded
      results.push(await ingestOneCsv(`${file.name}:${entry.name}`, raw, sizeBytes, clientId, month, userId, userName, siteId));
    }
    return results;
  }

  // CSV path.
  if (!lowerName.endsWith('.csv')) {
    return { filename: file.name, error: 'Only CSV or ZIP files are accepted' };
  }
  const raw = await file.text();
  // Pass the full relative path as the identity key. The folder-picker
  // (webkitdirectory) hands back a name like
  // "2026.05.24.15.21.38/issues_reports/foo.csv", and the same basename
  // can appear under multiple subfolders in one Screaming Frog export.
  // Preserving the path makes each file a DISTINCT dedup key so both
  // ingest. detectFormat and all parsers strip/normalize paths
  // internally before routing and keying, so they are unaffected.
  return ingestOneCsv(file.name, raw, file.size, clientId, month, userId, userName, siteId);
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
    // Month must be canonical YYYY-MM. A non-padded month (e.g. "2026-5")
    // would sort wrong lexicographically and corrupt prior-period lookups
    // in the report layer. Matches the files/upload guard.
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return json({ error: 'month must be in YYYY-MM format' }, 400);
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

    // Optional site attribution (multi-site Phase 1). When supplied it must be
    // one of THIS client's managed sites -- a site id from another client is
    // rejected, not silently accepted. Absent/empty means the client's
    // primary/only site (stored as NULL), which keeps single-site clients and
    // legacy callers unchanged.
    let siteId: string | null = null;
    const siteRaw = (formData.get('site_id') as string | null)?.trim() || '';
    if (siteRaw) {
      const { listManagedSites } = await import('../../../../lib/client-sites');
      const sites = await listManagedSites(clientId);
      const match = sites.find(s => s.id === siteRaw);
      if (!match) {
        return json({ error: 'site_id does not belong to this client' }, 400);
      }
      // Primary-site uploads store NULL (the canonical "primary" marker), so
      // the same file uploaded with and without an explicit primary selection
      // shares one supersession key instead of silently coexisting twice.
      siteId = match.is_primary ? null : match.id;
    }

    // Process the batch with bounded concurrency (max 5 files in flight at
    // once). Sequential was the direct cause of Cloudflare 524 timeouts on
    // large SF batches: 4-5 big link CSVs (6000+ rows each) pushed a 25-file
    // batch past CF's 100s origin response window even though no single file
    // was slow. Parallel makes the batch bounded by the SLOWEST file, not
    // the sum. The concurrency cap (5) prevents 50x simultaneous turso.batch
    // round-trips from saturating the remote libsql connection — all files
    // are processed, just with at most 5 running at a time.
    //
    // Class-A parsers (supersede-class) now run atomically inside a single
    // turso.batch transaction per file (Task 8), so same-key races are
    // impossible. Class-B parsers self-dedup by key. The old multi-retry
    // backoff in ingestWithRetry has been removed; the wrapper is a
    // single-attempt pass-through.
    //
    // processOne can return a single result OR an array (for ZIPs that fan
    // out to multiple CSV uploads); flatten so the UI gets one chip per
    // ingested CSV. mapLimit returns the same settled shape as
    // Promise.allSettled so the result-aggregation loop below is unchanged.
    const batchStart = Date.now();
    const settled = await mapLimit(
      files,
      5,
      (file) => processOne(file, clientId, month, userId, userName, siteId),
    );
    // Timing instrumentation: surfaces per-batch wall time in the DO run logs
    // so a future 504/524 can be measured (is it the parse, or per-batch
    // overhead?) instead of guessed. Cloudflare's origin window is ~100s.
    logger.info(`[csv-upload] batch of ${files.length} file(s) ingested in ${Date.now() - batchStart}ms (client ${clientId})`);
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

    // Coverage recompute, hoisted out of the per-file ingest path (ingestCSV was
    // called with deferCoverage=true). recomputeCategoryCoverage aggregates the
    // FULL (client, month, category) table state and upserts on that key, so
    // running it ONCE per touched category here is byte-identical to the old
    // once-per-file behavior — but a 30-file SF batch no longer fires 30 separate
    // client-wide COUNT scans. (Combined with migration 074's (client_id, month)
    // indexes, this is the fix for the data-heavy-client 524 timeouts: before,
    // every file re-scanned the client's entire link_graph/crawl_urls history.)
    // One representative upload_id per category is recorded for provenance.
    const touchedCategories = new Map<string, string>();
    for (const r of results) {
      if (r.error || !r.format || !r.upload_id) continue;
      const cat = FORMAT_TO_CATEGORY[r.format];
      if (cat && !touchedCategories.has(cat)) touchedCategories.set(cat, r.upload_id);
    }
    for (const [category, repUploadId] of touchedCategories) {
      try {
        await recomputeCategoryCoverage(turso, clientId, month, category, 'csv_upload', repUploadId);
      } catch (coverageErr: any) {
        // Never fail the upload on a coverage-recompute error — the file data is
        // already committed (same guard the per-file path used).
        logger.error(`[csv-upload] coverage recompute failed for ${category} (data committed OK)`, coverageErr);
      }
    }

    // client_sites auto-bind (syncDetectedDomains + syncPerSitePageCounts) used
    // to run HERE, once per batch. Both scan the client's entire crawl_urls set,
    // so running them once PER BATCH (~13x for a 128-file upload) piled per-batch
    // overhead onto Cloudflare's ~100s window and was a direct cause of the
    // 504/524 timeouts that grew with the client's dataset. They now run ONCE
    // after the whole upload via POST /portal/api/admin/csv/post-upload-sync,
    // which the client calls when its batch loop finishes. Identical end result,
    // no per-batch tax.

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
