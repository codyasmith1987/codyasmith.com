// POST /portal/api/admin/agreements/[slug]/issue
//
// Sends the contract-issued email to every signer on the agreement
// (with the admin's personal-note block) and flips status from draft
// to issued. Idempotent: re-running just re-sends.

import type { APIRoute } from 'astro';
import { logger } from '../../../../../../lib/logger';
import { logActivity } from '../../../../../../lib/activity';
import {
  getAgreementBySlug,
  getSignersForAgreement,
  markAgreementIssued,
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

  // Optional override of personal-note for the send.
  let body: any = {};
  try { body = await request.json(); } catch { /* empty body is fine */ }
  const personalNote = typeof body?.personal_note === 'string' ? body.personal_note : agreement.personal_note;

  const signers = await getSignersForAgreement(agreement.id);
  if (signers.length === 0) return json({ error: 'No signers configured' }, 400);

  await markAgreementIssued(agreement.id, personalNote || null);

  const baseUrl = (import.meta.env.PUBLIC_BASE_URL || 'https://codyasmith.com').replace(/\/$/, '');
  const agreementUrl = `${baseUrl}/portal/contracts/${agreement.slug}`;
  const updatedAgreement = { ...agreement, personal_note: personalNote };

  const sendResults: Array<{ email: string; ok: boolean }> = [];
  for (const signer of signers) {
    try {
      const ok = await sendContractIssuedEmail({ signer, agreement: updatedAgreement, agreementUrl });
      sendResults.push({ email: signer.email_snapshot, ok });
    } catch (err) {
      logger.error(`issue email to ${signer.email_snapshot} failed`, err);
      sendResults.push({ email: signer.email_snapshot, ok: false });
    }
  }

  try {
    await logActivity({
      clientId: agreement.client_id,
      userId: user.id,
      action: 'issued',
      entityType: 'agreement',
      entityId: agreement.id,
      summary: `Admin issued ${agreement.title} to ${signers.length} signer(s)`,
    });
  } catch (err) {
    logger.error('issue activity log failed', err);
  }

  return json({ ok: true, send_results: sendResults });
};
