// Billing rules on contracts, billing period on invoices, pending charges table

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '010-billing-rules',
  async up() {
    // Add billing columns to contracts
    const contractCols = [
      ['billing_cadence', 'TEXT'],      // 'monthly' | 'milestone' | 'one-time'
      ['billing_day', 'INTEGER'],        // 1-28
      ['recurring_amount', 'REAL'],
      ['included_hours', 'REAL'],
      ['overage_rate', 'REAL'],
      ['payment_terms_days', 'INTEGER DEFAULT 30'],
    ];
    for (const [col, type] of contractCols) {
      try { await turso.execute(`ALTER TABLE contracts ADD COLUMN ${col} ${type}`); } catch { /* already exists */ }
    }

    // Add billing period and reminder columns to invoices
    const invoiceCols = [
      ['billing_period_start', 'TEXT'],
      ['billing_period_end', 'TEXT'],
      ['last_reminder_sent', 'TEXT'],
    ];
    for (const [col, type] of invoiceCols) {
      try { await turso.execute(`ALTER TABLE invoices ADD COLUMN ${col} ${type}`); } catch { /* already exists */ }
    }

    // Pending billable charges
    await turso.batch([
      `CREATE TABLE IF NOT EXISTS pending_charges (
        id TEXT PRIMARY KEY,
        contract_id TEXT NOT NULL REFERENCES contracts(id),
        description TEXT NOT NULL,
        amount REAL NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT,
        billed_invoice_id TEXT REFERENCES invoices(id),
        created_at TEXT DEFAULT (datetime('now'))
      )`,
      'CREATE INDEX IF NOT EXISTS idx_pending_charges_contract ON pending_charges(contract_id)',
      'CREATE INDEX IF NOT EXISTS idx_pending_charges_billed ON pending_charges(billed_invoice_id)',
    ], 'write');
  },
};

export default migration;
