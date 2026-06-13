// Per-user active flag (Cody, 2026-06-13). The correct way to remove a user's
// access while RETAINING their account and all history (audit trail,
// notifications, business records) is to deactivate, not hard-delete. This adds
// the flag; enforcement lives in login, verify, the middleware session check,
// and the link-issuing endpoints so a deactivated user cannot get back in by
// any path.
//
// Additive + defaulted to 1 (active), so every existing user is unaffected.
// ALTER guarded by a PRAGMA check for idempotency (mirrors migration 068).

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '072-users-active',
  async up() {
    const info = await turso.execute(`PRAGMA table_info(users)`);
    const have = new Set(info.rows.map(r => String(r[1])));
    if (!have.has('active')) {
      await turso.execute(`ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1`);
    }
  },
};

export default migration;
