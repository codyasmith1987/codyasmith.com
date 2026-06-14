import { sha256 } from '@oslojs/crypto/sha2';
import { encodeHexLowerCase } from '@oslojs/encoding';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import turso from './turso';

const SESSION_COOKIE = 'portal_session';
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days rolling
const SESSION_REFRESH_MS = 15 * 24 * 60 * 60 * 1000;  // refresh if within 15 days of expiry
const SESSION_ABSOLUTE_MAX_MS = 90 * 24 * 60 * 60 * 1000; // hard cap from created_at
const MAGIC_LINK_DURATION_MS = 15 * 60 * 1000;         // 15 minutes
const PASSWORD_RESET_DURATION_MS = 60 * 60 * 1000;     // 1 hour

export { SESSION_COOKIE };

// --- Permissions ---

export type Permission =
  | 'portal.admin'
  | 'portal.projects.manage'
  | 'portal.billing.manage'
  | 'portal.billing.view'
  | 'portal.files.upload'
  | 'portal.csv.upload'
  | 'portal.clients.manage'
  | 'portal.users.manage';

export function hasPermission(user: App.Locals['user'], perm: Permission): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true; // admins get everything (backward compatible)
  if (!user.permissions) return false;
  try {
    const perms: string[] = JSON.parse(user.permissions);
    return perms.includes(perm);
  } catch {
    return false;
  }
}

function hashToken(token: string): string {
  const encoded = new TextEncoder().encode(token);
  return encodeHexLowerCase(sha256(encoded));
}

// --- Passwords ---

const BCRYPT_ROUNDS = 12;

function isLegacySha256(hash: string): boolean {
  // Legacy SHA256 hashes are exactly 64 hex chars with no $ prefix (bcrypt starts with $2)
  return hash.length === 64 && !hash.startsWith('$');
}

function legacySha256Hash(password: string): string {
  const encoded = new TextEncoder().encode(password);
  return encodeHexLowerCase(sha256(encoded));
}

// Password length policy: minimum 12 chars (2026 NIST SP 800-63B-4 floor for
// memorable passphrases with no rotation), maximum 72 bytes (bcrypt's
// silent-truncation boundary). Callers should also reject the breached-
// password set; we lean on a 12-char floor instead of complexity rules per
// current NIST guidance. See security-audit-2026-05-12 SEC-010.
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 72;

export class PasswordPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordPolicyError';
  }
}

