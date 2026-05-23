// Seed the cody-test fixture (client + user + proposal). Lets Cody
// drive the full proposal -> LOI -> contract -> sign -> PDF flow end
// to end under his personal email without touching the real Raised Bar
// client data.
//
// Idempotent: every insert is gated on a SELECT, so re-running this
// migration is a no-op. The reset endpoint at
// /portal/api/admin/test-fixtures/cody-test/reset clears drafts,
// agreements, signatures, and intake between test runs without
// removing the seeded client / user / proposal rows themselves.

import turso from '../turso';
import { nanoid } from 'nanoid';
import type { Migration } from '../migrate';
import { RAISED_BAR_PROPOSAL_CONFIG } from '../proposal-configs/raised-bar';

const CLIENT_SLUG = 'cody-test';
const CLIENT_NAME = 'Cody Test';
const SIGNER_EMAIL = 'codyasmith@live.com';
const SIGNER_NAME = 'Cody Smith';
const PROPOSAL_SLUG = 'cody-test';
const PROPOSAL_TITLE = 'Test Engagement Proposal for Cody';

// Single-signer variant of the Raised Bar config. Reuses every step so
// the test renders identically to what Jason and Kevin will see; just
// swaps the signers list and the top-level prep metadata.
function buildTestConfig() {
  return {
    ...RAISED_BAR_PROPOSAL_CONFIG,
    prepared_for: 'Cody Smith',
    prepared_on: new Date().toISOString().slice(0, 10),
    title: PROPOSAL_TITLE,
    signers: [
      { id: 'cody', email: SIGNER_EMAIL, name: SIGNER_NAME },
    ],
  };
}

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

    // 3) Proposal.
    const existingProposal = await turso.execute({
      sql: 'SELECT id FROM proposals WHERE slug = ? LIMIT 1',
      args: [PROPOSAL_SLUG],
    });
    if (existingProposal.rows.length === 0) {
      const proposalId = nanoid();
      const config = buildTestConfig();
      await turso.execute({
        sql: `INSERT INTO proposals (id, slug, client_id, title, config, status, created_by)
              VALUES (?, ?, ?, ?, ?, 'published', NULL)`,
        args: [proposalId, PROPOSAL_SLUG, clientId, PROPOSAL_TITLE, JSON.stringify(config)],
      });
    } else {
      // If the proposal already exists, update its config to keep it in
      // sync with the latest raised-bar source. Same pattern as
      // migration 024 for the live raised-bar row.
      await turso.execute({
        sql: 'UPDATE proposals SET config = ? WHERE slug = ?',
        args: [JSON.stringify(buildTestConfig()), PROPOSAL_SLUG],
      });
    }
  },
};

export default migration;
