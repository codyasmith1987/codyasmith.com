// Phase 1 Slice 10 — contract-declared passthrough + reminder rules.
//
// These are the two pieces of commercial truth Cody enters once at
// contract signing that then drive automation:
//
//   passthrough_rule_json  — shape of which expenses auto-attach to
//                            which invoice and which need approval
//   reminder_rule_json     — lead times for dunning before and after
//                            the due date, per contract
//
// Both live as JSON blobs on the contracts row rather than separate
// tables because they are atomic-per-contract and have no child
// cardinality worth joining on.
//
// This migration also grows pending_charges with category +
// classification + needs_approval so the expense POST handler can
// stamp live classification at insert time, and it grows invoices
// with reminder_ticks_sent_json so the reminder engine can track
// which ticks have already fired on a per-invoice basis (the old
// last_reminder_sent column stays for backwards-compat — nothing
// reads it after this slice).
//
// All additions are nullable or default-bearing, so the migration
// applies cleanly over existing data.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '017-contract-rules',
  async up() {
    const alters: Array<[string, string]> = [
      ['contracts', 'passthrough_rule_json TEXT'],
      ['contracts', 'reminder_rule_json TEXT'],
      ['pending_charges', 'category TEXT'],
      ['pending_charges', 'classification TEXT'],
      ['pending_charges', 'needs_approval INTEGER NOT NULL DEFAULT 0'],
      ['invoices', `reminder_ticks_sent_json TEXT NOT NULL DEFAULT '[]'`],
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
