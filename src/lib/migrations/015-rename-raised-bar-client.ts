// Rename the seeded Raised Bar client from the initial misnamed
// "Roth Family Companies" to "Raised Bar Group" (slug raised-bar-group).
//
// Migration 014 originally created the client as "Roth Family Companies"
// (slug roth-family-companies). That name was wrong: Kevin Adams is not a
// Roth, the entity that matters is the engagement's primary brand. The
// correct name is "Raised Bar Group" with slug "raised-bar-group", and
// migration 014's source has been updated to match for fresh deploys.
//
// Production already has the old row from when 014 ran the first time;
// this migration fixes that row in-place. Idempotent: if the row was
// never created (or already renamed), the UPDATE matches zero rows and
// no-ops.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '015-rename-raised-bar-client',
  async up() {
    await turso.execute({
      sql: `UPDATE clients
            SET name = 'Raised Bar Group', slug = 'raised-bar-group'
            WHERE slug = 'roth-family-companies'`,
    });
  },
};

export default migration;
