// READ-ONLY diagnostic: run the CURRENT detector over every raw_csv_data row
// and report, from PROD, exactly what is going on with the stored-file backfill
// WITHOUT ingesting or writing anything. Every probe runs inside a transaction
// that is rolled back, so nothing persists. GET, admin-only.
//
// It answers four questions that a single-sample probe could not:
//   1. prod_schema      — the ACTUAL CREATE TABLE sql in prod (FK declarations
//                          may differ from the migration files).
//   2. raw_by_client    — which client_ids in raw_csv_data are orphaned
//                          (reference a clients row that no longer exists).
//   3. unknown_files    — the COMPLETE distinct list of file types that have no
//                          parser yet (the real "parse everything" gap).
//   4. would_retype_probe — for EVERY row that now detects to a typed format,
//                          a dry-run insert recording client_exists + the exact
//                          result, so orphaned-test junk is separated from a
//                          genuine systemic FK bug.

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

const BUILDERS: Record<string, (raw: string, c: string, m: string, u: string) => Array<{ sql: string; args: any[] }>> = {
  canonicals: buildCanonicalUrlsStatements,
  directives: buildDirectiveUrlsStatements,
  page_weight: buildPageWeightUrlsStatements,
  sitemap_urls: buildSitemapUrlsStatements,
};

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { 'Content-Type': 'application/json' } });

// Strip any folder prefix and lowercase, so "Screaming frog scrape june 1/ai_all.csv"
// and "ai_all.csv" collapse to one type for the unparsed-type tally.
const normName = (f: string) => f.split('/').pop()!.split('\\').pop()!.trim().toLowerCase();

