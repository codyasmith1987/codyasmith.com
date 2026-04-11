import type { APIRoute } from 'astro';
import { createClient } from '../../../../lib/auth';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const { name, slug } = await request.json();

    if (!name?.trim() || !slug?.trim()) {
      return json({ error: 'Name and slug are required' }, 400);
    }

    if (!/^[a-z0-9-]+$/.test(slug.trim())) {
      return json({ error: 'Slug must be lowercase letters, numbers, and hyphens only' }, 400);
    }

    const id = await createClient(name.trim(), slug.trim());
    return json({ id, name: name.trim(), slug: slug.trim() });
  } catch (err: any) {
    if (err.message?.includes('UNIQUE constraint')) {
      return json({ error: 'A client with that slug already exists' }, 409);
    }
    console.error('Create client error:', err);
    return json({ error: 'Failed to create client' }, 500);
  }
};
