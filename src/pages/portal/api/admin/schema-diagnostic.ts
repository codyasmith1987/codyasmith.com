// One-time diagnostic: returns the actual column lists for every
// table this session's PRs touched, plus the applied-migrations
// list. Used to audit prod schema state after the backfill SQL
// error (no such column at offset 75) showed prod has historical
// schema drift vs what the code expects.
//
// Admin-only GET. Will be deleted after audit closes.

import type { APIRoute } from 'astro';
import turso from '../../../../lib/turso';
import { getClientDomainsFromData } from '../../../../lib/client-domains';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { 'Content-Type': 'application/json' } });

const TABLES = [
  'clients',
  'client_sites',
  'client_agreements',
  'snippet_overrides',
  'snippet_overrides_v2',
  'lead_personas',
  'csv_uploads',
  'raw_csv_data',
  'crawl_urls',
  'keyword_rankings',
];

export const GET: APIRoute = async ({ locals }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  const result: Record<string, any> = {};

  for (const table of TABLES) {
    try {
      const cols = await turso.execute(`PRAGMA table_info(${table})`);
      result[table] = (cols.rows as any[]).map(r => ({
        name: r[1] as string,
        type: r[2] as string,
        notnull: r[3] as number,
        dflt: r[4],
        pk: r[5] as number,
      }));
    } catch (err: any) {
      result[table] = { error: err?.message || 'query failed' };
    }
  }

  try {
    const migs = await turso.execute('SELECT id, applied_at FROM _migrations ORDER BY id');
    result._migrations = (migs.rows as any[]).map(r => ({ id: r[0] as string, applied_at: r[1] as string }));
  } catch (err: any) {
    result._migrations = { error: err?.message || 'query failed' };
  }

  // Per-client row counts: tells us if the backfill found nothing
  // because there's no data to find, vs because the sync function
  // has a bug.
  const counts: any[] = [];
  try {
    const clients = await turso.execute('SELECT id, name FROM clients ORDER BY name');
    for (const row of clients.rows as any[]) {
      const id = row[0] as string;
      const name = row[1] as string;
      const stats: any = { client: name, client_id: id };
      try {
        const uploads = await turso.execute({
          sql: 'SELECT COUNT(*) FROM csv_uploads WHERE client_id = ?',
          args: [id],
        });
        stats.csv_uploads_total = uploads.rows[0]?.[0];
      } catch (e: any) { stats.csv_uploads_error = e?.message; }
      try {
        const formats = await turso.execute({
          sql: `SELECT detected_format, COUNT(*) FROM csv_uploads
                WHERE client_id = ?
                GROUP BY detected_format
                ORDER BY COUNT(*) DESC`,
          args: [id],
        });
        stats.csv_uploads_by_format = (formats.rows as any[]).map(r => ({
          format: r[0],
          count: r[1],
        }));
      } catch (e: any) { stats.csv_formats_error = e?.message; }
      try {
        const raw = await turso.execute({
          sql: 'SELECT COUNT(*) FROM raw_csv_data WHERE client_id = ?',
          args: [id],
        });
        stats.raw_csv_data_total = raw.rows[0]?.[0];
      } catch (e: any) { stats.raw_csv_data_error = e?.message; }
      try {
        const rawFiles = await turso.execute({
          sql: `SELECT filename, row_count FROM raw_csv_data
                WHERE client_id = ?
                ORDER BY created_at DESC
                LIMIT 10`,
          args: [id],
        });
        stats.raw_csv_sample_files = (rawFiles.rows as any[]).map(r => ({
          filename: r[0],
          row_count: r[1],
        }));
      } catch (e: any) { stats.raw_csv_files_error = e?.message; }
      try {
        const crawl = await turso.execute({
          sql: 'SELECT COUNT(*) as total, COUNT(DISTINCT hostname) as hosts FROM crawl_urls WHERE client_id = ?',
          args: [id],
        });
        stats.crawl_urls_total = crawl.rows[0]?.[0];
        stats.crawl_urls_distinct_hosts = crawl.rows[0]?.[1];
      } catch (e: any) { stats.crawl_urls_error = e?.message; }
      try {
        const kw = await turso.execute({
          sql: 'SELECT COUNT(*) as total FROM keyword_rankings WHERE client_id = ?',
          args: [id],
        });
        stats.keyword_rankings_total = kw.rows[0]?.[0];
      } catch (e: any) { stats.keyword_rankings_error = e?.message; }
      try {
        const sites = await turso.execute({
          sql: 'SELECT COUNT(*) as total FROM client_sites WHERE client_id = ?',
          args: [id],
        });
        stats.client_sites_total = sites.rows[0]?.[0];
      } catch (e: any) { stats.client_sites_error = e?.message; }
      try {
        const hostList = await turso.execute({
          sql: 'SELECT DISTINCT hostname FROM crawl_urls WHERE client_id = ? LIMIT 10',
          args: [id],
        });
        stats.detected_hostnames = (hostList.rows as any[]).map(r => r[0]);
      } catch (e: any) { stats.hostnames_error = e?.message; }
      try {
        stats.derived_domains = await getClientDomainsFromData(id);
      } catch (e: any) { stats.derived_domains_error = e?.message; }
      counts.push(stats);
    }
  } catch (e: any) {
    result._counts_error = e?.message;
  }
  result._per_client_counts = counts;

  return json({ ok: true, schema: result });
};