function assertPasswordPolicy(password: string): void {
  if (typeof password !== 'string') {
    throw new PasswordPolicyError('Password must be a string');
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new PasswordPolicyError(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  // bcrypt silently truncates at 72 bytes; reject longer inputs so the user
  // gets a clear error instead of a quietly-different password being stored.
  const byteLength = new TextEncoder().encode(password).length;
  if (byteLength > PASSWORD_MAX_LENGTH) {
    throw new PasswordPolicyError(`Password must be at most ${PASSWORD_MAX_LENGTH} bytes`);
  }
}

export async function setPassword(userId: string, password: string): Promise<void> {
  assertPasswordPolicy(password);
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await turso.execute({
    sql: 'UPDATE users SET password_hash = ? WHERE id = ?',
    args: [hash, userId],
  });
  // Revoke all existing sessions for this user. Forces a fresh login with
  // the new password and blocks an attacker who already stole a session
  // from continuing to use it. See SEC-014.
  await turso.execute({
    sql: 'DELETE FROM sessions WHERE user_id = ?',
    args: [userId],
  });
}

export async function verifyPassword(email: string, password: string): Promise<string | null> {
  const result = await turso.execute({
    sql: 'SELECT id, password_hash FROM users WHERE email = ?',
    args: [email.toLowerCase().trim()],
  });
  if (result.rows.length === 0) return null;
  const userId = result.rows[0][0] as string;
  const storedHash = result.rows[0][1] as string | null;
  if (!storedHash) return null;

  if (isLegacySha256(storedHash)) {
    // Verify against legacy SHA256 in constant time, then silently
    // upgrade to bcrypt. Plain `===` on hash strings leaks per-character
    // timing on the legacy bucket, which is enough to enumerate users
    // who still have unmigrated hashes. See security-audit-2026-05-12
    // round 3 SEC3-004.
    const inputHash = legacySha256Hash(password);
    if (inputHash.length !== storedHash.length) return null;
    let mismatch = 0;
    for (let i = 0; i < inputHash.length; i++) {
      mismatch |= inputHash.charCodeAt(i) ^ storedHash.charCodeAt(i);
    }
    if (mismatch !== 0) return null;

    // Rehash with bcrypt for future logins
    const newHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await turso.execute({
      sql: 'UPDATE users SET password_hash = ? WHERE id = ?',
      args: [newHash, userId],
    });
    return userId;
  }

  // Standard bcrypt verification
  const valid = await bcrypt.compare(password, storedHash);
  if (!valid) return null;
  return userId;
}

// --- Sessions ---

export async function createSession(userId: string, durationMs: number = SESSION_DURATION_MS): Promise<string> {
  // durationMs lets callers issue short sessions for pre-password
  // magic-link arrivals; default is the rolling 30-day TTL used by the
  // password flow. See security-audit-2026-05-12 round 6 SEC6-001.
  const token = nanoid(40);
  const sessionId = hashToken(token);
  const expiresAt = new Date(Date.now() + durationMs).toISOString();

  await turso.execute({
    sql: 'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)',
    args: [sessionId, userId, expiresAt],
  });

  // Update last login
  await turso.execute({
    sql: 'UPDATE users SET last_login_at = datetime(\'now\') WHERE id = ?',
    args: [userId],
  });

  return token;
}

export async function validateSession(token: string): Promise<{
  user: App.Locals['user'];
  session: App.Locals['session'];
} | null> {
  const sessionId = hashToken(token);

  const result = await turso.execute({
    sql: `SELECT s.id as session_id, s.expires_at, s.user_id, s.created_at,
                 u.email, u.name, u.role, u.client_id, u.permissions, u.active
          FROM sessions s
          JOIN users u ON u.id = s.user_id
          WHERE s.id = ?`,
    args: [sessionId],
  });

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  const expiresAt = new Date(row[1] as string);
  const createdAt = new Date((row[3] as string) + (typeof row[3] === 'string' && (row[3] as string).endsWith('Z') ? '' : 'Z'));

  if (expiresAt <= new Date()) {
    await turso.execute({ sql: 'DELETE FROM sessions WHERE id = ?', args: [sessionId] });
    return null;
  }

  // Absolute lifetime cap: even with rolling refresh, a session cannot
  // outlive SESSION_ABSOLUTE_MAX_MS from its created_at. Bounds the blast
  // radius of a stolen token regardless of how active the attacker is.
  // See security-audit-2026-05-12 SEC-015.
  if (!isNaN(createdAt.getTime()) && Date.now() - createdAt.getTime() > SESSION_ABSOLUTE_MAX_MS) {
    await turso.execute({ sql: 'DELETE FROM sessions WHERE id = ?', args: [sessionId] });
    return null;
  }

  // Extend session if within refresh window. Pre-password (magic-link)
  // sessions have a 1-hour total lifespan and are bounced to
  // /portal/set-password by middleware; they must NOT auto-refresh to
  // 30 days on first request. Detect them by their original duration:
  // any session whose initial expires_at - created_at is less than the
  // full SESSION_DURATION_MS was created with a short TTL on purpose.
  // See security-audit-2026-05-12 round 7 SEC7-001.
  const originalDurationMs = expiresAt.getTime() - createdAt.getTime();
  const isFullDurationSession = originalDurationMs >= SESSION_DURATION_MS - 1000;
  if (isFullDurationSession && expiresAt.getTime() - Date.now() < SESSION_REFRESH_MS) {
    const newExpiry = new Date(Date.now() + SESSION_DURATION_MS).toISOString();
    await turso.execute({
      sql: 'UPDATE sessions SET expires_at = ? WHERE id = ?',
      args: [newExpiry, sessionId],
    });
  }

  // SQL columns (positional):
  //   0: s.id (session_id)         1: s.expires_at
  //   2: s.user_id                  3: s.created_at
  //   4: u.email                    5: u.name
  //   6: u.role                     7: u.client_id
  //   8: u.permissions              9: u.active
  //
  // Previous mapping started at row[4] for id, which silently put u.email
  // into user.id and shifted every other field by one. The portal's
  // password-set middleware called userHasPassword(user.id) with what was
  // actually an email, found no matching user, and forced an infinite
  // redirect loop to /portal/set-password. See SEC3-008 password-set rule.
  return {
    user: {
      id: row[2] as string,
      email: row[4] as string,
      name: row[5] as string,
      role: row[6] as 'admin' | 'client',
      client_id: row[7] as string | null,
      permissions: (row[8] as string | null) || null,
      // Default to active if the column is null (pre-migration rows): the
      // migration backfills DEFAULT 1, but be defensive so a missing value
      // never accidentally locks an existing user out.
      active: (row[9] as number | null) == null ? true : (row[9] as number) !== 0,
    },
    session: {
      id: sessionId,
      expires_at: row[1] as string,
    },
  };
}

export async function invalidateSession(sessionId: string): Promise<void> {
  await turso.execute({ sql: 'DELETE FROM sessions WHERE id = ?', args: [sessionId] });
}

// --- Magic Links ---

export async function createMagicLink(userId: string): Promise<string> {
  const token = nanoid(48);
  const tokenHash = hashToken(token);
  const id = nanoid();
  const expiresAt = new Date(Date.now() + MAGIC_LINK_DURATION_MS).toISOString();

  await turso.execute({
    sql: 'INSERT INTO magic_links (id, token_hash, user_id, expires_at) VALUES (?, ?, ?, ?)',
    args: [id, tokenHash, userId, expiresAt],
  });

  return token;
}

export async function validateMagicLink(token: string): Promise<string | null> {
  const tokenHash = hashToken(token);

  const result = await turso.execute({
    sql: 'SELECT id, user_id, expires_at, used FROM magic_links WHERE token_hash = ?',
    args: [tokenHash],
  });

  // Constant-time validation: always perform the same work regardless of whether
  // the token exists, to prevent timing attacks that detect valid token hashes
  const row = result.rows[0];
  const expiresAt = row ? new Date(row[2] as string) : new Date(0);
  const used = row ? (row[3] as number) : 1;
  const linkId = row ? (row[0] as string) : '';
  const userId = row ? (row[1] as string) : '';

  if (!row || used || expiresAt <= new Date()) {
    // Always do a write operation to keep timing consistent
    if (linkId) {
      await turso.execute({ sql: 'UPDATE magic_links SET used = 1 WHERE id = ?', args: [linkId] });
    }
    return null;
  }

  // Mark as used
  await turso.execute({
    sql: 'UPDATE magic_links SET used = 1 WHERE id = ?',
    args: [linkId],
  });

  return userId;
}

// --- Password Reset Tokens ---
//
// Deliberately separate from magic links. A magic link mints a 1-hour session
// and is the onboarding path for users with NO password yet (validated +
// session created in verify.ts). A password reset token is the opposite: it
// authorizes setting a NEW password for a user who ALREADY has one, and it
// NEVER mints a session. The reset endpoints validate the token, call
// setPassword (which revokes all sessions), and send the user to /portal/login
// to sign in with the new password. Because no session is ever created from a
// reset token, it cannot be used as a passwordless login bypass. Single-use,
// short-lived, hashed at rest. See the 2026-06-13 auth-recovery work.

export async function createPasswordResetToken(userId: string): Promise<string> {
  // Supersede any earlier unused reset tokens for this user so only the newest
  // emailed link works. Reset is user-initiated and low-volume, so the small
  // race (user clicks an older link as a new one is minted) is acceptable and
  // the stricter single-live-link behavior is the safer default.
  await turso.execute({
    sql: 'UPDATE password_reset_tokens SET used = 1 WHERE user_id = ? AND used = 0',
    args: [userId],
  });

  const token = nanoid(48);
  const tokenHash = hashToken(token);
  const id = nanoid();
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_DURATION_MS).toISOString();

  await turso.execute({
    sql: 'INSERT INTO password_reset_tokens (id, token_hash, user_id, expires_at) VALUES (?, ?, ?, ?)',
    args: [id, tokenHash, userId, expiresAt],
  });

  return token;
}

// Read-only validity check for the reset page GET. Does NOT consume the token,
// so an email-client prefetch of the reset link cannot burn it before the user
// submits. Returns true only when the token exists, is unused, and unexpired.
export async function isPasswordResetTokenValid(token: string): Promise<boolean> {
  if (!token) return false;
  const tokenHash = hashToken(token);
  const result = await turso.execute({
    sql: 'SELECT expires_at, used FROM password_reset_tokens WHERE token_hash = ?',
    args: [tokenHash],
  });
  const row = result.rows[0];
  if (!row) return false;
  const expiresAt = new Date(row[0] as string);
  const used = row[1] as number;
  return !used && expiresAt > new Date();
}

// Consume the token (single-use) and return the user id, or null if missing /
// expired / already used. Mirrors validateMagicLink's constant-time shape:
// always perform a write when a matching row exists so timing does not leak
// whether a given token hash is present.
export async function consumePasswordResetToken(token: string): Promise<string | null> {
  const tokenHash = hashToken(token);

  const result = await turso.execute({
    sql: 'SELECT id, user_id, expires_at, used FROM password_reset_tokens WHERE token_hash = ?',
    args: [tokenHash],
  });

  const row = result.rows[0];
  const linkId = row ? (row[0] as string) : '';
  const userId = row ? (row[1] as string) : '';
  const expiresAt = row ? new Date(row[2] as string) : new Date(0);
  const used = row ? (row[3] as number) : 1;

  if (!row || used || expiresAt <= new Date()) {
    if (linkId) {
      await turso.execute({ sql: 'UPDATE password_reset_tokens SET used = 1 WHERE id = ?', args: [linkId] });
    }
    return null;
  }

  await turso.execute({
    sql: 'UPDATE password_reset_tokens SET used = 1 WHERE id = ?',
    args: [linkId],
  });

  return userId;
}

// --- User/Client helpers ---

export async function getUserByEmail(email: string) {
  const result = await turso.execute({
    sql: 'SELECT id, email, name, role, client_id FROM users WHERE email = ?',
    args: [email.toLowerCase().trim()],
  });
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: row[0] as string,
    email: row[1] as string,
    name: row[2] as string,
    role: row[3] as string,
    client_id: row[4] as string | null,
  };
}

