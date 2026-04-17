// Slice 23 — billing-contact health detector.
//
// Surfaces active recurring contracts whose invoice-reminder chain
// would deliver to nobody. Slice 22 made the reminder sweep self-
// perpetuating (`ensureReminderSweepQueued` + `send_reminders` daily
// re-enqueue), which makes the silent-failure mode costly: a chain
// that runs forever but can never reach a recipient is strictly
// worse than no chain — it consumes job slots and looks live in
// logs without ever producing a delivery.
//
// This module classifies one contract at a time by delegating to
// `resolveReminderRecipients` in src/lib/clients.ts — the same
// function `billing.ts:518-521` calls when the reminder runner
// resolves recipients for a real invoice. That function encodes a
// 3-layer fallback:
//
//   layer 1: active contacts with receives_reminders=1 and role
//            includes 'billing' or 'primary'
//   layer 2: clients.primary_contact_email
//   layer 3: portal users tied to the client
//
// If that function returns an empty array, ALL three layers are
// empty and the contract's reminder chain has no deliverable route.
// This module surfaces those contracts; it does not re-implement
// the fallback rules. One source of truth for reminder routing.
//
// Scope filter:
//   - contracts.status = 'active'
//   - contracts.billing_cadence IN ('monthly', 'milestone')
//
// One-time contracts are excluded: a single invoice produces at
// most one reminder chain that ends on payment; the signal has
// different shape and isn't what Slice 22's perpetual sweep was
// protecting. Non-active contracts can't invoice, so they can't
// produce reminders either.
//
// Cached per client_id so N at-risk contracts under the same
// client don't retrigger N full fallback checks.

import turso from '../turso';
import type { QueueSection, QueueRow } from '../admin-queue';
import { resolveReminderRecipients, getClientProfile } from '../clients';
import { getUsersByClientId } from '../auth';

interface CandidateContractRow {
  id: string;
  client_id: string;
  title: string;
  billing_cadence: string;
  client_name: string;
}

async function resolveForClient(
  clientId: string,
  cache: Map<string, Array<{ email: string; name: string }>>
): Promise<Array<{ email: string; name: string }>> {
  const hit = cache.get(clientId);
  if (hit) return hit;

  // Mirror the caller-site glue in src/lib/billing.ts:515-521 exactly.
  // Any future shift in how recipients are assembled upstream will
  // flow through here because we delegate to the same helper, not a
  // re-implementation.
  const fallbackUsers = await getUsersByClientId(clientId);
  const profile = await getClientProfile(clientId);
  const recipients = await resolveReminderRecipients(
    clientId,
    fallbackUsers.map((u) => ({ email: u.email, name: u.name })),
    profile?.primary_contact_email ?? null
  );
  cache.set(clientId, recipients);
  return recipients;
}

export async function loadMissingBillingContactSection(): Promise<QueueSection> {
  const rowsRaw = await turso.execute({
    sql: `SELECT co.id, co.client_id, co.title, co.billing_cadence, c.name
          FROM contracts co
          JOIN clients c ON c.id = co.client_id
          WHERE co.status = 'active'
            AND co.billing_cadence IN ('monthly', 'milestone')
          ORDER BY c.name, co.title`,
  });
  const candidates: CandidateContractRow[] = rowsRaw.rows.map((r) => ({
    id: r[0] as string,
    client_id: r[1] as string,
    title: r[2] as string,
    billing_cadence: r[3] as string,
    client_name: r[4] as string,
  }));

  const cache = new Map<string, Array<{ email: string; name: string }>>();
  const rows: QueueRow[] = [];
  for (const c of candidates) {
    const recipients = await resolveForClient(c.client_id, cache);
    if (recipients.length > 0) continue;
    rows.push({
      id: c.id,
      what: `${c.billing_cadence} contract has no reminder route`,
      where: `${c.client_name} · ${c.title}`,
      why:
        'no billing contact, no primary contact email, and no portal user — invoice reminders for this contract would deliver to nobody',
      action:
        'add a billing contact, set primary_contact_email, or invite a portal user on the client',
      link: '/portal/admin/contracts',
    });
  }

  return {
    key: 'missing_billing_contact',
    label: 'Contracts with no reminder route',
    count: rows.length,
    rows,
  };
}
