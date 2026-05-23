// Storage layer for the shared proposal draft + countersign flow.
//
// One row per (client_id, slug). Each signer reads and writes the same
// row, so when the second signer arrives the selections are already
// pre-populated with the first signer's choices and signature.
//
// Phase 2: writes go to BOTH the legacy typed columns (mgmt_tier,
// jason_signature, etc.) AND the generic `selections` and `signatures`
// JSON columns introduced in migration 017. Reads prefer the JSON
// columns when present, falling back to the typed columns. This keeps
// existing rows working while every new write also populates the JSON
// form. Once Raised Bar settles on the generic renderer + endpoint, the
// typed columns can be removed in a later phase.

import { nanoid } from 'nanoid';
import turso from './turso';

// Public type kept stable so the existing accept endpoint (and any
// outside readers) continue to compile. Internally the row may be
// reconstructed from `selections` + `signatures` JSON columns instead
// of the typed columns.
export type ProposalDraft = {
  id: string;
  client_id: string;
  slug: string;
  mgmt_tier: string | null;
  option: string | null;
  consulting: string | null;
  consulting_tier: string | null;
  jason_signature: string | null;
  jason_signed_at: string | null;
  kevin_signature: string | null;
  kevin_signed_at: string | null;
  finalized_at: string | null;
  created_at: string;
  updated_at: string;
  // Generic state. Present on rows written by the Phase 2 renderer; on
  // legacy rows these are recomputed from the typed columns.
  selections: Record<string, string | null>;
  signatures: Record<string, { signature: string; signed_at: string }>;
};

// Best-effort JSON parse. Bad JSON returns the fallback rather than
// throwing so a single corrupt row never bricks the whole flow.
function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

// Build a draft from a DB row. Maps the legacy typed columns into the
// generic selections/signatures shape AND reads the JSON columns when
// they are populated. The JSON columns are the source of truth when
// present so newly written generic-only fields (e.g., custom steps on
// proposals outside Raised Bar) survive the round-trip.
function rowToDraft(row: any[]): ProposalDraft {
  const mgmtTier = row[3] as string | null;
  const option = row[4] as string | null;
  const consulting = row[5] as string | null;
  const consultingTier = row[6] as string | null;
  const jasonSig = row[7] as string | null;
  const jasonSignedAt = row[8] as string | null;
  const kevinSig = row[9] as string | null;
  const kevinSignedAt = row[10] as string | null;
  const finalizedAt = row[11] as string | null;
  const createdAt = row[12] as string;
  const updatedAt = row[13] as string;
  const selectionsRaw = row[14] as string | null;
  const signaturesRaw = row[15] as string | null;

  // Reconstruct typed columns from JSON if the JSON is populated.
  const selectionsJson = safeJsonParse<Record<string, string | null>>(selectionsRaw, {});
  const signaturesJson = safeJsonParse<Record<string, { signature: string; signed_at: string }>>(signaturesRaw, {});

  // Prefer JSON selections when present (Phase 2 writes); fall back to
  // typed columns for legacy rows.
  const effectiveSelections: Record<string, string | null> = Object.keys(selectionsJson).length > 0
    ? selectionsJson
    : {
        mgmt_tier: mgmtTier,
        site_setup: option,
        consulting: consulting,
        consulting_tier: consultingTier,
      };

  // Prefer JSON signatures when present.
  const effectiveSignatures: Record<string, { signature: string; signed_at: string }> = Object.keys(signaturesJson).length > 0
    ? signaturesJson
    : {
        ...(jasonSig ? { jason: { signature: jasonSig, signed_at: jasonSignedAt || '' } } : {}),
        ...(kevinSig ? { kevin: { signature: kevinSig, signed_at: kevinSignedAt || '' } } : {}),
      };

  return {
    id: row[0] as string,
    client_id: row[1] as string,
    slug: row[2] as string,
    // The typed columns the legacy accept endpoint reads from. Resolve
    // them from the JSON columns when those are populated so callers
    // see one consistent state regardless of which write path landed.
    mgmt_tier: effectiveSelections.mgmt_tier ?? mgmtTier,
    option: effectiveSelections.site_setup ?? option,
    consulting: effectiveSelections.consulting ?? consulting,
    consulting_tier: effectiveSelections.consulting_tier ?? consultingTier,
    jason_signature: effectiveSignatures.jason?.signature ?? jasonSig,
    jason_signed_at: effectiveSignatures.jason?.signed_at ?? jasonSignedAt,
    kevin_signature: effectiveSignatures.kevin?.signature ?? kevinSig,
    kevin_signed_at: effectiveSignatures.kevin?.signed_at ?? kevinSignedAt,
    finalized_at: finalizedAt,
    created_at: createdAt,
    updated_at: updatedAt,
    selections: effectiveSelections,
    signatures: effectiveSignatures,
  };
}

