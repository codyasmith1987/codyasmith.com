// Activity logging table — audit trail for all portal actions

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '003-activity-log',
  async up() {
    await turso.batch([
      `CREATE TABLE IF NOT EXISTS activity_log (
        id TEXT PRIMARY KEY,
        client_id TEXT REFERENCES clients(id),
        user_id TEXT REFERENCES users(id),
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`,
      'CREATE INDEX IF NOT EXISTS idx_activity_client ON activity_log(client_id, created_at)',
      'CREATE INDEX IF NOT EXISTS idx_activity_entity ON activity_log(entity_type, entity_id)',
      'CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_log(user_id, created_at)',
    ], 'write');
  },
};

export default migration;
