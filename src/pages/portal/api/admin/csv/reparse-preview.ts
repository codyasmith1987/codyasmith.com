// READ-ONLY diagnostic: run the CURRENT detector over every raw_csv_data row
// and report what it classifies each stored file as — WITHOUT ingesting or
// writing anything. This is how we tell, from prod, whether a stored file
// would now retype (has a parser) or is genuinely still unknown, instead of
// inferring it from a local repro that may not match prod.
//
// GET, admin-only. No mutations. Safe to call anytime.

import type { APIRoute } from 'astro';
import turso from '../../../../../lib/turso';
import { logger } from '../../../../../lib/logger';
import { detectFormat } from '../../../../../lib/csv/detector';

export const prerender = false;

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

    return json({
      ok: true,
      total_raw_rows: res.rows.length,
      empty_raw_text_rows: emptyRaw,
      would_retype: wouldRetype,
      still_unknown: byFormat['unknown']?.count || 0,
      by_detected_format: byFormat,
    });
  } catch (err: any) {
    logger.error('reparse-preview error', err);
    return json({ error: err?.message || 'reparse-preview failed' }, 500);
  }
};
