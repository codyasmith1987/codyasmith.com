import type { APIRoute } from 'astro';
import { toggleClientActive } from '../../../../lib/auth';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const { client_id } = await request.json();
    if (!client_id) return json({ error: 'client_id is required' }, 400);

    const active = await toggleClientActive(client_id);
    return json({ client_id, active });
  } catch (err: any) {
    console.error('Toggle client error:', err);
    return json({ error: err.message || 'Failed to toggle client' }, 500);
  }
};
