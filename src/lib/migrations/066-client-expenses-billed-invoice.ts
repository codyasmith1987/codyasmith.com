// Link a client_expenses template's "billed" stamp to the invoice that billed
// it, so deleting that invoice can un-stamp the template (otherwise an annual or
// one_time template stays stamped after its invoice is deleted and silently
// skips its next cycle - a recurring-revenue drop caught in the dual audit).
// Mirrors the pending_charges.billed_invoice_id pattern. Additive + guarded.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '066-client-expenses-billed-invoice',
  async up() {
    const info = await turso.execute(`PRAGMA table_info(client_expenses)`);
    const have = new Set(info.rows.map(r => String(r[1])));
    if (!have.has('billed_invoice_id')) {
      await turso.execute(`ALTER TABLE client_expenses ADD COLUMN billed_invoice_id TEXT`);
    }
  },
};

export default migration;
