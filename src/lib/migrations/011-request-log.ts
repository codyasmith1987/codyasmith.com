// First-party request logging for the public surface.
// Captures path, method, referrer, user-agent, country, status code.
// No IP stored. No cookies. Used for traffic patterns and debugging.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '011-request-log',
  async up() {
    await turso.batch([
      `CREATE TABLE IF NOT EXISTS request_log (
        id TEXT PRIMARY KEY,
        timestamp TEXT DEFAULT (datetime('now')),
        path TEXT NOT NULL,
        method TEXT NOT NULL,
        referrer TEXT,
        user_agent TEXT,
        country TEXT,
        status_code INTEGER
      )`,
      'CREATE INDEX IF NOT EXISTS idx_request_log_path_time ON request_log(path, timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_request_log_referrer_time ON request_log(referrer, timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_request_log_time ON request_log(timestamp)',
    ], 'write');
  },
};

export default migration;
