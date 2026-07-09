// Admin endpoint: set a client's billing recipients.
//
// POST { client_id, primary_contact_email?, billing_cc_email? }
//
// primary_contact_email is who invoices and payment notices are addressed to.
// billing_cc_email is an accountant/bookkeeper CC'd on financial documents
// only. Both ride on client_metadata. Write contract: an empty string is
// written through to CLEAR a field; an absent field is bound as NULL so
// upsertClientMetadata's COALESCE(excluded, existing) keeps the current value.
// (COALESCE only acts on the NULL/absent case; "" overwrites because it is not
// NULL.) See src/lib/invoice-emails.ts for how these resolve into a send.

import type { APIRoute } from 'astro';
import { getClientById } from '../../../../../lib/auth';
import { getClientMetadata, upsertClientMetadata } from '../../../../../lib/agreements';
import { isValidEmail } from '../../../../../lib/email-safety';
import { logger } from '../../../../../lib/logger';
import { logActivity } from '../../../../../lib/activity';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

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
  const update: { client_id: string; primary_contact_email?: string; billing_cc_email?: string; primary_contact_name?: string } = { client_id: clientId };
  const changes: string[] = [];

  // The contact NAME drives the email greeting ("Hi <first name>") and the To:
  // header name. Without it every invoice/reminder/receipt greets "Hi there"
  // (chat-wide audit 2026-06-11: no admin surface could set it; only contract
  // intake wrote it). Plain text; serialization junk normalized away.
  if (body.primary_contact_name !== undefined) {
    let v = (body.primary_contact_name ?? '').toString().trim();
    if (/^(null|undefined)$/i.test(v)) v = '';
    update.primary_contact_name = v; // '' clears
    changes.push('contact name');
  }

  if (body.primary_contact_email !== undefined) {
    const v = (body.primary_contact_email ?? '').toString().trim();
    if (v && !isValidEmail(v)) return json({ error: 'Primary contact email is not a valid email address (use a plain address like name@example.com, not "Name" <name@example.com>)' }, 400);
    update.primary_contact_email = v; // '' clears
    changes.push('primary contact');
  }

  if (body.billing_cc_email !== undefined) {
    const v = (body.billing_cc_email ?? '').toString().trim();
    if (v && !isValidEmail(v)) return json({ error: 'Accountant CC email is not a valid email address (use a plain address like name@example.com, not "Name" <name@example.com>)' }, 400);
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
      primary_contact_name: meta.primary_contact_name,
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
    primary_contact_name: meta?.primary_contact_name ?? null,
    primary_contact_email: meta?.primary_contact_email ?? null,
    billing_cc_email: meta?.billing_cc_email ?? null,
  });
};
