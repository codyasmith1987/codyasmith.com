// Email-recipient model for the Send button + overdue notices. Invoices and
// overdue notices go to a client's PRIMARY billing contact
// (client_metadata.primary_contact_email, already present); this adds:
//   - client_metadata.billing_cc_email: an accountant CC, included on FINANCIAL
//     documents only (invoices, overdue notices, contracts), never general notices.
//   - invoices.extra_recipient_email: a one-off extra recipient for a single
//     invoice (e.g. alert someone special on this one).
// Both additive + nullable; ALTERs PRAGMA-guarded.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '067-invoice-email-recipients',
  async up() {
    const cm = await turso.execute(`PRAGMA table_info(client_metadata)`);
    if (!new Set(cm.rows.map(r => String(r[1]))).has('billing_cc_email')) {
      await turso.execute(`ALTER TABLE client_metadata ADD COLUMN billing_cc_email TEXT`);
    }
    const inv = await turso.execute(`PRAGMA table_info(invoices)`);
    if (!new Set(inv.rows.map(r => String(r[1]))).has('extra_recipient_email')) {
      await turso.execute(`ALTER TABLE invoices ADD COLUMN extra_recipient_email TEXT`);
    }
  },
};

export default migration;
