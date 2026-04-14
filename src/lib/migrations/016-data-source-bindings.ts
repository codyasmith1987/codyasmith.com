// Phase 1 Slice 7 — data source bindings.
//
// A data_source_bindings row is the contract's declaration of a feed it
// expects to see flowing: Ubersuggest position tracking, Screaming Frog
// issues, GSC, GA4, etc. Each binding carries an enabled flag, a
// free-form config_json, and last_seen_at — the timestamp of the most
// recent successful import for that (contract, source) pair.
//
// This primitive is load-bearing for:
//   - provisionContract() seeding real downstream structure from intake
//   - admin-queue surfacing "X source has not refreshed in N days" signals
//   - the future intake wizard binding a client to declared feeds
//   - CSV ingest-v2 stamping touch timestamps to prove data is alive
//
// Scope of this migration is tight: one table, three indexes. Nothing
// else. The provisioning extension and ingest integration land in the
// code layers, not here.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '016-data-source-bindings',
  async up() {
    await turso.batch(
      [
        `CREATE TABLE IF NOT EXISTS data_source_bindings (
          id TEXT PRIMARY KEY,
          client_id TEXT NOT NULL REFERENCES clients(id),
          contract_id TEXT NOT NULL REFERENCES contracts(id),
          source TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 0,
          config_json TEXT,
          last_seen_at TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          UNIQUE(contract_id, source)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_dsb_client
         ON data_source_bindings(client_id)`,
        `CREATE INDEX IF NOT EXISTS idx_dsb_contract
         ON data_source_bindings(contract_id)`,
        `CREATE INDEX IF NOT EXISTS idx_dsb_source_enabled
         ON data_source_bindings(source, enabled)`,
      ],
      'write'
    );
  },
};

export default migration;
