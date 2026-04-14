// Add uniqueness guards that were missing from migration 001.
//
// Context (Phase 1, Step 2): keyword_rankings and site_issues previously
// had no unique constraint, so the CSV ingestion path could stack rows
// when re-uploads happened before the clearPreviousData dedupe logic
// existed. The data was cleaned in Step 1; this migration prevents the
// drift from recurring.
//
// Implementation: CREATE UNIQUE INDEX on existing tables — no table
// recreation, no foreign-key swap, no data movement. The index becomes
// enforcing immediately and rejects any future INSERT that would violate
// uniqueness. Step 4's ingestion rewrite will rely on these constraints.
//
// Also adds a defensive UNIQUE index on invoices(contract_id,
// billing_period_start, billing_period_end) to back up the app-level
// invoiceExistsForPeriod check in lib/billing.ts — protects against the
// page-load race. SQLite treats NULL as distinct in UNIQUE indexes, so
// existing draft invoices with null periods are unaffected.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '011-uniqueness-guards',
  async up() {
    await turso.batch(
      [
        'CREATE UNIQUE INDEX IF NOT EXISTS uq_keyword_rankings_client_month_source_keyword ON keyword_rankings(client_id, month, source, keyword)',
        'CREATE UNIQUE INDEX IF NOT EXISTS uq_site_issues_client_month_issue ON site_issues(client_id, month, issue_name)',
        'CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_contract_period ON invoices(contract_id, billing_period_start, billing_period_end)',
      ],
      'write'
    );
  },
};

export default migration;
