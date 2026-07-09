// One-time data set: mark ZipKit Homes as hand-billed (Cody, 2026-06-05:
// "keep ZKH manual til we fix all this"). ZipKit is on an old paper contract
// pending a v7 re-paper, so they must stay off ALL automated billing until
// Cody flips them back on from the admin UI.
//
// Why a migration rather than a one-off admin call: migration 068 added
// manual_billing with DEFAULT 0, so without this ZipKit is "automated" the
// instant the new dunning code deploys. Migrations run inside middleware before
// any route handler (including the daily-cron endpoint and the admin
// contracts-page auto-generate), so setting the flag here guarantees ZipKit is
// manual on the very first request after deploy -- no window in which the cron
// or a page load could auto-message/auto-invoice them. (The earlier code GATED
// dunning to portal contracts, which already excluded ZipKit; the new model
// gives non-standard clients a default notice, so the flag is now what protects
// them.)
//
// Scoped to ZipKit's known client id; it no-ops in dev/test (no such row) and
// is a plain idempotent UPDATE. If Cody later turns ZipKit's flag off in the UI
// this migration does NOT re-run (it is recorded in _migrations), so it never
// fights a deliberate later change.

import turso from '../turso';
import type { Migration } from '../migrate';

const ZIPKIT_CLIENT_ID = 'oYLqVOgsutCEPNwb7hizm';

const migration: Migration = {
  id: '069-zipkit-manual-billing',
  async up() {
    await turso.execute({
      sql: 'UPDATE clients SET manual_billing = 1 WHERE id = ?',
      args: [ZIPKIT_CLIENT_ID],
    });
  },
};

export default migration;
