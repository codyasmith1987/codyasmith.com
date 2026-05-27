// One-time diagnostic: returns the actual column lists for every
// table this session's PRs touched, plus the applied-migrations
// list. Used to audit prod schema state after the backfill SQL
// error (no such column at offset 75) showed prod has historical
// schema drift vs what the code expects.
//
// Admin-only GET. Will be deleted after audit closes.

import type { APIRoute } from 'astro';
import turso from '../../../../lib/turso';

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

  return json({ ok: true, schema: result });
};