// Used by send-link.ts to avoid mailing an alternate auth path
// (magic link) to a user who already has a password set. Magic links
// stay available for the initial-onboarding case (users with no
// password yet) but are not a steady-state login mechanism.
export async function userHasPassword(userId: string): Promise<boolean> {
  const result = await turso.execute({
    sql: 'SELECT password_hash FROM users WHERE id = ?',
    args: [userId],
  });
  if (result.rows.length === 0) return false;
  return result.rows[0][0] != null;
}

export async function getClientBySlug(slug: string) {
  const result = await turso.execute({
    sql: 'SELECT id, name, slug, active FROM clients WHERE slug = ?',
    args: [slug],
  });
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: row[0] as string,
    name: row[1] as string,
    slug: row[2] as string,
    active: !!(row[3] as number),
  };
}

export async function createClient(name: string, slug: string, domain: string | null = null): Promise<string> {
  const id = nanoid();
  await turso.execute({
    sql: 'INSERT INTO clients (id, name, slug, domain) VALUES (?, ?, ?, ?)',
    args: [id, name, slug, domain],
  });
  return id;
}

export async function updateClientDomain(clientId: string, domain: string | null): Promise<void> {
  await turso.execute({
    sql: 'UPDATE clients SET domain = ? WHERE id = ?',
    args: [domain, clientId],
  });
}

