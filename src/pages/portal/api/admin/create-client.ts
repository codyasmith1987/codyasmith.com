import type { APIRoute } from 'astro';
import { createClient } from '../../../../lib/auth';
import { logger } from '../../../../lib/logger';
import { logActivity } from '../../../../lib/activity';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const { name, slug, domain } = await request.json();

    if (!name?.trim() || !slug?.trim()) {
      return json({ error: 'Name and slug are required' }, 400);
    }

    if (!/^[a-z0-9-]+$/.test(slug.trim())) {
      return json({ error: 'Slug must be lowercase letters, numbers, and hyphens only' }, 400);
    }

    // Domain is optional at create time. The research endpoint and
    // future Schedule A site rows key off it; admin can also set it
    // later. If supplied, validate shape (host.tld, no protocol).
    let domainClean: string | null = null;
    if (typeof domain === 'string' && domain.trim()) {
      const d = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) {
        return json({ error: 'Domain must look like example.com (no protocol, no path)' }, 400);
      }
      domainClean = d;
    }

    const id = await createClient(name.trim(), slug.trim(), domainClean);

    await logActivity({
      clientId: id,
      userId: locals.user!.id,
      action: 'created',
      entityType: 'client',
      entityId: id,
      summary: `${locals.user!.name} created client "${name.trim()}"`,
    });

    return json({ id, name: name.trim(), slug: slug.trim() });
  } catch (err: any) {
    if (err.message?.includes('UNIQUE constraint')) {
      return json({ error: 'A client with that slug already exists' }, 409);
    }
    logger.error('Create client error', err);
    return json({ error: 'Failed to create client' }, 500);
  }
};
