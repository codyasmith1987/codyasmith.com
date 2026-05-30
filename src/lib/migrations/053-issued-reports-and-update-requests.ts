// Slice 4 (issued-report surface) + the request-button rate limit.
//
// Two changes, both client-deliverable plumbing:
//
//  1. files.issued_at — prescriptive deliverables (a strategic
//     recommendation or a research report) are drafts until Cody
//     deliberately issues them. issued_at NULL = draft (admin-only);
//     issued_at set = delivered to the client. Descriptive categories
//     and ad-hoc files ignore this column.
//
//  2. data_update_requests — an append-only log of "Request a data
//     update" presses, one row per press. Backs the twice-a-month cap
//     and the "N of 2 used this month" chip on the live pages. A real
//     table (not the 1-hour portal_rate_limits window, whose cleanup
//     would wipe a monthly count) so the count survives the month.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '053-issued-reports-and-update-requests',
  async up() {
    try {
      await turso.execute('ALTER TABLE files ADD COLUMN issued_at TEXT');
    } catch {
      // Column already exists; expected on re-run.
    }

    await turso.batch([
      `CREATE TABLE IF NOT EXISTS data_update_requests (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        source TEXT,
        month TEXT NOT NULL,
        requested_by_name TEXT,
        requested_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      'CREATE INDEX IF NOT EXISTS idx_dur_client_month ON data_update_requests(client_id, month)',
    ], 'write');
  },
};

export default migration;
