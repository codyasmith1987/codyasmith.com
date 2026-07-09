// Password reset tokens (Cody, 2026-06-13). Kept SEPARATE from magic_links on
// purpose: a magic link mints a session and is the onboarding path for users
// with no password yet; a password reset token does the opposite. It only
// authorizes setting a NEW password for a user who ALREADY has one, and never
// creates a session, so it can never be used as a passwordless login bypass
// (the thing SEC3-008 / the middleware password-set gate exist to prevent).
// Single-use, short-lived, stored as a SHA-256 hash like magic_links.
//
// Additive + idempotent (CREATE TABLE IF NOT EXISTS), so existing data is
// untouched.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '071-password-reset-tokens',
  async up() {
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL REFERENCES users(id),
        expires_at TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
  },
};

export default migration;
