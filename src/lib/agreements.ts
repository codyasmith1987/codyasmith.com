// Storage layer for client_agreements + agreement_signers + agreement_signatures.
//
// Mirrors src/lib/proposal-drafts.ts in shape and conventions: shared
// rows for dual-signer flow, JSON columns parsed defensively, and a
// stable public type so callers do not break when the DB schema grows.

import { nanoid } from 'nanoid';
import turso from './turso';

export type AgreementStatus =
  | 'draft'
  | 'issued'
  | 'partially_signed'
  | 'executed'
  | 'revoked'
  | 'voided';

export interface ClientAgreement {
  id: string;
  slug: string;
  client_id: string;
  proposal_id: string | null;
  template_slug: string;
  template_version: number;
  title: string;
  schedule_a: any;
  document_hash: string | null;
  pdf_file_id: string | null;
  status: AgreementStatus;
  contract_id: string | null;
  personal_note: string | null;
  created_by: string | null;
  created_at: string;
  issued_at: string | null;
  finalized_at: string | null;
  cancelled_at: string | null;
}

export interface AgreementSigner {
  id: string;
  agreement_id: string;
  user_id: string | null;
  signer_role: string;
  name_snapshot: string;
  email_snapshot: string;
  order_index: number;
}

export interface AgreementSignature {
  id: string;
  agreement_id: string;
  signer_id: string;
  signature_value: string;
  consent_at: string;
  intent_at: string;
  signed_at: string;
  document_hash: string;
  ip_address: string | null;
  user_agent: string | null;
  session_id: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
}

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

const AGREEMENT_COLS = `id, slug, client_id, proposal_id, template_slug, template_version, title, schedule_a, document_hash, pdf_file_id, status, contract_id, personal_note, created_by, created_at, issued_at, finalized_at, cancelled_at`;

function rowToAgreement(row: any[]): ClientAgreement {
  return {
    id: row[0] as string,
    slug: row[1] as string,
    client_id: row[2] as string,
    proposal_id: (row[3] as string | null) ?? null,
    template_slug: row[4] as string,
    template_version: row[5] as number,
    title: row[6] as string,
    schedule_a: safeJsonParse(row[7] as string, {}),
    document_hash: (row[8] as string | null) ?? null,
    pdf_file_id: (row[9] as string | null) ?? null,
    status: row[10] as AgreementStatus,
    contract_id: (row[11] as string | null) ?? null,
    personal_note: (row[12] as string | null) ?? null,
    created_by: (row[13] as string | null) ?? null,
    created_at: row[14] as string,
    issued_at: (row[15] as string | null) ?? null,
    finalized_at: (row[16] as string | null) ?? null,
    cancelled_at: (row[17] as string | null) ?? null,
  };
}

export async function getAgreementBySlug(slug: string): Promise<ClientAgreement | null> {
  const result = await turso.execute({
    sql: `SELECT ${AGREEMENT_COLS} FROM client_agreements WHERE slug = ? LIMIT 1`,
    args: [slug],
  });
  const row = result.rows[0];
  return row ? rowToAgreement(row as any) : null;
}

export async function getAgreement(id: string): Promise<ClientAgreement | null> {
  const result = await turso.execute({
    sql: `SELECT ${AGREEMENT_COLS} FROM client_agreements WHERE id = ? LIMIT 1`,
    args: [id],
  });
  const row = result.rows[0];
  return row ? rowToAgreement(row as any) : null;
}

export async function listAgreementsForClient(clientId: string): Promise<ClientAgreement[]> {
  const result = await turso.execute({
    sql: `SELECT ${AGREEMENT_COLS} FROM client_agreements WHERE client_id = ? ORDER BY finalized_at DESC NULLS LAST, created_at DESC`,
    args: [clientId],
  });
  return result.rows.map(r => rowToAgreement(r as any));
}

export async function listAllAgreements(): Promise<ClientAgreement[]> {
  const result = await turso.execute({
    sql: `SELECT ${AGREEMENT_COLS} FROM client_agreements ORDER BY created_at DESC`,
    args: [],
  });
  return result.rows.map(r => rowToAgreement(r as any));
}

