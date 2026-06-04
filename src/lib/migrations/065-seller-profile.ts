// Slice 0 of the invoice-system overhaul: a single-row seller profile so the
// invoice PDF letterhead + footer are data-driven (editable later without a
// deploy) instead of hardcoded in pdf.ts. Seeded from Cody's hand-made invoices.
// CHECK (id = 1) enforces the single row; INSERT OR IGNORE makes the seed
// idempotent and never clobbers later edits.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '065-seller-profile',
  async up() {
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS seller_profile (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        display_name TEXT,
        street TEXT,
        city_state_zip TEXT,
        email TEXT,
        phone TEXT,
        legal_footer TEXT,
        payable_to TEXT
      )
    `);
    await turso.execute({
      sql: `INSERT OR IGNORE INTO seller_profile
              (id, display_name, street, city_state_zip, email, phone, legal_footer, payable_to)
            VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        'Cody Smith',
        '604 Morningside Cir',
        'Cedar City, UT 84720',
        'cody@codyasmith.com',
        '435-868-7133',
        'Operating as Cody A Smith LLC (Utah)',
        'Cody A Smith LLC',
      ],
    });
  },
};

export default migration;
