// POST /portal/api/contracts/[slug]/sign
//
// Captures a signer's typed signature plus the four UETA pillars:
// affirmative consent, intent to be bound, association with the
// record (IP, user agent, session id, document hash at the moment of
// signing), and retention (the signature row is permanent, and the
// finalized PDF gets dropped in the files table). When this call lands
// the second signature, the agreement finalizes: a deterministic hash
// is computed and stored, a PDF is generated, and confirmation emails
// fire to both signers.

import type { APIRoute } from 'astro';
import { logActivity } from '../../../../../lib/activity';
import { logger } from '../../../../../lib/logger';
import { uploadFile } from '../../../../../lib/storage';
import {
  getAgreementBySlug,
  getSignersForAgreement,
  getSignaturesForAgreement,
  getActiveSignatureForSigner,
  captureSignature,
  tryMarkAgreementFinalized,
  updateAgreementStatus,
  getClientMetadata,
} from '../../../../../lib/agreements';
import { getContractTemplate } from '../../../../../lib/contract-templates';
import { renderTemplate, computeDocumentHash, PRACTICE } from '../../../../../lib/contract-render';
import { generateContractPdf } from '../../../../../lib/contract-pdf';
import {
  sendCountersignNeededEmail,
  sendFullyExecutedEmail,
} from '../../../../../lib/contract-emails';
import turso from '../../../../../lib/turso';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

function extractIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  const real = request.headers.get('x-real-ip');
  if (real) return real.trim();
  return '';
}