export interface CreateAgreementInput {
  slug: string;
  client_id: string;
  proposal_id?: string | null;
  template_slug: string;
  template_version: number;
  title: string;
  schedule_a: any;
  personal_note?: string | null;
  created_by?: string | null;
}

export async function createAgreement(input: CreateAgreementInput): Promise<ClientAgreement> {
  const id = nanoid();
  await turso.execute({
    sql: `INSERT INTO client_agreements
            (id, slug, client_id, proposal_id, template_slug, template_version, title, schedule_a, status, personal_note, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    args: [
      id,
      input.slug,
      input.client_id,
      input.proposal_id ?? null,
      input.template_slug,
      input.template_version,
      input.title,
      JSON.stringify(input.schedule_a),
      input.personal_note ?? null,
      input.created_by ?? null,
    ],
  });
  const agreement = await getAgreement(id);
  if (!agreement) throw new Error('Failed to create agreement');
  return agreement;
}

export async function updateAgreementScheduleA(id: string, scheduleA: any): Promise<void> {
  await turso.execute({
    sql: `UPDATE client_agreements SET schedule_a = ?, document_hash = NULL WHERE id = ?`,
    args: [JSON.stringify(scheduleA), id],
  });
}

export async function updateAgreementStatus(id: string, status: AgreementStatus): Promise<void> {
  await turso.execute({
    sql: `UPDATE client_agreements SET status = ? WHERE id = ?`,
    args: [status, id],
  });
}

export async function markAgreementIssued(id: string, personalNote?: string | null): Promise<void> {
  await turso.execute({
    sql: `UPDATE client_agreements SET status = 'issued', issued_at = datetime('now'), personal_note = ? WHERE id = ? AND status IN ('draft','issued')`,
    args: [personalNote ?? null, id],
  });
}

export async function markAgreementCancelled(id: string): Promise<void> {
  await turso.execute({
    sql: `UPDATE client_agreements SET status = 'voided', cancelled_at = datetime('now') WHERE id = ?`,
    args: [id],
  });
}

/**
 * Compare-and-set finalize. Returns true if this call performed the
 * transition (i.e., this is the call that should generate the PDF and
 * fire the email). Returns false if the agreement was already finalized
 * by a concurrent transaction.
 */
export async function tryMarkAgreementFinalized(id: string, documentHash: string, pdfFileId: string | null): Promise<boolean> {
  const result = await turso.execute({
    sql: `UPDATE client_agreements
             SET status = 'executed',
                 finalized_at = datetime('now'),
                 document_hash = ?,
                 pdf_file_id = ?
           WHERE id = ? AND finalized_at IS NULL`,
    args: [documentHash, pdfFileId, id],
  });
  return (result.rowsAffected ?? 0) > 0;
}

export async function rollbackAgreementToPartial(id: string): Promise<void> {
  await turso.execute({
    sql: `UPDATE client_agreements
             SET status = 'partially_signed',
                 finalized_at = NULL,
                 document_hash = NULL,
                 pdf_file_id = NULL
           WHERE id = ?`,
    args: [id],
  });
}

// Signers --------------------------------------------------------------

const SIGNER_COLS = `id, agreement_id, user_id, signer_role, name_snapshot, email_snapshot, order_index`;

function rowToSigner(row: any[]): AgreementSigner {
  return {
    id: row[0] as string,
    agreement_id: row[1] as string,
    user_id: (row[2] as string | null) ?? null,
    signer_role: row[3] as string,
    name_snapshot: row[4] as string,
    email_snapshot: row[5] as string,
    order_index: row[6] as number,
  };
}

export async function getSignersForAgreement(agreementId: string): Promise<AgreementSigner[]> {
  const result = await turso.execute({
    sql: `SELECT ${SIGNER_COLS} FROM agreement_signers WHERE agreement_id = ? ORDER BY order_index ASC, id ASC`,
    args: [agreementId],
  });
  return result.rows.map(r => rowToSigner(r as any));
}

export interface AddSignerInput {
  agreement_id: string;
  user_id?: string | null;
  signer_role: string;
  name_snapshot: string;
  email_snapshot: string;
  order_index?: number;
}

export async function addSigner(input: AddSignerInput): Promise<AgreementSigner> {
  const id = nanoid();
  await turso.execute({
    sql: `INSERT INTO agreement_signers (id, agreement_id, user_id, signer_role, name_snapshot, email_snapshot, order_index)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      input.agreement_id,
      input.user_id ?? null,
      input.signer_role,
      input.name_snapshot,
      input.email_snapshot.toLowerCase(),
      input.order_index ?? 0,
    ],
  });
  const result = await turso.execute({
    sql: `SELECT ${SIGNER_COLS} FROM agreement_signers WHERE id = ? LIMIT 1`,
    args: [id],
  });
  const row = result.rows[0];
  if (!row) throw new Error('Failed to insert signer');
  return rowToSigner(row as any);
}