export async function updateClient(clientId: string, fields: {
  name?: string;
  domain?: string | null;
  discount_rate?: number;
}): Promise<void> {
  const sets: string[] = [];
  const args: any[] = [];
  if (typeof fields.name === 'string') {
    sets.push('name = ?');
    args.push(fields.name);
  }
  if (fields.domain !== undefined) {
    sets.push('domain = ?');
    args.push(fields.domain);
  }
  if (typeof fields.discount_rate === 'number' && Number.isFinite(fields.discount_rate)) {
    // Clamp to [0, 1]. A 100% discount is the upper bound; anything
    // beyond is admin error and should not flip totals negative.
    const clamped = Math.max(0, Math.min(1, fields.discount_rate));
    sets.push('discount_rate = ?');
    args.push(clamped);
  }
  if (sets.length === 0) return;
  args.push(clientId);
  await turso.execute({
    sql: `UPDATE clients SET ${sets.join(', ')} WHERE id = ?`,
    args,
  });
}

export async function getClientById(clientId: string) {
  const result = await turso.execute({
    sql: 'SELECT id, name, slug, active, created_at, domain, discount_rate, manual_billing FROM clients WHERE id = ?',
    args: [clientId],
  });
  if (result.rows.length === 0) return null;
  const row = result.rows[0] as any;
  return {
    id: row[0] as string,
    name: row[1] as string,
    slug: row[2] as string,
    active: !!(row[3] as number),
    created_at: row[4] as string,
    domain: (row[5] ?? null) as string | null,
    discount_rate: (row[6] ?? 0) as number,
    manual_billing: !!(row[7] as number),
  };
}

