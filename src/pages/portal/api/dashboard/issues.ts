import type { APIRoute } from 'astro';
import turso from '../../../../lib/turso';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// Reads from issue_snapshots joined to periods. Collapses by issue_name
// across sources (issues_overview + site_audit may both report the same
// issue) using MAX(affected_urls) to keep the more detailed row.

export const GET: APIRoute = async ({ locals, url }) => {
  if (!locals.user) return json({ error: 'Unauthorized' }, 401);

  const clientId = locals.user.role === 'admin'
    ? (url.searchParams.get('client_id') || null)
    : locals.user.client_id;

  if (!clientId) return json({ error: 'No client specified' }, 400);

  // Latest period with any issue data.
  const periodResult = await turso.execute({
    sql: `SELECT p.id, SUBSTR(p.period_start, 1, 7) AS month_label
          FROM periods p
          WHERE p.client_id = ?
            AND EXISTS (SELECT 1 FROM issue_snapshots i WHERE i.period_id = p.id)
          ORDER BY p.period_start DESC
          LIMIT 1`,
    args: [clientId],
  });

  if (periodResult.rows.length === 0) {
    return json({ month: null, issues: [] });
  }

  const periodId = periodResult.rows[0][0] as string;
  const month = periodResult.rows[0][1] as string;

  const result = await turso.execute({
    sql: `SELECT issue_name, issue_type, priority,
                 MAX(affected_urls) AS affected_urls,
                 MAX(pct_of_total) AS pct_of_total,
                 description, how_to_fix
          FROM issue_snapshots
          WHERE client_id = ? AND period_id = ?
          GROUP BY issue_name
          ORDER BY affected_urls DESC`,
    args: [clientId, periodId],
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
