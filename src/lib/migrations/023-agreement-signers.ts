// Agreement signers (role/order) and signatures (UETA audit event).
//
// Two tables. agreement_signers carries who-must-sign for a given
// agreement, snapshotted at issue time so name/email changes on the
// user record don't rewrite history. agreement_signatures carries
// every sign event, including revoked ones, with the four UETA pillars
// captured per signature: consent_at, intent_at, signed_at, and the
// association data (ip, user_agent, session_id, document_hash).
//
// The conditional UNIQUE index lets a signer revoke and sign again,
// keeping the revoked row for audit while only one active signature
// can exist per (agreement, signer) at a time.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '023-agreement-signers',
  async up() {
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS agreement_signers (
        id TEXT PRIMARY KEY,
        agreement_id TEXT NOT NULL REFERENCES client_agreements(id) ON DELETE CASCADE,
        user_id TEXT REFERENCES users(id),
        signer_role TEXT NOT NULL,
        name_snapshot TEXT NOT NULL,
        email_snapshot TEXT NOT NULL,
        order_index INTEGER NOT NULL DEFAULT 0
      )
    `);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_agreement_signers_agreement ON agreement_signers(agreement_id)`);

    await turso.execute(`
      CREATE TABLE IF NOT EXISTS agreement_signatures (
        id TEXT PRIMARY KEY,
        agreement_id TEXT NOT NULL REFERENCES client_agreements(id) ON DELETE CASCADE,
        signer_id TEXT NOT NULL REFERENCES agreement_signers(id),
        signature_value TEXT NOT NULL,
        consent_at TEXT NOT NULL,
        intent_at TEXT NOT NULL,
        signed_at TEXT NOT NULL,
        document_hash TEXT NOT NULL,
        ip_address TEXT,
        user_agent TEXT,
        session_id TEXT,
        revoked_at TEXT,
        revoke_reason TEXT
      )
    `);
    await turso.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agreement_signatures_active ON agreement_signatures(agreement_id, signer_id) WHERE revoked_at IS NULL`);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_agreement_signatures_agreement ON agreement_signatures(agreement_id)`);
  },
};

export default migration;
