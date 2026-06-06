// Seed the cody-test fixture (client + user + client_metadata only).
// Lets Cody log into the portal as codyasmith@live.com on the Cody
// Test client without touching real Raised Bar client data.
//
// The proposal itself is NOT auto-seeded. Cody creates it via the
// admin builder at /portal/admin/proposals/new. That tests the
// builder (does it produce a real, working proposal from admin
// input?) instead of hiding it behind a cloned template.
//
// Idempotent: every insert is gated on a SELECT, so re-running this
// migration is a no-op. The reset endpoint at
// /portal/api/admin/test-fixtures/cody-test/reset clears drafts,
// agreements, signatures, and intake between test runs without
// removing the seeded client / user / metadata rows themselves.

import turso from '../turso';
import { nanoid } from 'nanoid';
import type { Migration } from '../migrate';

const CLIENT_SLUG = 'cody-test';
const CLIENT_NAME = 'Cody Test';
const SIGNER_EMAIL = 'codyasmith@live.com';
const SIGNER_NAME = 'Cody Smith';

const migration: Migration = {
  id: '025-seed-cody-test',
  async up() {
    // 1) Client.
    let clientId: string;
    const existingClient = await turso.execute({
      sql: 'SELECT id FROM clients WHERE slug = ?',
      args: [CLIENT_SLUG],
    });
    if (existingClient.rows.length > 0) {
      clientId = existingClient.rows[0][0] as string;
    } else {
      clientId = nanoid();
      await turso.execute({
        sql: 'INSERT INTO clients (id, name, slug, active) VALUES (?, ?, ?, 1)',
        args: [clientId, CLIENT_NAME, CLIENT_SLUG],
      });
    }

    // 2) Test signer user. Only created if no user with this email
    // already exists; if Cody already has a portal account at this
    // address (admin or otherwise) the migration leaves it alone.
    const existingUser = await turso.execute({
      sql: 'SELECT id, client_id, role FROM users WHERE email = ? LIMIT 1',
      args: [SIGNER_EMAIL.toLowerCase().trim()],
    });
    if (existingUser.rows.length === 0) {
      const userId = nanoid();
      await turso.execute({
        sql: 'INSERT INTO users (id, email, name, role, client_id) VALUES (?, ?, ?, ?, ?)',
        args: [userId, SIGNER_EMAIL.toLowerCase().trim(), SIGNER_NAME, 'client', clientId],
      });
    }

    // 3) Client metadata. Pre-filling so the preview contract shows
    // real values for legal entity, contact, etc., instead of the
    // [to be confirmed] placeholders. Mirrors what the admin wizard
    // will capture for real proposals.
    //
    // Inlined deliberately (NOT via upsertClientMetadata): a migration must
    // be an immutable snapshot and may only ever touch the client_metadata
    // columns that existed when it was written (migration 019). The live
    // upsertClientMetadata helper's column list grows over time (it gained
    // billing_cc_email in migration 067); importing it made a FRESH-DB
    // replay of 025 fail with "table client_metadata has no column named
    // billing_cc_email", because 025 runs long before 067 adds that column.
    // Existing DBs were unaffected (025 already applied), so only fresh
    // builds broke. See docs/BUGFIX-LOG.md.
    await turso.execute({
      sql: `INSERT INTO client_metadata (
              client_id, legal_entity_name, entity_type, state_of_organization,
              principal_address, notice_address, primary_contact_name,
              primary_contact_title, primary_contact_email, primary_contact_phone
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(client_id) DO UPDATE SET
              legal_entity_name = COALESCE(excluded.legal_entity_name, client_metadata.legal_entity_name),
              entity_type = COALESCE(excluded.entity_type, client_metadata.entity_type),
              state_of_organization = COALESCE(excluded.state_of_organization, client_metadata.state_of_organization),
              principal_address = COALESCE(excluded.principal_address, client_metadata.principal_address),
              notice_address = COALESCE(excluded.notice_address, client_metadata.notice_address),
              primary_contact_name = COALESCE(excluded.primary_contact_name, client_metadata.primary_contact_name),
              primary_contact_title = COALESCE(excluded.primary_contact_title, client_metadata.primary_contact_title),
              primary_contact_email = COALESCE(excluded.primary_contact_email, client_metadata.primary_contact_email),
              primary_contact_phone = COALESCE(excluded.primary_contact_phone, client_metadata.primary_contact_phone),
              updated_at = datetime('now')`,
      args: [
        clientId,
        'Cody Test LLC',
        'limited liability company',
        'Utah',
        '604 Morningside Circle, Cedar City, UT 84720',
        '604 Morningside Circle, Cedar City, UT 84720',
        SIGNER_NAME,
        'Member',
        SIGNER_EMAIL,
        '435-868-7133',
      ],
    });

    // No proposal is seeded. The cody-test proposal is created via
    // the admin builder at /portal/admin/proposals/new, picking the
    // Cody Test client. That tests the builder end to end instead of
    // hiding it behind a cloned template.
  },
};

export default migration;
