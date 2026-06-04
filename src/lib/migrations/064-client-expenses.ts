// Slice 0 of the invoice-system overhaul: recurring expense templates, the source
// for an invoice's Reimbursements section. Cody's decision (2026-06-03): a
// recurring-template model, not a one-off ledger. Define each plugin/tool once
// with a cadence; it auto-recurs onto invoices (cadence-aware) until removed, and
// each is editable/removable per invoice.
//
//   frequency 'monthly'  -> include on every invoice
//   frequency 'annual'   -> include when last_billed_on is NULL or ~11+ months old
//   frequency 'one_time' -> include when last_billed_on is NULL
//
// Adding one to an invoice stamps last_billed_on. `active` is a soft on/off so a
// template can be paused without losing history.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '064-client-expenses',
  async up() {
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS client_expenses (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        amount REAL NOT NULL,
        frequency TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        last_billed_on TEXT,
        notes TEXT,
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_client_expenses_active ON client_expenses(client_id, active)`);
  },
};

export default migration;
