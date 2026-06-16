// READ-ONLY cross-site attribution diagnostic. Admin-only GET. No writes.
//
// Answers the post-MVP-upload audit's prod-check questions for a multi-site
// client (default: Zip Kit Homes = zipkithomes.com [ZKH] + mountainvalleyprefab.com
// [MVP]): did the MVP crawl upload overwrite ZKH's June `metrics` / `site_issues`
// rows? Those aggregate tables upsert on (client_id, month, key) with NO site_id,
// so a second site's crawl_overview/issues can re-point shared keys to its own
// upload — destructive cross-site supersession. This endpoint reveals it by
// resolving every metric/issue row's owning csv_upload back to its site.
//
// Query params: ?client=<id or name-substring> (default "Zip Kit"), ?month=YYYY-MM
// (default 2026-06). Will be deleted after the audit closes.

import type { APIRoute } from 'astro';
import turso from '../../../../lib/turso';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals, url }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  const clientQ = (url.searchParams.get('client') || 'Zip Kit').trim();
  const month = (url.searchParams.get('month') || '2026-06').trim();

  // Resolve client (by exact id first, then name substring).
  const cli = await turso.execute({
    sql: `SELECT id, name FROM clients WHERE id = ? OR name LIKE ? ORDER BY name LIMIT 1`,
    args: [clientQ, `%${clientQ}%`],
  });
  if (cli.rows.length === 0) return json({ error: `no client matching "${clientQ}"` }, 404);
  const clientId = cli.rows[0][0] as string;
  const clientName = cli.rows[0][1] as string;

  const out: Record<string, any> = { client: { id: clientId, name: clientName }, month };

  // (A/E) Sites: primary flag + page_count. Build site_id -> domain map.
  const sites = await turso.execute({
    sql: `SELECT id, domain, is_primary, is_managed, page_count FROM client_sites WHERE client_id = ? ORDER BY is_primary DESC, domain`,
    args: [clientId],
  });
  const siteById = new Map<string, string>();
  out.sites = (sites.rows as any[]).map(r => {
    siteById.set(r[0] as string, r[1] as string);
    return { id: r[0], domain: r[1], is_primary: !!r[2], is_managed: !!r[3], page_count: r[4] };
  });
  const domainFor = (siteId: string | null) => siteId ? (siteById.get(siteId) || `?${siteId}`) : '(primary/NULL)';

  // (B) Uploads this month, by site + format.
  const ups = await turso.execute({
    sql: `SELECT site_id, detected_format, COUNT(*) n, SUM(CASE WHEN error IS NULL THEN 1 ELSE 0 END) live
          FROM csv_uploads WHERE client_id = ? AND month = ?
          GROUP BY site_id, detected_format ORDER BY site_id, detected_format`,
    args: [clientId, month],
  });
  out.uploads_by_site_format = (ups.rows as any[]).map(r => ({
    site: domainFor(r[0] as string | null), format: r[1], total: r[2], live: r[3],
  }));

  // (C-metrics) THE KEY CHECK: who owns each metrics category this month?
  // If ZKH had June crawl metrics and MVP's upload now owns them, overwrite happened.
  const met = await turso.execute({
    sql: `SELECT m.category, u.site_id, COUNT(*) rows, COUNT(DISTINCT m.metric_key) keys,
                 MIN(u.original_name) sample_file
          FROM metrics m JOIN csv_uploads u ON u.id = m.csv_upload_id
          WHERE m.client_id = ? AND m.month = ?
          GROUP BY m.category, u.site_id ORDER BY m.category, u.site_id`,
    args: [clientId, month],
  });
  out.metrics_ownership = (met.rows as any[]).map(r => ({
    category: r[0], owned_by_site: domainFor(r[1] as string | null),
    metric_rows: r[2], distinct_keys: r[3], sample_file: r[4],
  }));
  // Orphaned metrics whose csv_upload_id no longer resolves (deleted upload).
  const metOrphan = await turso.execute({
    sql: `SELECT COUNT(*) FROM metrics m WHERE m.client_id = ? AND m.month = ?
          AND m.csv_upload_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM csv_uploads u WHERE u.id = m.csv_upload_id)`,
    args: [clientId, month],
  });
  out.metrics_orphaned_upload_ref = metOrphan.rows[0][0];

  // (C-issues) who owns each site_issue this month?
  const iss = await turso.execute({
    sql: `SELECT u.site_id, COUNT(*) issues, GROUP_CONCAT(DISTINCT i.issue_name) names
          FROM site_issues i JOIN csv_uploads u ON u.id = i.csv_upload_id
          WHERE i.client_id = ? AND i.month = ?
          GROUP BY u.site_id ORDER BY u.site_id`,
    args: [clientId, month],
  });
  out.site_issues_ownership = (iss.rows as any[]).map(r => ({
    owned_by_site: domainFor(r[0] as string | null), issue_count: r[1],
    issue_names: String(r[2] || '').split(',').slice(0, 40),
  }));

  // (D) link source_file that risked the 0-row-wipes-15-row collision.
  const lg = await turso.execute({
    sql: `SELECT source_file, COUNT(*) FROM link_graph
          WHERE client_id = ? AND month = ? AND source_file LIKE 'links_internal_outlinks%'
          GROUP BY source_file`,
    args: [clientId, month],
  });
  out.link_collision_check = (lg.rows as any[]).map(r => ({ source_file: r[0], rows: r[1] }));

  // (F) Does MVP have signal-category uploads this month (decides data_coverage gap urgency)?
  const sig = await turso.execute({
    sql: `SELECT site_id, detected_format, COUNT(*) FROM csv_uploads
          WHERE client_id = ? AND month = ?
          AND detected_format IN ('accessibility','content_urls','structured_data_urls')
          GROUP BY site_id, detected_format`,
    args: [clientId, month],
  });
  out.signal_uploads_by_site = (sig.rows as any[]).map(r => ({
    site: domainFor(r[0] as string | null), format: r[1], count: r[2],
  }));

  return json({ ok: true, ...out });
};
