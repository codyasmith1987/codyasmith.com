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
import { upsertClientMetadata } from '../agreements';

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
    await upsertClientMetadata({
      client_id: clientId,
      legal_entity_name: 'Cody Test LLC',
      entity_type: 'limited liability company',
      state_of_organization: 'Utah',
      principal_address: '604 Morningside Circle, Cedar City, UT 84720',
      notice_address: '604 Morningside Circle, Cedar City, UT 84720',
      primary_contact_name: SIGNER_NAME,
      primary_contact_title: 'Member',
      primary_contact_email: SIGNER_EMAIL,
      primary_contact_phone: '435-868-7133',
    });

    // No proposal is seeded. The cody-test proposal is created via
    // the admin builder at /portal/admin/proposals/new, picking the
    // Cody Test client. That tests the builder end to end instead of
    // hiding it behind a cloned template.
  },
};

export default migration;