// Signatures -----------------------------------------------------------

const SIGNATURE_COLS = `id, agreement_id, signer_id, signature_value, consent_at, intent_at, signed_at, document_hash, ip_address, user_agent, session_id, revoked_at, revoke_reason`;

function rowToSignature(row: any[]): AgreementSignature {
  return {
    id: row[0] as string,
    agreement_id: row[1] as string,
    signer_id: row[2] as string,
    signature_value: row[3] as string,
    consent_at: row[4] as string,
    intent_at: row[5] as string,
    signed_at: row[6] as string,
    document_hash: row[7] as string,
    ip_address: (row[8] as string | null) ?? null,
    user_agent: (row[9] as string | null) ?? null,
    session_id: (row[10] as string | null) ?? null,
    revoked_at: (row[11] as string | null) ?? null,
    revoke_reason: (row[12] as string | null) ?? null,
  };
}

export async function getSignaturesForAgreement(agreementId: string, includeRevoked = true): Promise<AgreementSignature[]> {
  const sql = includeRevoked
    ? `SELECT ${SIGNATURE_COLS} FROM agreement_signatures WHERE agreement_id = ? ORDER BY signed_at ASC`
    : `SELECT ${SIGNATURE_COLS} FROM agreement_signatures WHERE agreement_id = ? AND revoked_at IS NULL ORDER BY signed_at ASC`;
  const result = await turso.execute({ sql, args: [agreementId] });
  return result.rows.map(r => rowToSignature(r as any));
}

export async function getActiveSignatureForSigner(agreementId: string, signerId: string): Promise<AgreementSignature | null> {
  const result = await turso.execute({
    sql: `SELECT ${SIGNATURE_COLS} FROM agreement_signatures
           WHERE agreement_id = ? AND signer_id = ? AND revoked_at IS NULL
           LIMIT 1`,
    args: [agreementId, signerId],
  });
  const row = result.rows[0];
  return row ? rowToSignature(row as any) : null;
}

export interface CaptureSignatureInput {
  agreement_id: string;
  signer_id: string;
  signature_value: string;
  document_hash: string;
  ip_address?: string | null;
  user_agent?: string | null;
  session_id?: string | null;
  consent_at?: string;
  intent_at?: string;
}

