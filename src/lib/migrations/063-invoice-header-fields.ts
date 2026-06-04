// Slice 0 of the invoice-system overhaul: invoice header fields the gold-standard
// layout needs.
//   title            - optional invoice subject (e.g. "May 2026 Web Management")
//   terms_label      - "Upon Receipt" / "Net 30" / free text; NULL -> derive from due_date
//   bill_to_snapshot - JSON {company,contact,address,email,phone} frozen at SEND so a
//                      sent invoice never silently changes if the client record is edited
//   reminders_paused - per-invoice pause for the due + overdue auto-notices
//
// All additive + nullable/defaulted; existing invoices unaffected. ALTERs guarded
// by a PRAGMA check for idempotency.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '063-invoice-header-fields',
  async up() {
    const info = await turso.execute(`PRAGMA table_info(invoices)`);
    const have = new Set(info.rows.map(r => String(r[1])));

    if (!have.has('title')) {
      await turso.execute(`ALTER TABLE invoices ADD COLUMN title TEXT`);
    }
    if (!have.has('terms_label')) {
      await turso.execute(`ALTER TABLE invoices ADD COLUMN terms_label TEXT`);
    }
    if (!have.has('bill_to_snapshot')) {
      await turso.execute(`ALTER TABLE invoices ADD COLUMN bill_to_snapshot TEXT`);
    }
    if (!have.has('reminders_paused')) {
      await turso.execute(`ALTER TABLE invoices ADD COLUMN reminders_paused INTEGER NOT NULL DEFAULT 0`);
    }
  },
};

export default migration;