export async function getDraft(clientId: string, slug: string): Promise<ProposalDraft | null> {
  const result = await turso.execute({
    sql: `SELECT id, client_id, slug, mgmt_tier, option, consulting, consulting_tier,
                 jason_signature, jason_signed_at, kevin_signature, kevin_signed_at,
                 finalized_at, created_at, updated_at, selections, signatures
          FROM proposal_drafts
          WHERE client_id = ? AND slug = ?`,
    args: [clientId, slug],
  });
  if (result.rows.length === 0) return null;
  return rowToDraft(result.rows[0] as any[]);
}

// Legacy typed-column update API. Kept for the existing accept
// endpoint and any other caller that already speaks this shape.
export type DraftUpdate = {
  mgmt_tier?: string | null;
  option?: string | null;
  consulting?: string | null;
  consulting_tier?: string | null;
  jason_signature?: string | null;
  kevin_signature?: string | null;
};

// Generic step-id keyed update API used by the Phase 2 renderer +
// endpoint. The keys here are the step ids from the proposal config
// (mgmt_tier, site_setup, consulting, consulting_tier, ...). The
// signer keys are the signer ids from the proposal config (jason,
// kevin, ...).
export type GenericDraftUpdate = {
  selections?: Record<string, string | null>;
  signatures?: Record<string, { signature: string; signed_at?: string } | null>;
};

// Map a step id from the generic config to a legacy typed column. Used
// only to keep the legacy typed columns in sync for backward compat;
// new step ids (e.g., on proposals other than Raised Bar) have no
// legacy column and just live in the JSON.
function stepIdToTypedColumn(stepId: string): string | null {
  if (stepId === 'mgmt_tier') return 'mgmt_tier';
  if (stepId === 'site_setup') return 'option';
  if (stepId === 'consulting') return 'consulting';
  if (stepId === 'consulting_tier') return 'consulting_tier';
  return null;
}

function signerIdToTypedColumn(signerId: string): { sigCol: string; atCol: string } | null {
  if (signerId === 'jason') return { sigCol: 'jason_signature', atCol: 'jason_signed_at' };
  if (signerId === 'kevin') return { sigCol: 'kevin_signature', atCol: 'kevin_signed_at' };
  return null;
}

export async function upsertDraft(
  clientId: string,
  slug: string,
  update: DraftUpdate,
): Promise<ProposalDraft> {
  // Translate the legacy update to the generic shape and call into the
  // shared core so both write paths produce the same row state.
  const generic: GenericDraftUpdate = { selections: {}, signatures: {} };
  if ('mgmt_tier' in update) generic.selections!.mgmt_tier = update.mgmt_tier ?? null;
  if ('option' in update) generic.selections!.site_setup = update.option ?? null;
  if ('consulting' in update) generic.selections!.consulting = update.consulting ?? null;
  if ('consulting_tier' in update) generic.selections!.consulting_tier = update.consulting_tier ?? null;
  if ('jason_signature' in update) {
    generic.signatures!.jason = update.jason_signature
      ? { signature: update.jason_signature }
      : null;
  }
  if ('kevin_signature' in update) {
    generic.signatures!.kevin = update.kevin_signature
      ? { signature: update.kevin_signature }
      : null;
  }
  return upsertDraftGeneric(clientId, slug, generic);
}