export async function captureSignature(input: CaptureSignatureInput): Promise<AgreementSignature> {
  const id = nanoid();
  const now = new Date().toISOString();
  const consent = input.consent_at || now;
  const intent = input.intent_at || now;
  await turso.execute({
    sql: `INSERT INTO agreement_signatures
            (id, agreement_id, signer_id, signature_value, consent_at, intent_at, signed_at, document_hash, ip_address, user_agent, session_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      input.agreement_id,
      input.signer_id,
      input.signature_value,
      consent,
      intent,
      now,
      input.document_hash,
      input.ip_address ?? null,
      input.user_agent ?? null,
      input.session_id ?? null,
    ],
  });
  const result = await turso.execute({
    sql: `SELECT ${SIGNATURE_COLS} FROM agreement_signatures WHERE id = ? LIMIT 1`,
    args: [id],
  });
  const row = result.rows[0];
  if (!row) throw new Error('Failed to insert signature');
  return rowToSignature(row as any);
}

export async function revokeSignature(signatureId: string, reason?: string): Promise<void> {
  await turso.execute({
    sql: `UPDATE agreement_signatures
             SET revoked_at = datetime('now'), revoke_reason = ?
           WHERE id = ? AND revoked_at IS NULL`,
    args: [reason ?? null, signatureId],
  });
}

// Client metadata ------------------------------------------------------

export interface ClientMetadata {
  client_id: string;
  legal_entity_name: string | null;
  entity_type: string | null;
  state_of_organization: string | null;
  ein: string | null;
  principal_address: string | null;
  notice_address: string | null;
  primary_contact_name: string | null;
  primary_contact_title: string | null;
  primary_contact_email: string | null;
  primary_contact_phone: string | null;
}

const CLIENT_METADATA_COLS = `client_id, legal_entity_name, entity_type, state_of_organization, ein, principal_address, notice_address, primary_contact_name, primary_contact_title, primary_contact_email, primary_contact_phone`;

export async function getClientMetadata(clientId: string): Promise<ClientMetadata | null> {
  const result = await turso.execute({
    sql: `SELECT ${CLIENT_METADATA_COLS} FROM client_metadata WHERE client_id = ? LIMIT 1`,
    args: [clientId],
  });
  const row = result.rows[0];
  if (!row) return null;
  return {
    client_id: row[0] as string,
    legal_entity_name: (row[1] as string | null) ?? null,
    entity_type: (row[2] as string | null) ?? null,
    state_of_organization: (row[3] as string | null) ?? null,
    ein: (row[4] as string | null) ?? null,
    principal_address: (row[5] as string | null) ?? null,
    notice_address: (row[6] as string | null) ?? null,
    primary_contact_name: (row[7] as string | null) ?? null,
    primary_contact_title: (row[8] as string | null) ?? null,
    primary_contact_email: (row[9] as string | null) ?? null,
    primary_contact_phone: (row[10] as string | null) ?? null,
  };
}

export interface UpsertClientMetadataInput {
  client_id: string;
  legal_entity_name?: string | null;
  entity_type?: string | null;
  state_of_organization?: string | null;
  ein?: string | null;
  principal_address?: string | null;
  notice_address?: string | null;
  primary_contact_name?: string | null;
  primary_contact_title?: string | null;
  primary_contact_email?: string | null;
  primary_contact_phone?: string | null;
}

export async function upsertClientMetadata(input: UpsertClientMetadataInput): Promise<ClientMetadata> {
  const existing = await getClientMetadata(input.client_id);
  if (existing) {
    await turso.execute({
      sql: `UPDATE client_metadata SET
              legal_entity_name = COALESCE(?, legal_entity_name),
              entity_type = COALESCE(?, entity_type),
              state_of_organization = COALESCE(?, state_of_organization),
              ein = COALESCE(?, ein),
              principal_address = COALESCE(?, principal_address),
              notice_address = COALESCE(?, notice_address),
              primary_contact_name = COALESCE(?, primary_contact_name),
              primary_contact_title = COALESCE(?, primary_contact_title),
              primary_contact_email = COALESCE(?, primary_contact_email),
              primary_contact_phone = COALESCE(?, primary_contact_phone),
              updated_at = datetime('now')
            WHERE client_id = ?`,
      args: [
        input.legal_entity_name ?? null,
        input.entity_type ?? null,
        input.state_of_organization ?? null,
        input.ein ?? null,
        input.principal_address ?? null,
        input.notice_address ?? null,
        input.primary_contact_name ?? null,
        input.primary_contact_title ?? null,
        input.primary_contact_email ?? null,
        input.primary_contact_phone ?? null,
        input.client_id,
      ],
    });
  } else {
    await turso.execute({
      sql: `INSERT INTO client_metadata (${CLIENT_METADATA_COLS})
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        input.client_id,
        input.legal_entity_name ?? null,
        input.entity_type ?? null,
        input.state_of_organization ?? null,
        input.ein ?? null,
        input.principal_address ?? null,
        input.notice_address ?? null,
        input.primary_contact_name ?? null,
        input.primary_contact_title ?? null,
        input.primary_contact_email ?? null,
        input.primary_contact_phone ?? null,
      ],
    });
  }
  const meta = await getClientMetadata(input.client_id);
  if (!meta) throw new Error('Failed to upsert client metadata');
  return meta;
}
