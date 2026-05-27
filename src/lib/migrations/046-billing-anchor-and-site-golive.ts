// Billing anchor + per-site go-live for first-period proration.
//
// Cody operating rule (2026-05-26): all sites under a single agreement
// bill on the SAME monthly cadence. When a new site goes live mid-cycle,
// its first invoice is prorated from go-live date to the engagement's
// next billing anchor day, then it falls into the monthly rhythm. No
// per-site billing calendars. One bill, one close date, per agreement.
//
// Two new fields support this:
//   - client_agreements.billing_anchor_day (1-31; default 1)
//     Day of month every site under this agreement bills on.
//   - client_sites.went_live_at (TEXT timestamp; nullable)
//     When this site joined active management. NULL = not live yet
//     (build in progress, takeover not started, etc.). When non-null,
//     the proration calculator can compute the first-period fee.
//
// No invoice generation here. Invoices stay manual in Quickbooks (or
// wherever). The system surfaces the prorated number; Cody copies it
// into the invoicing tool.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '046-billing-anchor-and-site-golive',
  async up() {
    // billing_anchor_day on client_agreements
    try {
      await turso.execute(`
        ALTER TABLE client_agreements ADD COLUMN billing_anchor_day INTEGER NOT NULL DEFAULT 1
      `);
    } catch (err: any) {
      // ALTER TABLE ADD COLUMN throws "duplicate column" on re-run.
      // Migration tracker prevents double-apply, but defensive in case
      // an earlier partial run left the column already present.
      if (!/duplicate column/i.test(String(err?.message || ''))) throw err;
    }
    // went_live_at on client_sites
    try {
      await turso.execute(`
        ALTER TABLE client_sites ADD COLUMN went_live_at TEXT
      `);
    } catch (err: any) {
      if (!/duplicate column/i.test(String(err?.message || ''))) throw err;
    }
  },
};

export default migration;
