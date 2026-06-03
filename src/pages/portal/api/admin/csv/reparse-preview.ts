// READ-ONLY diagnostic: run the CURRENT detector over every raw_csv_data row
// and report what it classifies each stored file as — WITHOUT ingesting or
// writing anything. This is how we tell, from prod, whether a stored file
// would now retype (has a parser) or is genuinely still unknown, instead of
// inferring it from a local repro that may not match prod.
//
// GET, admin-only. No mutations. Safe to call anytime.

import type { APIRoute } from 'astro';
import { nanoid } from 'nanoid';
import turso from '../../../../../lib/turso';
import { logger } from '../../../../../lib/logger';
import { detectFormat } from '../../../../../lib/csv/detector';
import { buildCanonicalUrlsStatements } from '../../../../../lib/csv/parsers/canonical-urls';
import { buildDirectiveUrlsStatements } from '../../../../../lib/csv/parsers/directive-urls';
import { buildPageWeightUrlsStatements } from '../../../../../lib/csv/parsers/page-weight-urls';
import { buildSitemapUrlsStatements } from '../../../../../lib/csv/parsers/sitemap-urls';

export const prerender = false;

// Build the statements for one of the 4 new Class-A formats so the dry-run probe
// can replay the exact ingest the reparse would do.
const BUILDERS: Record<string, (raw: string, c: string, m: string, u: string) => Array<{ sql: string; args: any[] }>> = {
  canonicals: buildCanonicalUrlsStatements,
  directives: buildDirectiveUrlsStatements,
  page_weight: buildPageWeightUrlsStatements,
  sitemap_urls: buildSitemapUrlsStatements,
};

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const res = await turso.execute(
      `SELECT client_id, month, filename, raw_text, length(raw_text) AS raw_len
       FROM raw_csv_data
       ORDER BY created_at`,
    );

    // Tally detected format across all stored rows, plus a per-(format) sample
    // of filenames so we can see exactly which files route where.
    const byFormat: Record<string, { count: number; sampleFiles: string[] }> = {};
    let emptyRaw = 0;
    for (const row of res.rows as any[]) {
      const filename = String(row.filename);
      const rawText = row.raw_text == null ? '' : String(row.raw_text);
      const rawLen = Number(row.raw_len) || 0;
      if (rawLen === 0) emptyRaw++;
      let format = 'DETECT_THREW';
      try {
        format = detectFormat(rawText, filename).format;
      } catch (e: any) {
        format = `DETECT_THREW: ${e?.message || e}`;
      }
      if (!byFormat[format]) byFormat[format] = { count: 0, sampleFiles: [] };
      byFormat[format].count++;
      if (byFormat[format].sampleFiles.length < 6) {
        byFormat[format].sampleFiles.push(`${filename} [${rawLen}b]`);
      }
    }

    const typedFormats = Object.keys(byFormat).filter(f => f !== 'unknown' && !f.startsWith('DETECT_THREW'));
    const wouldRetype = typedFormats.reduce((s, f) => s + byFormat[f].count, 0);

    // DRY-RUN PROBE: for one sample row per new-format, replay the exact ingest
    // (upload-row insert + parser inserts) inside a transaction that ROLLS BACK,
    // so we capture the real prod error WITHOUT persisting anything. This is how
    // we learn why the live reparse retyped zero despite detection succeeding.
    const probe: Array<{ format: string; file: string; result: string }> = [];
    for (const fmt of Object.keys(BUILDERS)) {
      // First stored row that detects as this format.
      const row = (res.rows as any[]).find(r => {
        try { return detectFormat(String(r.raw_text ?? ''), String(r.filename)).format === fmt; }
        catch { return false; }
      });
      if (!row) { probe.push({ format: fmt, file: '(none stored)', result: 'no sample' }); continue; }
      const filename = String(row.filename);
      const uploadId = nanoid();
      let tx: any = null;
      try {
        const stmts = BUILDERS[fmt](String(row.raw_text), String(row.client_id), String(row.month), uploadId);
        tx = await turso.transaction('write');
        await tx.execute({
          sql: 'INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)',
          args: [uploadId, String(row.client_id), filename, fmt, String(row.month), 'reparse-preview-dryrun'],
        });
        for (const s of stmts) await tx.execute(s);
        await tx.rollback(); // discard — read-only
        probe.push({ format: fmt, file: filename, result: `OK (${stmts.length} rows would insert)` });
      } catch (e: any) {
        try { if (tx) await tx.rollback(); } catch { /* noop */ }
        probe.push({ format: fmt, file: filename, result: `THREW: ${e?.message || e}` });
      }
    }

    return json({
      ok: true,
      total_raw_rows: res.rows.length,
      empty_raw_text_rows: emptyRaw,
      would_retype: wouldRetype,
      still_unknown: byFormat['unknown']?.count || 0,
      by_detected_format: byFormat,
      dry_run_probe: probe,
    });
  } catch (err: any) {
    logger.error('reparse-preview error', err);
    return json({ error: err?.message || 'reparse-preview failed' }, 500);
  }
};
