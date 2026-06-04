// Admin endpoint: set a client's billing recipients.
//
// POST { client_id, primary_contact_email?, billing_cc_email? }
//
// primary_contact_email is who invoices and payment notices are addressed to.
// billing_cc_email is an accountant/bookkeeper CC'd on financial documents
// only. Both ride on client_metadata. An empty string CLEARS a field; an
// absent field is left unchanged (upsertClientMetadata uses COALESCE, so it
// distinguishes "" from undefined). See src/lib/invoice-emails.ts for how
// these resolve into a send.

import type { APIRoute } from 'astro';
import { getClientById } from '../../../../../lib/auth';
import { getClientMetadata, upsertClientMetadata } from '../../../../../lib/agreements';
import { logger } from '../../../../../lib/logger';
import { logActivity } from '../../../../../lib/activity';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  let body: any;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const clientId = (body?.client_id || '').toString().trim();
  if (!clientId) return json({ error: 'client_id is required' }, 400);

  const client = await getClientById(clientId);
  if (!client) return json({ error: 'Client not found' }, 404);

  // Build the partial update: present-and-empty clears, absent leaves alone.
  const update: { client_id: string; primary_contact_email?: string; billing_cc_email?: string } = { client_id: clientId };
  const changes: string[] = [];

  if (body.primary_contact_email !== undefined) {
    const v = (body.primary_contact_email ?? '').toString().trim();
    if (v && !EMAIL_RE.test(v)) return json({ error: 'Primary contact email is not a valid email address' }, 400);
    update.primary_contact_email = v; // '' clears
    changes.push('primary contact');
  }

  if (body.billing_cc_email !== undefined) {
    const v = (body.billing_cc_email ?? '').toString().trim();
    if (v && !EMAIL_RE.test(v)) return json({ error: 'Accountant CC email is not a valid email address' }, 400);
    update.billing_cc_email = v; // '' clears
    changes.push('accountant CC');
  }

  if (changes.length === 0) return json({ error: 'Nothing to update' }, 400);

  try {
    const meta = await upsertClientMetadata(update);
    await logActivity({
      clientId,
      userId: locals.user!.id,
      action: 'updated',
      entityType: 'client',
      entityId: clientId,
      summary: `${locals.user!.name} updated billing recipients (${changes.join(', ')})`,
    });
    return json({
      ok: true,
      primary_contact_email: meta.primary_contact_email,
      billing_cc_email: meta.billing_cc_email,
    });
  } catch (err: any) {
    logger.error('Set billing contacts failed', err);
    return json({ error: 'Failed to save billing recipients' }, 500);
  }
};

export const GET: APIRoute = async ({ locals, url }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);
  const clientId = (url.searchParams.get('client') || '').trim();
  if (!clientId) return json({ error: 'client is required' }, 400);
  const meta = await getClientMetadata(clientId).catch(() => null);
  return json({
    primary_contact_email: meta?.primary_contact_email ?? null,
    billing_cc_email: meta?.billing_cc_email ?? null,
  });
};
