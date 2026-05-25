// POST /portal/api/admin/agreements/[slug]/resend
//
// Re-sends the contract-issued email to a subset of signers without
// flipping agreement status (status stays where it is). Two modes:
//   - { signer_id }: send to that one signer only
//   - {} (or omitted): send to every signer on the agreement
//
// Activity log records 'resent' (vs 'issued' which the /issue endpoint
// uses) so the audit trail distinguishes initial issue from later
// reminders.
//
// Returns { ok, send_results: [{ email, ok }] } so the UI can surface
// per-signer success/failure inline.

import type { APIRoute } from 'astro';
import { logger } from '../../../../../../lib/logger';
import { logActivity } from '../../../../../../lib/activity';
import {
  getAgreementBySlug,
  getSignersForAgreement,
} from '../../../../../../lib/agreements';
import { sendContractIssuedEmail } from '../../../../../../lib/contract-emails';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ locals, request, params }) => {
  const user = locals.user;
  if (!user || user.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  const slug = params.slug || '';
  const agreement = await getAgreementBySlug(slug);
  if (!agreement) return json({ error: 'Not found' }, 404);
  if (agreement.status === 'voided') return json({ error: 'Agreement is voided' }, 409);

  let body: any = {};
  try { body = await request.json(); } catch { /* empty body is fine */ }
  const signerId = body?.signer_id ? String(body.signer_id) : null;

  const allSigners = await getSignersForAgreement(agreement.id);
  if (allSigners.length === 0) return json({ error: 'No signers configured' }, 400);

  const targets = signerId
    ? allSigners.filter(s => s.id === signerId)
    : allSigners;
  if (targets.length === 0) {
    return json({ error: 'Signer not found on this agreement' }, 404);
  }

  const baseUrl = (import.meta.env.PUBLIC_BASE_URL || 'https://codyasmith.com').replace(/\/$/, '');
  const agreementUrl = `${baseUrl}/portal/contracts/${agreement.slug}`;

  const sendResults: Array<{ email: string; ok: boolean }> = [];
  for (const signer of targets) {
    try {
      const ok = await sendContractIssuedEmail({ signer, agreement, agreementUrl });
      sendResults.push({ email: signer.email_snapshot, ok });
    } catch (err) {
      logger.error(`resend email to ${signer.email_snapshot} failed`, err);
      sendResults.push({ email: signer.email_snapshot, ok: false });
    }
  }

  try {
    const summary = signerId
      ? `Admin resent contract email to ${targets[0].email_snapshot}`
      : `Admin resent contract email to ${targets.length} signer(s)`;
    await logActivity({
      clientId: agreement.client_id,
      userId: user.id,
      action: 'resent',
      entityType: 'agreement',
      entityId: agreement.id,
      summary,
    });
  } catch (err) {
    logger.error('resend activity log failed', err);
  }

  return json({ ok: true, send_results: sendResults });
};
