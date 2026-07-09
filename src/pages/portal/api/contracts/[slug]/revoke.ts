// POST /portal/api/contracts/[slug]/revoke
//
// Revokes the calling signer's active signature on the agreement. The
// signature row is kept (revoked_at + revoke_reason set) so the audit
// trail survives. The agreement status reverts from 'executed' or
// 'partially_signed' back to 'partially_signed' (other signers' active
// signatures persist). The other signers get a "signer revoked" email.

import type { APIRoute } from 'astro';
import { logActivity } from '../../../../../lib/activity';
import { logger } from '../../../../../lib/logger';
import {
  getAgreementBySlug,
  getSignersForAgreement,
  getActiveSignatureForSigner,
  getSignaturesForAgreement,
  revokeSignature,
  rollbackAgreementToPartial,
  updateAgreementStatus,
} from '../../../../../lib/agreements';
import { sendSignerRevokedEmail } from '../../../../../lib/contract-emails';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ locals, request, params }) => {
  const user = locals.user;
  if (!user) return json({ error: 'Not authenticated' }, 401);

  const slug = params.slug || '';
  if (!slug) return json({ error: 'Missing slug' }, 400);

  const agreement = await getAgreementBySlug(slug);
  if (!agreement) return json({ error: 'Not found' }, 404);
  if (user.role === 'admin') return json({ error: 'Admin preview mode' }, 403);
  if (user.client_id !== agreement.client_id) return json({ error: 'Forbidden' }, 403);
  if (agreement.status === 'voided') return json({ error: 'Agreement is voided' }, 409);
  // Once a contract is fully executed (every signer signed and finalized
  // landed), it is binding. No more revoke from the signers' side. If a
  // party needs out, that is a termination conversation under section 17
  // of the contract, not a unilateral revoke. Per Cody's directive: the
  // LOI on the proposal is revocable until contract issue; the contract
  // itself locks at execution.
  if (agreement.status === 'executed') {
    return json({ error: 'This contract is fully executed and cannot be revoked. Contact Cody to discuss termination under section 17 of the agreement.' }, 409);
  }

  let body: any = {};
  try { body = await request.json(); } catch { /* body optional */ }
  const reason = body && typeof body.reason === 'string' ? String(body.reason).slice(0, 240) : null;

  const signers = await getSignersForAgreement(agreement.id);
  const me = signers.find(s => s.email_snapshot.toLowerCase() === (user.email || '').toLowerCase());
  if (!me) return json({ error: 'You are not an authorized signer on this agreement' }, 403);

  const active = await getActiveSignatureForSigner(agreement.id, me.id);
  if (!active) return json({ error: 'No active signature to revoke' }, 409);

  await revokeSignature(active.id, reason || undefined);

  // Roll back to partially_signed unless every signature is now revoked,
  // in which case the agreement returns to 'issued'.
  const remaining = await getSignaturesForAgreement(agreement.id, false);
  if (remaining.length === 0) {
    await updateAgreementStatus(agreement.id, 'issued');
  } else {
    await rollbackAgreementToPartial(agreement.id);
  }

  try {
    await logActivity({
      clientId: agreement.client_id,
      userId: user.id,
      action: 'revoked',
      entityType: 'agreement',
      entityId: agreement.id,
      summary: `${me.name_snapshot} revoked signature on ${agreement.title}; reason=${reason || ''}`,
    });
  } catch (err) {
    logger.error('revoke activity log failed', err);
  }

  // Notify other signers.
  const baseUrl = (import.meta.env.PUBLIC_BASE_URL || 'https://codyasmith.com').replace(/\/$/, '');
  const agreementUrl = `${baseUrl}/portal/contracts/${agreement.slug}`;
  const others = signers.filter(s => s.id !== me.id);
  for (const other of others) {
    try {
      await sendSignerRevokedEmail({ revokedBy: me, otherSigner: other, agreement, agreementUrl });
    } catch (err) {
      logger.error(`revoked-email to ${other.email_snapshot} failed`, err);
    }
  }

  return json({ ok: true });
};
