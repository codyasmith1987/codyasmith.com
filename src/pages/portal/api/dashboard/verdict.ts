import type { APIRoute } from 'astro';
import { generateOverviewVerdict } from '../../../../lib/client-narrator';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// GET — returns the single-sentence overview verdict for a client.
// Clients get their own; admin can override with ?client_id=X for
// "view as client" previewing (slice 2 wires a real admin action).
export const GET: APIRoute = async ({ locals, url }) => {
  if (!locals.user) return json({ error: 'Unauthorized' }, 401);
  const clientId =
    locals.user.role === 'admin'
      ? url.searchParams.get('client_id') || null
      : locals.user.client_id;
  if (!clientId) return json({ error: 'No client specified' }, 400);
  const result = await generateOverviewVerdict(clientId);
  return json(result);
};
