// GET /portal/api/admin/agreements/[slug]/verify-hashes
//
// Forensic verification of every signature on a contract. Re-renders
// the contract at the current state, computes the document hash, and
// compares each stored signature.document_hash against it. Returns a
// per-signature report. Used in the admin audit-trail panel.

import type { APIRoute } from 'astro';
import {
  getAgreementBySlug,
  getSignersForAgreement,
  getSignaturesForAgreement,
  getClientMetadata,
} from '../../../../../../lib/agreements';
import { getContractTemplate } from '../../../../../../lib/contract-templates';
import { renderTemplate, computeDocumentHash, PRACTICE } from '../../../../../../lib/contract-render';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals, params }) => {
  const user = locals.user;
  if (!user || user.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  const slug = params.slug || '';
  const agreement = await getAgreementBySlug(slug);
  if (!agreement) return json({ error: 'Not found' }, 404);

  const template = await getContractTemplate(agreement.template_slug, agreement.template_version);
  if (!template) return json({ error: 'Template not found' }, 500);

  const clientMetadata = await getClientMetadata(agreement.client_id);
  const signers = await getSignersForAgreement(agreement.id);
  const signatures = await getSignaturesForAgreement(agreement.id, true);

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
  const currentHash = computeDocumentHash({
    body_html: bodyHtml,
    schedule_a: agreement.schedule_a,
    client: renderContext.client,
  });

  const signersById: Record<string, any> = {};
  for (const s of signers) signersById[s.id] = s;

  const report = signatures.map(sig => ({
    signature_id: sig.id,
    signer_id: sig.signer_id,
    signer_name: signersById[sig.signer_id]?.name_snapshot || '',
    signer_email: signersById[sig.signer_id]?.email_snapshot || '',
    signed_at: sig.signed_at,
    revoked_at: sig.revoked_at,
    stored_hash: sig.document_hash,
    matches_current: sig.document_hash === currentHash,
  }));

  return json({
    current_document_hash: currentHash,
    agreement_document_hash: agreement.document_hash,
    matches_finalized: !!agreement.document_hash && agreement.document_hash === currentHash,
    signatures: report,
  });
};
