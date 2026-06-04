// Slice 0 of the invoice-system overhaul: give invoice_items the structure the
// hand-made gold-standard invoices use. A line is a bold NAME + a frequency tag
// (MONTHLY/ANNUAL/ONE-TIME) + a lighter sub-description + an amount, grouped into
// a CATEGORY (Services vs Reimbursements).
//
// All additive + nullable/defaulted so existing prod invoices keep working: a
// NULL name falls back to description, a NULL frequency renders no tag, a NULL
// category is treated as 'services'. `description` stays as the legacy/fallback
// field (no destructive rename). ALTERs are guarded by a PRAGMA check so a
// partial-failure re-run cannot hit "duplicate column name".

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '062-invoice-line-item-structure',
  async up() {
    const info = await turso.execute(`PRAGMA table_info(invoice_items)`);
    const have = new Set(info.rows.map(r => String(r[1])));

    if (!have.has('name')) {
      await turso.execute(`ALTER TABLE invoice_items ADD COLUMN name TEXT`);
    }
    if (!have.has('sub_description')) {
      await turso.execute(`ALTER TABLE invoice_items ADD COLUMN sub_description TEXT`);
    }
    if (!have.has('frequency')) {
      await turso.execute(`ALTER TABLE invoice_items ADD COLUMN frequency TEXT`);
    }
    if (!have.has('category')) {
      await turso.execute(`ALTER TABLE invoice_items ADD COLUMN category TEXT NOT NULL DEFAULT 'services'`);
    }
  },
};

export default migration;