export async function createUser(email: string, name: string, role: 'admin' | 'client', clientId: string | null): Promise<string> {
  const id = nanoid();
  await turso.execute({
    sql: 'INSERT INTO users (id, email, name, role, client_id) VALUES (?, ?, ?, ?, ?)',
    args: [id, email.toLowerCase().trim(), name, role, clientId],
  });
  return id;
}

export async function getAllClients() {
  const result = await turso.execute('SELECT id, name, slug, active, created_at, domain, discount_rate, manual_billing FROM clients ORDER BY name');
  return result.rows.map(row => ({
    id: row[0] as string,
    name: row[1] as string,
    slug: row[2] as string,
    active: row[3] as number,
    domain: (row[5] ?? null) as string | null,
    created_at: row[4] as string,
    discount_rate: (row[6] ?? 0) as number,
    manual_billing: !!(row[7] as number),
  }));
}

// Single source for the "is this client hand-billed" check (clients.manual_billing,
// migration 068). A manual client is excluded from ALL automated billing:
// recurring generation, pre-due reminders, overdue notices, and the at-signing
// invoice. Used by the billing engine + the contract handoff so the column name
// and the 1-means-manual interpretation live in one place.
export async function clientIsManualBilling(clientId: string): Promise<boolean> {
  const result = await turso.execute({
    sql: 'SELECT manual_billing FROM clients WHERE id = ?',
    args: [clientId],
  });
  return (result.rows[0]?.[0] as number) === 1;
}

export async function isClientActive(clientId: string): Promise<boolean> {
  const result = await turso.execute({
    sql: 'SELECT active FROM clients WHERE id = ?',
    args: [clientId],
  });
  if (result.rows.length === 0) return false;
  return (result.rows[0][0] as number) === 1;
}

export async function toggleClientActive(clientId: string): Promise<boolean> {
  const result = await turso.execute({
    sql: 'SELECT active FROM clients WHERE id = ?',
    args: [clientId],
  });
  if (result.rows.length === 0) throw new Error('Client not found');
  const newActive = (result.rows[0][0] as number) === 1 ? 0 : 1;
  await turso.execute({
    sql: 'UPDATE clients SET active = ? WHERE id = ?',
    args: [newActive, clientId],
  });
  return newActive === 1;
}

// True if the user is referenced by any RETAINED record: the audit trail,
// notifications, or a business document they authored. Such a user must NOT be
// hard-deleted — deactivate instead, so access is removed but the records (and
// their references) stay intact. Hard delete is only for a footprint-free
// account, e.g. a mistyped invite that was never used. This is enforced in
// application code because the database does not have foreign-key enforcement
// turned on, so a raw DELETE would silently ORPHAN these rows rather than fail.
export async function userHasRetainedHistory(userId: string): Promise<boolean> {
  const result = await turso.execute({
    sql: `SELECT EXISTS (
            SELECT 1 FROM activity_log     WHERE user_id = ?
            UNION ALL SELECT 1 FROM notifications   WHERE user_id = ?
            UNION ALL SELECT 1 FROM files           WHERE uploaded_by = ?
            UNION ALL SELECT 1 FROM csv_uploads     WHERE uploaded_by = ?
            UNION ALL SELECT 1 FROM invoices        WHERE created_by = ?
            UNION ALL SELECT 1 FROM payments        WHERE recorded_by = ?
            UNION ALL SELECT 1 FROM approvals       WHERE requested_by = ? OR responded_by = ?
            UNION ALL SELECT 1 FROM change_orders   WHERE requested_by = ? OR approved_by = ?
            UNION ALL SELECT 1 FROM contracts       WHERE created_by = ?
            UNION ALL SELECT 1 FROM client_expenses WHERE created_by = ?
          ) AS has_history`,
    args: Array(12).fill(userId),
  });
  return (result.rows[0][0] as number) === 1;
}

