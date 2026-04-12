// Notifications — in-app notification system for both admin and client users

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '009-notifications',
  async up() {
    await turso.batch([
      `CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        entity_type TEXT,
        entity_id TEXT,
        read INTEGER NOT NULL DEFAULT 0,
        read_at TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`,

      'CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read, created_at)',
      'CREATE INDEX IF NOT EXISTS idx_notifications_entity ON notifications(entity_type, entity_id)',
    ], 'write');
  },
};

export default migration;
