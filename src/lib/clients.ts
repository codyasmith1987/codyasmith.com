// Client-level operations beyond auth: profile upsert, profile reads,
// contacts + roles (migration 018).
//
// auth.ts owns createClient / toggleClientActive / getAllClients — the
// rows and the active bit. This file owns everything added in
// migrations 015 and 018:
//   - clients.{primary_url, brand_accent, primary_contact_email,
//     reading_level_target}
//   - contacts (separate rows per person-at-the-client, with roles)
//
// Those fields are "commercial truth about this client" and get
// entered once at intake; the wizard writes them through here inside
// the same transaction as the contract.

import { nanoid } from 'nanoid';
import turso from './turso';

export interface ClientProfile {
  primary_url: string | null;
  brand_accent: string | null;
  primary_contact_email: string | null;
  reading_level_target: number | null;
}

export interface ClientProfileInput {
  primary_url?: string;
  brand_accent?: string;
  primary_contact_email?: string;
  reading_level_target?: number;
}

// Parses untrusted JSON into a ClientProfileInput. Returns an empty
// object when the raw is null/undefined (caller should treat that as
// "no update requested"), and null on any field-level validation
// failure so the route handler can 400 the request without writing
// garbage to the clients row.
//
// Accepted shapes per field:
//   primary_url           string, starts with http:// or https://
//   brand_accent          string matching /^#[0-9a-f]{6}$/i
//   primary_contact_email string matching a minimal email pattern
//   reading_level_target  integer in [1, 12]
export function parseClientProfileInput(raw: unknown): ClientProfileInput | null {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: ClientProfileInput = {};

  if (r.primary_url !== undefined && r.primary_url !== null) {
    if (typeof r.primary_url !== 'string') return null;
    const url = r.primary_url.trim();
    if (url.length === 0 || !/^https?:\/\/[^\s]+$/i.test(url)) return null;
    out.primary_url = url;
  }

  if (r.brand_accent !== undefined && r.brand_accent !== null) {
    if (typeof r.brand_accent !== 'string') return null;
    const hex = r.brand_accent.trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
    out.brand_accent = hex;
  }

  if (r.primary_contact_email !== undefined && r.primary_contact_email !== null) {
    if (typeof r.primary_contact_email !== 'string') return null;
    const email = r.primary_contact_email.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null;
    out.primary_contact_email = email;
  }

  if (r.reading_level_target !== undefined && r.reading_level_target !== null) {
    const n = Number(r.reading_level_target);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 12) return null;
    out.reading_level_target = n;
  }

  return out;
}

// Tx-safe variant. Used by provisionContract() so the UPDATE lands in
// the same transaction as the contract INSERT — no half-writes if any
// later step crashes.
export async function updateClientProfileInTx(
  tx: { execute: (q: { sql: string; args: any[] }) => Promise<unknown> },
  clientId: string,
  profile: ClientProfileInput
): Promise<{ updatedFields: string[] }> {
  const fields: string[] = [];
  const args: any[] = [];
  const updated: string[] = [];

  if (profile.primary_url !== undefined) {
    fields.push('primary_url = ?');
    args.push(profile.primary_url);
    updated.push('primary_url');
  }
  if (profile.brand_accent !== undefined) {
    fields.push('brand_accent = ?');
    args.push(profile.brand_accent);
    updated.push('brand_accent');
  }
  if (profile.primary_contact_email !== undefined) {
    fields.push('primary_contact_email = ?');
    args.push(profile.primary_contact_email);
    updated.push('primary_contact_email');
  }
  if (profile.reading_level_target !== undefined) {
    fields.push('reading_level_target = ?');
    args.push(profile.reading_level_target);
    updated.push('reading_level_target');
  }

  if (fields.length === 0) return { updatedFields: [] };

  args.push(clientId);
  await tx.execute({
    sql: `UPDATE clients SET ${fields.join(', ')} WHERE id = ?`,
    args,
  });
  return { updatedFields: updated };
}

// Non-tx wrapper for contexts that don't already have an open
// transaction (e.g. an admin "edit client profile" page).
export async function updateClientProfile(
  clientId: string,
  profile: ClientProfileInput
): Promise<{ updatedFields: string[] }> {
  return updateClientProfileInTx(turso, clientId, profile);
}

export async function getClientProfile(clientId: string): Promise<ClientProfile | null> {
  const r = await turso.execute({
    sql: `SELECT primary_url, brand_accent, primary_contact_email, reading_level_target
          FROM clients WHERE id = ?`,
    args: [clientId],
  });
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    primary_url: (row[0] as string | null) ?? null,
    brand_accent: (row[1] as string | null) ?? null,
    primary_contact_email: (row[2] as string | null) ?? null,
    reading_level_target: row[3] != null ? Number(row[3]) : null,
  };
}

// ============================================================
// Contacts (migration 018)
// ============================================================

export type ContactRole = 'billing' | 'technical' | 'approval' | 'primary';

export const CONTACT_ROLES: readonly ContactRole[] = [
  'billing',
  'technical',
  'approval',
  'primary',
] as const;

export interface Contact {
  id: string;
  client_id: string;
  name: string;
  email: string;
  roles: ContactRole[];
  receives_invoices: boolean;
  receives_reminders: boolean;
  user_id: string | null;
  active: boolean;
  created_at: string;
}

export interface ContactInput {
  name: string;
  email: string;
  roles: ContactRole[];
  receives_invoices?: boolean;
  receives_reminders?: boolean;
  user_id?: string;
}

