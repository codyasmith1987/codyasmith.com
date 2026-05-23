// Remove the auto-seeded cody-test proposal that migration 025
// previously created with a config cloned from raised-bar. Migration
// 025 has been updated to NOT seed a proposal at all; the proposal
// is built via the admin proposal wizard so we can actually test
// that the wizard produces a working dynamic proposal.
//
// This cleanup also wipes related state for the cody-test client
// (proposal drafts, agreements, signers, signatures, intake) so the
// fresh admin-built proposal starts clean. The cody-test client,
// user, and client_metadata stay in place.

import turso from '../turso';
import type { Migration } from '../migrate';

const CLIENT_SLUG = 'cody-test';
const PROPOSAL_SLUG = 'cody-test';

const migration: Migration = {
  id: '027-remove-seeded-cody-test-proposal',
  async up() {
    // Resolve the client id from the slug.
    const clientRes = await turso.execute({
      sql: 'SELECT id FROM clients WHERE slug = ? LIMIT 1',
      args: [CLIENT_SLUG],
    });
    if (clientRes.rows.length === 0) return;
    const clientId = clientRes.rows[0][0] as string;

    // Delete the seeded proposal row (slug-keyed).
    await turso.execute({
      sql: 'DELETE FROM proposals WHERE slug = ?',
      args: [PROPOSAL_SLUG],
    });

    // Delete the proposal draft scoped to this client + slug.
    await turso.execute({
      sql: 'DELETE FROM proposal_drafts WHERE client_id = ? AND slug = ?',
      args: [clientId, PROPOSAL_SLUG],
    });

    // Any client_agreements for this client get cleared too. Cascades
    // to agreement_signers and agreement_signatures via FK ON DELETE
    // CASCADE.
    await turso.execute({
      sql: 'DELETE FROM client_agreements WHERE client_id = ?',
      args: [clientId],
    });

    // Activity log entries scoped to this client are wiped so the
    // admin audit panel is clean for the fresh proposal pass.
    await turso.execute({
      sql: `DELETE FROM activity_log WHERE client_id = ?`,
      args: [clientId],
    });
  },
};

export default migration;
