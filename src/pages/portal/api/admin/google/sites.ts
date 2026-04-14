// GET /portal/api/admin/google/sites?connection_id=X
//
// Lists the Search Console properties this connection can access.
// Used by the admin UI to let Cody pick a property to attach to a
// data_source_bindings row.

import type { APIRoute } from 'astro';
import { getConnectionById, getValidAccessToken } from '../../../../../lib/google/connections';
import { realGscClient } from '../../../../../lib/google/gsc';
import { logger } from '../../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals, url }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  const connectionId = url.searchParams.get('connection_id');
  if (!connectionId) return json({ error: 'connection_id required' }, 400);

  const conn = await getConnectionById(connectionId);
  if (!conn) return json({ error: 'connection not found' }, 404);
  if (conn.admin_user_id !== locals.user!.id) {
    return json({ error: 'connection belongs to a different admin' }, 403);
  }

  try {
    const accessToken = await getValidAccessToken(connectionId);
    const sites = await realGscClient.listSites(accessToken);
    return json({ sites });
  } catch (err) {
    logger.error('google sites error', err);
    return json({ error: String((err as Error)?.message ?? err) }, 500);
  }
};