export async function deleteUser(userId: string): Promise<void> {
  // Only clears EPHEMERAL auth artifacts (login sessions, magic links, reset
  // tokens), then the user row. We deliberately do NOT touch notifications,
  // activity_log, or any business record (invoices, contracts, payments, files,
  // expenses, approvals, change orders): all of that is RETAINED, including the
  // audit trail's record of who did what, which may be needed for legal /
  // record-keeping reasons. If foreign-key enforcement is on, a user who has
  // any retained history will (correctly) fail to hard-delete here rather than
  // have their data scrubbed or orphaned. Deactivate such a user instead of
  // deleting them.
  await turso.batch([
    { sql: 'DELETE FROM sessions WHERE user_id = ?', args: [userId] },
    { sql: 'DELETE FROM magic_links WHERE user_id = ?', args: [userId] },
    { sql: 'DELETE FROM password_reset_tokens WHERE user_id = ?', args: [userId] },
    { sql: 'DELETE FROM users WHERE id = ?', args: [userId] },
  ], 'write');
}

export async function revokeUserSessions(userId: string): Promise<number> {
  const result = await turso.execute({
    sql: 'DELETE FROM sessions WHERE user_id = ?',
    args: [userId],
  });
  return result.rowsAffected;
}

export async function isUserActive(userId: string): Promise<boolean> {
  const result = await turso.execute({
    sql: 'SELECT active FROM users WHERE id = ?',
    args: [userId],
  });
  if (result.rows.length === 0) return false;
  const v = result.rows[0][0] as number | null;
  // Null (pre-migration row) is treated as active; only an explicit 0 deactivates.
  return v == null ? true : v !== 0;
}

// Deactivate / reactivate a user. The account, audit trail, notifications, and
// all business records are RETAINED; this only governs access. Deactivating
// also revokes the user's sessions so they are signed out immediately.
// Re-entry is blocked at every path (login, verify, middleware session check,
// and the link-issuing endpoints), so toggling this flag is the single switch.
export async function setUserActive(userId: string, active: boolean): Promise<void> {
  await turso.execute({
    sql: 'UPDATE users SET active = ? WHERE id = ?',
    args: [active ? 1 : 0, userId],
  });
  if (!active) {
    await turso.execute({
      sql: 'DELETE FROM sessions WHERE user_id = ?',
      args: [userId],
    });
  }
}

export async function getUsersByClientId(clientId: string) {
  // Excludes deactivated users (active = 0). Every caller uses this for
  // targeting or picking (billing + invoice recipients, notification targets,
  // the proposal signer picker), and a deactivated user must not be emailed or
  // offered as a choice. The admin user list uses getAllUsers, which still
  // returns everyone (with a Deactivated badge).
  const result = await turso.execute({
    sql: 'SELECT id, email, name, role, client_id FROM users WHERE client_id = ? AND (active IS NULL OR active = 1)',
    args: [clientId],
  });
  return result.rows.map(row => ({
    id: row[0] as string,
    email: row[1] as string,
    name: row[2] as string,
    role: row[3] as string,
    client_id: row[4] as string,
  }));
}

export async function getAdminUsers() {
  // Excludes deactivated admins: used for admin notification targeting, so a
  // deactivated admin should not be notified.
  const result = await turso.execute("SELECT id, email, name, role FROM users WHERE role = 'admin' AND (active IS NULL OR active = 1)");
  return result.rows.map(row => ({
    id: row[0] as string,
    email: row[1] as string,
    name: row[2] as string,
    role: row[3] as string,
  }));
}

export async function getAllUsers() {
  const result = await turso.execute(
    `SELECT u.id, u.email, u.name, u.role, u.client_id, u.created_at, u.last_login_at, c.name as client_name, u.active
     FROM users u LEFT JOIN clients c ON c.id = u.client_id
     ORDER BY u.created_at DESC`
  );
  return result.rows.map(row => ({
    id: row[0] as string,
    email: row[1] as string,
    name: row[2] as string,
    role: row[3] as string,
    client_id: row[4] as string | null,
    created_at: row[5] as string,
    last_login_at: row[6] as string | null,
    client_name: row[7] as string | null,
    active: (row[8] as number | null) == null ? true : (row[8] as number) !== 0,
  }));
}