export const GET: APIRoute = async ({ locals }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);
  // uploaded_by is a NOT NULL FK to users(id); the dry-run probe must use a
  // real user id (the requesting admin) or the csv_uploads insert fails the
  // FK for an unrelated reason and masks whether the parser rows are valid.
  const adminId = locals.user!.id;

  try {
    // 1. Real prod schema for the tables involved in the FK chain.
    const schemaRes = await turso.execute(
      `SELECT name, sql FROM sqlite_master WHERE type='table' AND name IN
         ('clients','csv_uploads','canonical_urls','directive_urls','page_weight_urls','sitemap_urls','content_urls')`,
    );
    const prod_schema: Record<string, string> = {};
    for (const r of schemaRes.rows as any[]) prod_schema[String(r.name)] = String(r.sql);

    // PRAGMA state — is FK enforcement even on for this connection?
    let foreign_keys_pragma: any = null;
    try { foreign_keys_pragma = (await turso.execute('PRAGMA foreign_keys')).rows[0]; } catch { /* noop */ }

    // 2. Orphan check: every distinct client_id in raw_csv_data + whether it
    //    still exists in clients.
    const rbcRes = await turso.execute(
      `SELECT r.client_id AS client_id, COUNT(*) AS n,
              (SELECT COUNT(*) FROM clients c WHERE c.id = r.client_id) AS client_exists
       FROM raw_csv_data r GROUP BY r.client_id ORDER BY n DESC`,
    );
    const raw_by_client = (rbcRes.rows as any[]).map(r => ({
      client_id: String(r.client_id),
      rows: Number(r.n) || 0,
      client_exists: Number(r.client_exists) > 0,
    }));
    const existingClients = new Set(raw_by_client.filter(c => c.client_exists).map(c => c.client_id));

    // Pull every stored row once.
    const res = await turso.execute(
      `SELECT client_id, month, filename, raw_text, length(raw_text) AS raw_len
       FROM raw_csv_data ORDER BY created_at`,
    );
    const rows = res.rows as any[];

    // Tally detected format + 3. complete unparsed-type enumeration.
    const byFormat: Record<string, number> = {};
    const unknown_files: Record<string, number> = {};
    let emptyRaw = 0;
    for (const row of rows) {
      const filename = String(row.filename);
      const rawText = row.raw_text == null ? '' : String(row.raw_text);
      if ((Number(row.raw_len) || 0) === 0) emptyRaw++;
      let format = 'unknown';
      try { format = detectFormat(rawText, filename).format; }
      catch (e: any) { format = `DETECT_THREW: ${e?.message || e}`; }
      byFormat[format] = (byFormat[format] || 0) + 1;
      if (format === 'unknown') {
        const k = normName(filename);
        unknown_files[k] = (unknown_files[k] || 0) + 1;
      }
    }
    const unknown_files_sorted = Object.entries(unknown_files)
      .sort((a, b) => b[1] - a[1])
      .map(([file, count]) => ({ file, count }));

    const typedFormats = Object.keys(byFormat).filter(f => f !== 'unknown' && !f.startsWith('DETECT_THREW'));
    const wouldRetype = typedFormats.reduce((s, f) => s + byFormat[f], 0);

    // 4. Per-row dry-run probe for EVERY would-retype row. Separates orphaned
    //    client_id (data problem) from a genuine systemic FK bug.
    const would_retype_probe: Array<{
      format: string; file: string; client_id: string; client_exists: boolean; result: string;
    }> = [];
    // One probe per format only. Each probe is an interactive transaction
    // (round-trips to remote Turso); probing all 45 rows blows past
    // Cloudflare's 100s window AND the DO gateway timeout. One sample per
    // format is enough to prove the insert path for that format.
    const probedFormats = new Set<string>();
    for (const row of rows) {
      const filename = String(row.filename);
      const rawText = String(row.raw_text ?? '');
      let fmt = 'unknown';
      try { fmt = detectFormat(rawText, filename).format; } catch { continue; }
      if (!BUILDERS[fmt]) continue;
      if (probedFormats.has(fmt)) continue;
      probedFormats.add(fmt);

      const clientId = String(row.client_id);
      const clientExists = existingClients.has(clientId);
      const uploadId = nanoid();
      let tx: any = null;
      let result = '';
      try {
        const stmts = BUILDERS[fmt](rawText, clientId, String(row.month), uploadId);
        tx = await turso.transaction('write');
        // Isolate which insert fails: the csv_uploads row first (FK on its
        // client_id), then the parser rows (FK on their client_id +
        // csv_upload_id).
        await tx.execute({
          sql: 'INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)',
          args: [uploadId, clientId, filename, fmt, String(row.month), adminId],
        });
        let stage = 'csv_uploads OK';
        try {
          for (const s of stmts) await tx.execute(s);
          stage = `OK (${stmts.length} rows would insert)`;
        } catch (e: any) {
          stage = `PARSER-ROWS FAILED: ${e?.message || e}`;
        }
        await tx.rollback();
        result = stage;
      } catch (e: any) {
        try { if (tx) await tx.rollback(); } catch { /* noop */ }
        result = `CSV_UPLOADS-INSERT FAILED: ${e?.message || e}`;
      }
      would_retype_probe.push({ format: fmt, file: normName(filename), client_id: clientId, client_exists: clientExists, result });
    }

    // Live row counts of the typed tables the backfill writes into, so the
    // backfill result can be verified read-only (counts go up after a run).
    const typed_counts: Record<string, number> = {};
    for (const t of ['canonical_urls', 'directive_urls', 'page_weight_urls', 'sitemap_urls',
      'javascript_urls', 'url_structure_urls', 'hreflang_urls', 'sf_export_rows', 'site_issue_urls']) {
      try {
        const c = await turso.execute(`SELECT COUNT(*) AS n FROM ${t}`);
        typed_counts[t] = Number((c.rows[0] as any).n) || 0;
      } catch (e: any) {
        typed_counts[t] = -1;
      }
    }

    return json({
      ok: true,
      total_raw_rows: rows.length,
      typed_counts,
      empty_raw_text_rows: emptyRaw,
      would_retype: wouldRetype,
      still_unknown: byFormat['unknown'] || 0,
      foreign_keys_pragma,
      raw_by_client,
      by_detected_format: byFormat,
      unparsed_types_count: unknown_files_sorted.length,
      unknown_files: unknown_files_sorted,
      would_retype_probe,
      prod_schema,
    });
  } catch (err: any) {
    logger.error('reparse-preview error', err);
    return json({ error: err?.message || 'reparse-preview failed' }, 500);
  }
};