export const POST: APIRoute = async ({ locals, request, params }) => {
  const user = locals.user;
  if (!user) return json({ error: 'Not authenticated' }, 401);

  const slug = params.slug || '';
  if (!slug) return json({ error: 'Missing slug' }, 400);

  const agreement = await getAgreementBySlug(slug);
  if (!agreement) return json({ error: 'Not found' }, 404);

  if (user.role === 'admin') {
    return json({ error: 'Admin preview mode. The contract must be signed by an authorized signer.' }, 403);
  }
  if (user.client_id !== agreement.client_id) return json({ error: 'Forbidden' }, 403);
  if (agreement.status === 'voided') return json({ error: 'Agreement is voided' }, 409);
  if (agreement.status === 'executed') return json({ error: 'Already executed' }, 409);

  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'Invalid body' }, 400); }

  // UETA inputs: signature value, consent, intent. All three are
  // required for a sign POST to proceed.
  const signatureValue = String(body.signature_value || '').trim().slice(0, 120);
  if (!signatureValue) return json({ error: 'Type your full legal name to sign' }, 400);
  if (body.consent !== true) return json({ error: 'Consent to conduct this transaction electronically is required' }, 400);
  if (body.intent !== true) return json({ error: 'You must affirm intent to be bound to sign' }, 400);

  // Resolve the calling user against the signers list.
  const signers = await getSignersForAgreement(agreement.id);
  const me = signers.find(s => s.email_snapshot.toLowerCase() === (user.email || '').toLowerCase());
  if (!me) return json({ error: 'You are not an authorized signer on this agreement' }, 403);

  const existingActive = await getActiveSignatureForSigner(agreement.id, me.id);
  if (existingActive) return json({ error: 'You already signed. Revoke first if you want to re-sign.' }, 409);

  // Check intake completeness before allowing a sign.
  const clientMetadata = await getClientMetadata(agreement.client_id);
  const intakeComplete = Boolean(
    clientMetadata?.legal_entity_name &&
    clientMetadata?.primary_contact_email,
  );
  if (!intakeComplete) {
    return json({ error: 'Complete the required intake fields before signing.' }, 400);
  }

  // Render the contract body + Schedule A and compute the document
  // hash against the current state. This is what the signer attests to.
  const template = await getContractTemplate(agreement.template_slug, agreement.template_version);
  if (!template) return json({ error: 'Template not found' }, 500);
  const renderContext = {
    client: {
      legal_entity_name: clientMetadata?.legal_entity_name || '',
      entity_type: clientMetadata?.entity_type || '',
      state_of_organization: clientMetadata?.state_of_organization || '',
      primary_contact_name: clientMetadata?.primary_contact_name || undefined,
      primary_contact_title: clientMetadata?.primary_contact_title || undefined,
      primary_contact_email: clientMetadata?.primary_contact_email || undefined,
      primary_contact_phone: clientMetadata?.primary_contact_phone || undefined,
      principal_address: clientMetadata?.principal_address || undefined,
      notice_address: clientMetadata?.notice_address || undefined,
    },
    schedule_a: agreement.schedule_a,
    practice: PRACTICE,
    today: new Date().toISOString().slice(0, 10),
  };
  const bodyHtml = renderTemplate(template.body_markdown, renderContext, 'client');
  const documentHash = computeDocumentHash({
    body_html: bodyHtml,
    schedule_a: agreement.schedule_a,
    client: renderContext.client,
  });

  // Capture the signature.
  const signature = await captureSignature({
    agreement_id: agreement.id,
    signer_id: me.id,
    signature_value: signatureValue,
    document_hash: documentHash,
    ip_address: extractIp(request),
    user_agent: request.headers.get('user-agent') || '',
    session_id: locals.session?.id || null,
  });

  try {
    await logActivity({
      clientId: agreement.client_id,
      userId: user.id,
      action: 'signed',
      entityType: 'agreement',
      entityId: agreement.id,
      summary: `${me.name_snapshot} signed ${agreement.title}; hash=${documentHash.slice(0, 12)}`,
    });
  } catch (err) {
    logger.error('signed activity log failed', err);
  }

  // Check whether everyone signed. If so, finalize (race-safe).
  const allSignatures = await getSignaturesForAgreement(agreement.id, false);
  const allSigned = signers.every(s => allSignatures.some(sig => sig.signer_id === s.id && !sig.revoked_at));

  const baseUrl = (import.meta.env.PUBLIC_BASE_URL || 'https://codyasmith.com').replace(/\/$/, '');
  const agreementUrl = `${baseUrl}/portal/contracts/${agreement.slug}`;
  const documentsUrl = `${baseUrl}/portal/documents`;

  if (!allSigned) {
    // Notify the unsigned signers.
    const unsigned = signers.filter(s => !allSignatures.some(sig => sig.signer_id === s.id && !sig.revoked_at));
    for (const other of unsigned) {
      try {
        await sendCountersignNeededEmail({
          signedBy: me,
          otherSigner: other,
          agreement,
          agreementUrl,
          signedAt: new Date(signature.signed_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
        });
      } catch (err) {
        logger.error('countersign-needed email failed', err);
      }
    }
    await updateAgreementStatus(agreement.id, 'partially_signed');
    return json({ ok: true, status: 'partially_signed', signature_id: signature.id, document_hash: documentHash });
  }

  // Validate that every active signature's hash matches the current
  // hash. If a prior signature was made against an older Schedule A,
  // finalize is blocked and that signer must re-sign.
  const hashMismatch = allSignatures.find(s => !s.revoked_at && s.document_hash !== documentHash);
  if (hashMismatch) {
    await updateAgreementStatus(agreement.id, 'partially_signed');
    return json({
      ok: true,
      status: 'partially_signed',
      signature_id: signature.id,
      document_hash: documentHash,
      warning: 'A prior signature was made against an outdated Schedule A. That signer needs to re-sign before finalize.',
    });
  }

  // Generate the PDF, drop it in files, mark finalized.
  let pdfFileId: string | null = null;
  let pdfBase64: string | undefined;
  let pdfFilename: string | undefined;
  try {
    const pdfBuffer = await generateContractPdf({
      template,
      context: renderContext as any,
      resolvedBodyMarkdown: template.body_markdown,
      scheduleA: agreement.schedule_a,
      signers: signers.map(s => {
        const sig = allSignatures.find(x => x.signer_id === s.id && !x.revoked_at);
        return {
          name: s.name_snapshot,
          role: s.signer_role,
          signature: sig?.signature_value,
          signed_at: sig?.signed_at,
        };
      }),
      practice: PRACTICE,
    });
    // Look up client slug for the storage key prefix.
    const clientRow = await turso.execute({
      sql: `SELECT slug FROM clients WHERE id = ? LIMIT 1`,
      args: [agreement.client_id],
    });
    const clientSlug = (clientRow.rows[0]?.[0] as string) || 'unknown';
    pdfBase64 = pdfBuffer.toString('base64');
    pdfFilename = `${agreement.slug}-executed-${new Date().toISOString().slice(0, 10)}.pdf`;
    const upload = await uploadFile(
      clientSlug,
      new Date().toISOString().slice(0, 7),
      pdfFilename,
      pdfBuffer,
      'application/pdf',
      agreement.client_id,
      user.id,
      'contract',
    );
    pdfFileId = upload?.id || null;
  } catch (err) {
    logger.error('contract PDF generation failed', err);
  }

  const finalizedOk = await tryMarkAgreementFinalized(agreement.id, documentHash, pdfFileId);
  if (!finalizedOk) {
    // Someone else already finalized via a race. The signature row is
    // recorded; nothing else to do.
    return json({ ok: true, status: 'executed', signature_id: signature.id, document_hash: documentHash, raced: true });
  }

  try {
    await logActivity({
      clientId: agreement.client_id,
      userId: user.id,
      action: 'finalized',
      entityType: 'agreement',
      entityId: agreement.id,
      summary: `${agreement.title} fully executed; hash=${documentHash.slice(0, 12)}; pdf_file=${pdfFileId || 'none'}`,
    });
  } catch (err) {
    logger.error('finalized activity log failed', err);
  }

  // Send fully-executed emails to each signer with the PDF attached.
  const finalizedAtDisplay = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  for (const signer of signers) {
    try {
      await sendFullyExecutedEmail({
        recipient: signer,
        agreement,
        agreementUrl,
        documentsUrl,
        finalizedAt: finalizedAtDisplay,
        pdfBase64,
        pdfFilename,
      });
    } catch (err) {
      logger.error(`fully-executed email to ${signer.email_snapshot} failed`, err);
    }
  }

  return json({
    ok: true,
    status: 'executed',
    signature_id: signature.id,
    document_hash: documentHash,
    pdf_file_id: pdfFileId,
  });
};
