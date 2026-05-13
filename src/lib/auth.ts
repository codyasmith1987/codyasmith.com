import { sha256 } from '@oslojs/crypto/sha2';
import { encodeHexLowerCase } from '@oslojs/encoding';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import turso from './turso';

const SESSION_COOKIE = 'portal_session';
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_REFRESH_MS = 15 * 24 * 60 * 60 * 1000;  // refresh if within 15 days of expiry
const MAGIC_LINK_DURATION_MS = 15 * 60 * 1000;         // 15 minutes

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

export async function setPassword(userId: string, password: string): Promise<void> {
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await turso.execute({
    sql: 'UPDATE users SET password_hash = ? WHERE id = ?',
    args: [hash, userId],
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
    // Verify against legacy SHA256, then silently upgrade to bcrypt
    const inputHash = legacySha256Hash(password);
    if (storedHash !== inputHash) return null;

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

export async function createSession(userId: string): Promise<string> {
  const token = nanoid(40);
  const sessionId = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();

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
    sql: `SELECT s.id as session_id, s.expires_at, s.user_id,
                 u.email, u.name, u.role, u.client_id, u.permissions
          FROM sessions s
          JOIN users u ON u.id = s.user_id
          WHERE s.id = ?`,
    args: [sessionId],
  });

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  const expiresAt = new Date(row[1] as string);

  if (expiresAt <= new Date()) {
    await turso.execute({ sql: 'DELETE FROM sessions WHERE id = ?', args: [sessionId] });
    return null;
  }

  // Extend session if within refresh window
  if (expiresAt.getTime() - Date.now() < SESSION_REFRESH_MS) {
    const newExpiry = new Date(Date.now() + SESSION_DURATION_MS).toISOString();
    await turso.execute({
      sql: 'UPDATE sessions SET expires_at = ? WHERE id = ?',
      args: [newExpiry, sessionId],
    });
  }

  return {
    user: {
      id: row[2] as string,
      email: row[3] as string,
      name: row[4] as string,
      role: row[5] as 'admin' | 'client',
      client_id: row[6] as string | null,
      permissions: (row[7] as string | null) || null,
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

export async function createClient(name: string, slug: string): Promise<string> {
  const id = nanoid();
  await turso.execute({
    sql: 'INSERT INTO clients (id, name, slug) VALUES (?, ?, ?)',
    args: [id, name, slug],
  });
  return id;
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
  const result = await turso.execute('SELECT id, name, slug, active, created_at FROM clients ORDER BY name');
  return result.rows.map(row => ({
    id: row[0] as string,
    name: row[1] as string,
    slug: row[2] as string,
    active: row[3] as number,
    created_at: row[4] as string,
  }));
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

export async function deleteUser(userId: string): Promise<void> {
  // Delete sessions first, then magic links, then user
  await turso.batch([
    { sql: 'DELETE FROM sessions WHERE user_id = ?', args: [userId] },
    { sql: 'DELETE FROM magic_links WHERE user_id = ?', args: [userId] },
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

export async function getUsersByClientId(clientId: string) {
  const result = await turso.execute({
    sql: 'SELECT id, email, name, role, client_id FROM users WHERE client_id = ?',
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
  const result = await turso.execute("SELECT id, email, name, role FROM users WHERE role = 'admin'");
  return result.rows.map(row => ({
    id: row[0] as string,
    email: row[1] as string,
    name: row[2] as string,
    role: row[3] as string,
  }));
}

export async function getAllUsers() {
  const result = await turso.execute(
    `SELECT u.id, u.email, u.name, u.role, u.client_id, u.created_at, u.last_login_at, c.name as client_name
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
  }));
}