// Generic upsert. Writes both the legacy typed columns (when a known
// step id maps to one) AND the JSON columns so reads from either path
// stay coherent during the Phase 2 cutover.
export async function upsertDraftGeneric(
  clientId: string,
  slug: string,
  update: GenericDraftUpdate,
): Promise<ProposalDraft> {
  const existing = await getDraft(clientId, slug);
  const now = new Date().toISOString();

  // Build the new selections/signatures JSON by merging the incoming
  // patch over the existing state. A null value in the patch clears
  // the key; an undefined value leaves it alone.
  const mergedSelections: Record<string, string | null> = { ...(existing?.selections || {}) };
  if (update.selections) {
    for (const k of Object.keys(update.selections)) {
      mergedSelections[k] = update.selections[k];
    }
  }
  const mergedSignatures: Record<string, { signature: string; signed_at: string }> = { ...(existing?.signatures || {}) };
  if (update.signatures) {
    for (const k of Object.keys(update.signatures)) {
      const v = update.signatures[k];
      if (v === null || v === undefined || !v.signature) {
        delete mergedSignatures[k];
      } else {
        // Preserve the existing signed_at if the patch doesn't override it
        // (e.g., a typo correction by an admin via a future flow). The
        // common path is signed_at=now on first sign.
        mergedSignatures[k] = {
          signature: v.signature,
          signed_at: v.signed_at ?? (existing?.signatures?.[k]?.signed_at || now),
        };
      }
    }
  }

  // INSERT path. Brand new row, populate both typed and JSON columns.
  if (!existing) {
    const id = nanoid();
    // Compute typed columns from the merged selections for any known
    // step id; new step ids without a legacy mapping just sit in JSON.
    const typedMgmtTier = mergedSelections.mgmt_tier ?? null;
    const typedOption = mergedSelections.site_setup ?? null;
    const typedConsulting = mergedSelections.consulting ?? null;
    const typedConsultingTier = mergedSelections.consulting_tier ?? null;
    const jasonSig = mergedSignatures.jason?.signature ?? null;
    const jasonSignedAt = mergedSignatures.jason?.signed_at ?? null;
    const kevinSig = mergedSignatures.kevin?.signature ?? null;
    const kevinSignedAt = mergedSignatures.kevin?.signed_at ?? null;
    await turso.execute({
      sql: `INSERT INTO proposal_drafts
              (id, client_id, slug, mgmt_tier, option, consulting, consulting_tier,
               jason_signature, jason_signed_at, kevin_signature, kevin_signed_at,
               selections, signatures)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id, clientId, slug,
        typedMgmtTier, typedOption, typedConsulting, typedConsultingTier,
        jasonSig, jasonSignedAt, kevinSig, kevinSignedAt,
        JSON.stringify(mergedSelections),
        JSON.stringify(mergedSignatures),
      ],
    });
    return (await getDraft(clientId, slug))!;
  }

  // UPDATE path. Build a dynamic SET clause: always rewrite the JSON
  // columns + updated_at, and additionally rewrite any typed columns
  // that correspond to keys touched in this patch.
  const sets: string[] = [];
  const args: any[] = [];

  // Typed columns that map to keys in the selections patch.
  if (update.selections) {
    for (const stepId of Object.keys(update.selections)) {
      const col = stepIdToTypedColumn(stepId);
      if (!col) continue;
      sets.push(`${col} = ?`);
      args.push(update.selections[stepId]);
    }
  }
  // Typed columns for signatures (jason/kevin).
  if (update.signatures) {
    for (const signerId of Object.keys(update.signatures)) {
      const cols = signerIdToTypedColumn(signerId);
      if (!cols) continue;
      const v = update.signatures[signerId];
      const sig = v?.signature || null;
      const at = sig ? (v?.signed_at ?? now) : null;
      sets.push(`${cols.sigCol} = ?`);
      args.push(sig);
      sets.push(`${cols.atCol} = ?`);
      args.push(at);
    }
  }

  // Always rewrite the JSON columns to the merged state.
  sets.push('selections = ?');
  args.push(JSON.stringify(mergedSelections));
  sets.push('signatures = ?');
  args.push(JSON.stringify(mergedSignatures));

  sets.push('updated_at = ?');
  args.push(now);
  args.push(existing.id);

  if (sets.length > 1) {
    await turso.execute({
      sql: `UPDATE proposal_drafts SET ${sets.join(', ')} WHERE id = ?`,
      args,
    });
  }
  return (await getDraft(clientId, slug))!;
}

export async function markFinalized(clientId: string, slug: string): Promise<void> {
  const now = new Date().toISOString();
  await turso.execute({
    sql: `UPDATE proposal_drafts SET finalized_at = ?, updated_at = ? WHERE client_id = ? AND slug = ?`,
    args: [now, now, clientId, slug],
  });
}

// Reset finalized_at to NULL. Used when a signer revokes their
// acceptance on a previously-finalized proposal so the draft can
// resume the partial / open state.
export async function unmarkFinalized(clientId: string, slug: string): Promise<void> {
  const now = new Date().toISOString();
  await turso.execute({
    sql: `UPDATE proposal_drafts SET finalized_at = NULL, updated_at = ? WHERE client_id = ? AND slug = ?`,
    args: [now, clientId, slug],
  });
}

// Convenience: which signer is this user, by email match? Returns null
// for any user that is not Jason or Kevin (e.g., admin previewing).
//
// Kept for backward compatibility with the legacy accept endpoint.
// The Phase 2 endpoint uses identifySignerFromConfig() which reads the
// signers list off the proposal's config blob instead of hardcoding.
export function identifySigner(email: string): 'jason' | 'kevin' | null {
  const e = (email || '').toLowerCase().trim();
  if (e === 'jasonroth1122@gmail.com') return 'jason';
  if (e === 'kevo.adams@gmail.com') return 'kevin';
  return null;
}

// Generic signer identification driven by a proposal's config.signers
// array. Returns the matching signer object (with id, email, name) or
// null. Email match is case-insensitive.
export type ProposalSigner = {
  id: string;
  email: string;
  name: string;
};

export function identifySignerFromConfig(
  email: string,
  signers: ProposalSigner[],
): ProposalSigner | null {
  const e = (email || '').toLowerCase().trim();
  for (const s of signers) {
    if ((s.email || '').toLowerCase().trim() === e) return s;
  }
  return null;
}
