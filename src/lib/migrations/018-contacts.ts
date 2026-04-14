// Phase 1 Slice 12 — contacts / roles.
//
// Until now, "who to email about this client" collapsed onto whichever
// users rows had client_id = that client. That assumes every relevant
// person at the client is also a portal login user, which is false:
// AP departments, outside accountants, and technical owners who never
// log in still need to receive invoices / reminders / update emails.
//
// A contacts row is a person attached to a client with one or more
// roles. Roles are stored as a JSON array so a single contact can be
// both billing + primary without needing a join table. Two explicit
// boolean flags (receives_invoices, receives_reminders) let routing
// code filter deterministically without re-parsing the roles array.
//
// user_id is an optional FK back to users — set when the contact is
// also a portal login user. Null when they aren't.
//
// UNIQUE(client_id, email) prevents the same person from being added
// twice by accident. The active flag lets rows be soft-deleted so
// historical activity_log entries naming a since-removed contact
// still resolve.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '018-contacts',
  async up() {
    await turso.batch(
      [
        `CREATE TABLE IF NOT EXISTS contacts (
          id TEXT PRIMARY KEY,
          client_id TEXT NOT NULL REFERENCES clients(id),
          name TEXT NOT NULL,
          email TEXT NOT NULL,
          roles_json TEXT NOT NULL DEFAULT '[]',
          receives_invoices INTEGER NOT NULL DEFAULT 0,
          receives_reminders INTEGER NOT NULL DEFAULT 0,
          user_id TEXT REFERENCES users(id),
          active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT DEFAULT (datetime('now')),
          UNIQUE(client_id, email)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_contacts_client
         ON contacts(client_id)`,
        `CREATE INDEX IF NOT EXISTS idx_contacts_active
         ON contacts(client_id, active)`,
      ],
      'write'
    );
  },
};

export default migration;
