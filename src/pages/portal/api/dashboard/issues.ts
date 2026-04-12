import type { APIRoute } from 'astro';
import turso from '../../../../lib/turso';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals, url }) => {
  if (!locals.user) return json({ error: 'Unauthorized' }, 401);

  const clientId = locals.user.role === 'admin'
    ? (url.searchParams.get('client_id') || null)
    : locals.user.client_id;

  if (!clientId) return json({ error: 'No client specified' }, 400);

  // Get latest month
  const monthResult = await turso.execute({
    sql: 'SELECT DISTINCT month FROM site_issues WHERE client_id = ? ORDER BY month DESC LIMIT 1',
    args: [clientId],
  });

  if (monthResult.rows.length === 0) {
    return json({ month: null, issues: [] });
  }

  const month = monthResult.rows[0][0] as string;

  // Deduplicate issues by name — when multiple tools report the same issue,
  // keep the entry with the most affected URLs (usually the more detailed source)
  const result = await turso.execute({
    sql: `SELECT issue_name, issue_type, priority, MAX(affected_urls) as affected_urls, MAX(pct_of_total) as pct_of_total, description, how_to_fix
          FROM site_issues
          WHERE client_id = ? AND month = ?
          GROUP BY issue_name
          ORDER BY affected_urls DESC`,
    args: [clientId, month],
  });

  const issues = result.rows.map(row => ({
    issue_name: row[0] as string,
    issue_type: row[1] as string | null,
    priority: row[2] as string | null,
    affected_urls: row[3] as number | null,
    pct_of_total: row[4] as number | null,
    description: row[5] as string | null,
    how_to_fix: row[6] as string | null,
  }));

  return json({ month, issues });
};