// Parses an untrusted contacts array. Returns:
//   - an array (possibly empty) on success
//   - null on any structural failure (caller 400s the request)
// An empty array is a legal input (client signs with zero contacts).
export function parseContactsInput(raw: unknown): ContactInput[] | null {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return null;
  const seenEmails = new Set<string>();
  const out: ContactInput[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const r = item as Record<string, unknown>;

    if (typeof r.name !== 'string') return null;
    const name = r.name.trim();
    if (name.length === 0 || name.length > 100) return null;

    if (typeof r.email !== 'string') return null;
    const email = r.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null;
    if (email.length > 200) return null;
    if (seenEmails.has(email)) return null;
    seenEmails.add(email);

    if (!Array.isArray(r.roles)) return null;
    const roles: ContactRole[] = [];
    for (const role of r.roles) {
      if (typeof role !== 'string') return null;
      if (!CONTACT_ROLES.includes(role as ContactRole)) return null;
      if (!roles.includes(role as ContactRole)) roles.push(role as ContactRole);
    }
    if (roles.length === 0) return null;

    const receivesInvoices = r.receives_invoices === true;
    const receivesReminders = r.receives_reminders === true;

    let userId: string | undefined;
    if (r.user_id !== undefined && r.user_id !== null) {
      if (typeof r.user_id !== 'string') return null;
      userId = r.user_id.trim();
      if (userId.length === 0) return null;
    }

    out.push({
      name,
      email,
      roles,
      receives_invoices: receivesInvoices,
      receives_reminders: receivesReminders,
      ...(userId !== undefined ? { user_id: userId } : {}),
    });
  }
  return out;
}

// Non-tx wrapper for callers that aren't inside an existing
// transaction. Opens a short write transaction so the full contact
// list commits as a unit: either all rows land or none do. Used by
// provisionClientIntake (multi-contract flow) which handles its own
// client-level writes outside any contract's transaction.
export async function seedContactsForClient(
  clientId: string,
  contacts: ContactInput[]
): Promise<string[]> {
  if (contacts.length === 0) return [];
  const tx = await turso.transaction('write');
  try {
    const ids = await seedContactsInTx(tx, { client_id: clientId, contacts });
    await tx.commit();
    return ids;
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

// Tx-safe seeder — used by provisionContract so every contact row
// lands atomically with its parent client's other commercial truth.
export async function seedContactsInTx(
  tx: { execute: (q: { sql: string; args: any[] }) => Promise<unknown> },
  params: {
    client_id: string;
    contacts: ContactInput[];
  }
): Promise<string[]> {
  const ids: string[] = [];
  for (const c of params.contacts) {
    const id = nanoid();
    ids.push(id);
    await tx.execute({
      sql: `INSERT INTO contacts
            (id, client_id, name, email, roles_json, receives_invoices, receives_reminders, user_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        params.client_id,
        c.name,
        c.email,
        JSON.stringify(c.roles),
        c.receives_invoices ? 1 : 0,
        c.receives_reminders ? 1 : 0,
        c.user_id ?? null,
      ],
    });
  }
  return ids;
}

function rowToContact(row: any[]): Contact {
  let roles: ContactRole[] = [];
  try {
    const parsed = JSON.parse((row[4] as string | null) ?? '[]');
    if (Array.isArray(parsed)) {
      roles = parsed.filter((r): r is ContactRole =>
        typeof r === 'string' && (CONTACT_ROLES as readonly string[]).includes(r)
      );
    }
  } catch {
    roles = [];
  }
  return {
    id: row[0] as string,
    client_id: row[1] as string,
    name: row[2] as string,
    email: row[3] as string,
    roles,
    receives_invoices: Number(row[5]) === 1,
    receives_reminders: Number(row[6]) === 1,
    user_id: (row[7] as string | null) ?? null,
    active: Number(row[8]) === 1,
    created_at: row[9] as string,
  };
}

export async function getContactsForClient(clientId: string): Promise<Contact[]> {
  const r = await turso.execute({
    sql: `SELECT id, client_id, name, email, roles_json, receives_invoices,
                 receives_reminders, user_id, active, created_at
          FROM contacts
          WHERE client_id = ? AND active = 1
          ORDER BY created_at`,
    args: [clientId],
  });
  return r.rows.map((row) => rowToContact(Array.from(row as any)));
}

export async function getContactsByRole(
  clientId: string,
  role: ContactRole
): Promise<Contact[]> {
  // SQLite has no JSON_EACH-lite operator available through libSQL in
  // every environment; load the client's contacts and filter in JS.
  // N is tiny (<10 per client in practice) so this is fine.
  const all = await getContactsForClient(clientId);
  return all.filter((c) => c.roles.includes(role));
}

// Routing helper for billing reminders. Returns the emails that
// should be notified about a client's invoices, preferring contacts
// with receives_reminders=1 and the 'billing' (or 'primary' fallback)
// role. Falls back through two additional layers so nothing regresses
// on clients that have no contacts seeded yet.
export async function resolveReminderRecipients(
  clientId: string,
  fallbackUserEmails: Array<{ email: string; name: string }>,
  primaryContactEmail: string | null
): Promise<Array<{ email: string; name: string }>> {
  const contacts = await getContactsForClient(clientId);
  const billable = contacts.filter(
    (c) =>
      c.receives_reminders &&
      (c.roles.includes('billing') || c.roles.includes('primary'))
  );
  if (billable.length > 0) {
    return billable.map((c) => ({ email: c.email, name: c.name }));
  }
  if (primaryContactEmail) {
    return [{ email: primaryContactEmail, name: 'Primary contact' }];
  }
  return fallbackUserEmails;
}
