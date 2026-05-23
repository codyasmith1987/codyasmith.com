// GET /portal/api/contracts/[slug]/render
//
// Returns the current rendered state of a contract agreement: resolved
// body HTML, Schedule A JSON, signer state, intake completeness, and
// the computed document hash. Used by the contract page JS to refresh
// state after an intake or after a co-signer event without a full
// page reload.

import type { APIRoute } from 'astro';
import {
  getAgreementBySlug,
  getSignersForAgreement,
  getSignaturesForAgreement,
  getClientMetadata,
} from '../../../../../lib/agreements';
import { getContractTemplate } from '../../../../../lib/contract-templates';
import { renderTemplate, renderScheduleA, computeDocumentHash, PRACTICE } from '../../../../../lib/contract-render';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals, params }) => {
  const user = locals.user;
  if (!user) return json({ error: 'Not authenticated' }, 401);

  const slug = params.slug || '';
  if (!slug) return json({ error: 'Missing slug' }, 400);

  const agreement = await getAgreementBySlug(slug);
  if (!agreement) return json({ error: 'Not found' }, 404);

  if (user.role !== 'admin' && user.client_id !== agreement.client_id) {
    return json({ error: 'Forbidden' }, 403);
  }

  const template = await getContractTemplate(agreement.template_slug, agreement.template_version);
  if (!template) return json({ error: 'Template not found' }, 500);

  const clientMetadata = await getClientMetadata(agreement.client_id);
  const signers = await getSignersForAgreement(agreement.id);
  const signatures = await getSignaturesForAgreement(agreement.id, true);
  const activeBySigner: Record<string, any> = {};
  for (const sig of signatures) {
    if (!sig.revoked_at) activeBySigner[sig.signer_id] = sig;
  }

  // Render context.
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

  const mode = user.role === 'admin' ? 'admin-rendered' : 'client';
  const bodyHtml = renderTemplate(template.body_markdown, renderContext, mode as any);
  const scheduleAHtml = renderScheduleA(agreement.schedule_a, mode as any);
  const documentHash = computeDocumentHash({ body_html: bodyHtml, schedule_a: agreement.schedule_a, client: renderContext.client });

  const intakeComplete = Boolean(
    clientMetadata?.legal_entity_name &&
    clientMetadata?.primary_contact_email,
  );

  return json({
    agreement: {
      id: agreement.id,
      slug: agreement.slug,
      title: agreement.title,
      status: agreement.status,
      template_slug: agreement.template_slug,
      template_version: agreement.template_version,
      issued_at: agreement.issued_at,
      finalized_at: agreement.finalized_at,
      document_hash: agreement.document_hash,
    },
    body_html: bodyHtml,
    schedule_a_html: scheduleAHtml,
    schedule_a: agreement.schedule_a,
    current_document_hash: documentHash,
    client_metadata: clientMetadata,
    intake_complete: intakeComplete,
    signers: signers.map(s => {
      const active = activeBySigner[s.id];
      return {
        id: s.id,
        signer_role: s.signer_role,
        name: s.name_snapshot,
        email: s.email_snapshot,
        is_me: !!(active && user.email && s.email_snapshot === user.email.toLowerCase().trim()) ||
               (!active && user.email && s.email_snapshot === user.email.toLowerCase().trim()),
        signed: !!active,
        signed_at: active?.signed_at || null,
        signature_value: active?.signature_value || null,
        document_hash_at_sign: active?.document_hash || null,
        hash_matches_current: active ? active.document_hash === documentHash : true,
      };
    }),
  });
};
