// Phase 1 Step 6 — minimum viable contract engine.
//
// Adds the client profile and contract provisioning fields that later
// wizard-style onboarding will write into, and that Phase 1's backend
// provisioning reads from today.
//
// clients:
//   primary_url             TEXT  — company URL for reporting context
//   brand_accent            TEXT  — hex color for portal theming (default amber)
//   primary_contact_email   TEXT  — who invoices / notifications go to
//   reading_level_target    INTEGER DEFAULT 7 — plain-language copy target
//
// contracts:
//   service_type  TEXT  — 'web_management' | 'consulting' | 'hybrid'
//   modules_json  TEXT NOT NULL DEFAULT '["dashboard","rankings","health","files","invoices"]'
//     The set of client-portal modules this contract grants access to.
//     Stored as JSON so the schema stays stable as modules are added.
//
// All columns are added via ALTER TABLE ADD COLUMN and wrapped in
// try/catch so partial re-runs are safe.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '015-contract-engine',
  async up() {
    const alters: Array<[string, string]> = [
      ['clients', 'primary_url TEXT'],
      ['clients', 'brand_accent TEXT'],
      ['clients', 'primary_contact_email TEXT'],
      ['clients', 'reading_level_target INTEGER DEFAULT 7'],
      ['contracts', 'service_type TEXT'],
      [
        'contracts',
        `modules_json TEXT NOT NULL DEFAULT '["dashboard","rankings","health","files","invoices"]'`,
      ],
    ];
    for (const [table, col] of alters) {
      try {
        await turso.execute(`ALTER TABLE ${table} ADD COLUMN ${col}`);
      } catch {
        // column already exists
      }
    }
  },
};

export default migration;
