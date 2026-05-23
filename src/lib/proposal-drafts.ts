// Storage layer for the shared proposal draft + countersign flow.
//
// One row per (client_id, slug). Each signer reads and writes the same
// row, so when the second signer arrives the selections are already
// pre-populated with the first signer's choices and signature.

import { nanoid } from 'nanoid';
import turso from './turso';

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
};

function rowToDraft(row: any[]): ProposalDraft {
  return {
    id: row[0] as string,
    client_id: row[1] as string,
    slug: row[2] as string,
    mgmt_tier: row[3] as string | null,
    option: row[4] as string | null,
    consulting: row[5] as string | null,
    consulting_tier: row[6] as string | null,
    jason_signature: row[7] as string | null,
    jason_signed_at: row[8] as string | null,
    kevin_signature: row[9] as string | null,
    kevin_signed_at: row[10] as string | null,
    finalized_at: row[11] as string | null,
    created_at: row[12] as string,
    updated_at: row[13] as string,
  };
}

export async function getDraft(clientId: string, slug: string): Promise<ProposalDraft | null> {
  const result = await turso.execute({
    sql: `SELECT id, client_id, slug, mgmt_tier, option, consulting, consulting_tier,
                 jason_signature, jason_signed_at, kevin_signature, kevin_signed_at,
                 finalized_at, created_at, updated_at
          FROM proposal_drafts
          WHERE client_id = ? AND slug = ?`,
    args: [clientId, slug],
  });
  if (result.rows.length === 0) return null;
  return rowToDraft(result.rows[0] as any[]);
}

export type DraftUpdate = {
  mgmt_tier?: string | null;
  option?: string | null;
  consulting?: string | null;
  consulting_tier?: string | null;
  jason_signature?: string | null;
  kevin_signature?: string | null;
};

export async function upsertDraft(
  clientId: string,
  slug: string,
  update: DraftUpdate,
): Promise<ProposalDraft> {
  const existing = await getDraft(clientId, slug);
  const now = new Date().toISOString();

  if (!existing) {
    const id = nanoid();
    await turso.execute({
      sql: `INSERT INTO proposal_drafts
              (id, client_id, slug, mgmt_tier, option, consulting, consulting_tier,
               jason_signature, jason_signed_at, kevin_signature, kevin_signed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id, clientId, slug,
        update.mgmt_tier ?? null,
        update.option ?? null,
        update.consulting ?? null,
        update.consulting_tier ?? null,
        update.jason_signature ?? null,
        update.jason_signature ? now : null,
        update.kevin_signature ?? null,
        update.kevin_signature ? now : null,
      ],
    });
    return (await getDraft(clientId, slug))!;
  }

  // Build a dynamic UPDATE that only touches keys explicitly provided.
  const sets: string[] = [];
  const args: any[] = [];
  if ('mgmt_tier' in update) { sets.push('mgmt_tier = ?'); args.push(update.mgmt_tier); }
  if ('option' in update) { sets.push('option = ?'); args.push(update.option); }
  if ('consulting' in update) { sets.push('consulting = ?'); args.push(update.consulting); }
  if ('consulting_tier' in update) { sets.push('consulting_tier = ?'); args.push(update.consulting_tier); }
  if ('jason_signature' in update) {
    sets.push('jason_signature = ?'); args.push(update.jason_signature);
    sets.push('jason_signed_at = ?'); args.push(update.jason_signature ? now : null);
  }
  if ('kevin_signature' in update) {
    sets.push('kevin_signature = ?'); args.push(update.kevin_signature);
    sets.push('kevin_signed_at = ?'); args.push(update.kevin_signature ? now : null);
  }
  sets.push('updated_at = ?'); args.push(now);
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

// Convenience: which signer is this user, by email match? Returns null
// for any user that is not Jason or Kevin (e.g., admin previewing).
export function identifySigner(email: string): 'jason' | 'kevin' | null {
  const e = (email || '').toLowerCase().trim();
  if (e === 'jasonroth1122@gmail.com') return 'jason';
  if (e === 'kevo.adams@gmail.com') return 'kevin';
  return null;
}
