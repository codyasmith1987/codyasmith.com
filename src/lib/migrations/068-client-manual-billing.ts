// Per-client "manual billing" flag (Cody, 2026-06-05). When set, the client is
// billed entirely by hand: the automated engine never generates recurring
// invoices, sends pre-due reminders, or sends overdue notices for them. Used to
// keep a non-standard / transitional client (e.g. ZipKit, on an old paper
// contract pending a v7 re-paper) fully off automation until they are ready.
//
// Additive + defaulted to 0 (automated), so every existing client is unaffected.
// ALTER guarded by a PRAGMA check for idempotency.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '068-client-manual-billing',
  async up() {
    const info = await turso.execute(`PRAGMA table_info(clients)`);
    const have = new Set(info.rows.map(r => String(r[1])));
    if (!have.has('manual_billing')) {
      await turso.execute(`ALTER TABLE clients ADD COLUMN manual_billing INTEGER NOT NULL DEFAULT 0`);
    }
  },
};

export default migration;
