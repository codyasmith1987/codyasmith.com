// Invoices, invoice line items, and payments
// Billing spine: Contract → Invoice → Invoice Items, Invoice → Payments

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '007-invoices-payments',
  async up() {
    await turso.batch([
      // Invoices — tied to a contract, can reference a milestone
      `CREATE TABLE IF NOT EXISTS invoices (
        id TEXT PRIMARY KEY,
        contract_id TEXT NOT NULL REFERENCES contracts(id),
        client_id TEXT NOT NULL REFERENCES clients(id),
        milestone_id TEXT REFERENCES milestones(id),
        invoice_number TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'draft',
        issued_date TEXT,
        due_date TEXT,
        subtotal REAL NOT NULL DEFAULT 0,
        tax REAL NOT NULL DEFAULT 0,
        total REAL NOT NULL DEFAULT 0,
        amount_paid REAL NOT NULL DEFAULT 0,
        notes TEXT,
        client_visible INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )`,

      // Invoice items — line-item breakdown
      `CREATE TABLE IF NOT EXISTS invoice_items (
        id TEXT PRIMARY KEY,
        invoice_id TEXT NOT NULL REFERENCES invoices(id),
        description TEXT NOT NULL,
        quantity REAL NOT NULL DEFAULT 1,
        unit_price REAL NOT NULL DEFAULT 0,
        amount REAL NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      )`,

      // Payments — records against an invoice
      `CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY,
        invoice_id TEXT NOT NULL REFERENCES invoices(id),
        amount REAL NOT NULL,
        payment_method TEXT,
        reference TEXT,
        paid_at TEXT NOT NULL,
        recorded_by TEXT NOT NULL REFERENCES users(id),
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`,

      // Indexes
      'CREATE INDEX IF NOT EXISTS idx_invoices_contract ON invoices(contract_id)',
      'CREATE INDEX IF NOT EXISTS idx_invoices_client ON invoices(client_id)',
      'CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status)',
      'CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id)',
      'CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id)',
    ], 'write');
  },
};

export default migration;
