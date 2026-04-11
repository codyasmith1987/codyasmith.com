// Persistent rate limiting table — replaces in-memory Map

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '004-rate-limits-persistent',
  async up() {
    await turso.batch([
      `CREATE TABLE IF NOT EXISTS portal_rate_limits (
        key TEXT NOT NULL,
        window_start TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (key, window_start)
      )`,
    ], 'write');
  },
};

export default migration;
