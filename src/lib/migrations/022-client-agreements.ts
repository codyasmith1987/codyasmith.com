// Client agreements: per-instance row for a signed (or in-flight) contract.
//
// Distinct from the existing `contracts` table, which is the operational
// billing/project container. This table is the legal-document spine:
// one row per agreement, locked template version, snapshotted Schedule A
// JSON, document hash at finalize, link to a generated PDF in the files
// table, and a back-link to the legacy `contracts` row created post-
// finalize for billing setup.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '022-client-agreements',
  async up() {
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS client_agreements (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        proposal_id TEXT REFERENCES proposals(id),
        template_slug TEXT NOT NULL,
        template_version INTEGER NOT NULL,
        title TEXT NOT NULL,
        schedule_a TEXT NOT NULL,
        document_hash TEXT,
        pdf_file_id TEXT REFERENCES files(id),
        status TEXT NOT NULL DEFAULT 'draft',
        contract_id TEXT REFERENCES contracts(id),
        personal_note TEXT,
        created_by TEXT REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now')),
        issued_at TEXT,
        finalized_at TEXT,
        cancelled_at TEXT,
        FOREIGN KEY (template_slug, template_version) REFERENCES contract_templates(slug, version)
      )
    `);

    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_client_agreements_client ON client_agreements(client_id)`);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_client_agreements_proposal ON client_agreements(proposal_id)`);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_client_agreements_status ON client_agreements(status)`);
  },
};

export default migration;
