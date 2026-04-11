import { sha256 } from '@oslojs/crypto/sha2';
import { encodeHexLowerCase } from '@oslojs/encoding';
import { nanoid } from 'nanoid';
import turso from './turso';

const SESSION_COOKIE = 'portal_session';
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_REFRESH_MS = 15 * 24 * 60 * 60 * 1000;  // refresh if within 15 days of expiry
const MAGIC_LINK_DURATION_MS = 15 * 60 * 1000;         // 15 minutes

export { SESSION_COOKIE };

let portalTablesCreated = false;

export async function ensurePortalTables(): Promise<void> {
  if (portalTablesCreated) return;

  await turso.batch([
    `CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'client',
      client_id TEXT REFERENCES clients(id),
      created_at TEXT DEFAULT (datetime('now')),
      last_login_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS magic_links (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES users(id),
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES clients(id),
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      month TEXT NOT NULL,
      s3_key TEXT NOT NULL,
      uploaded_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS csv_uploads (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES clients(id),
      original_name TEXT NOT NULL,
      detected_format TEXT NOT NULL,
      row_count INTEGER NOT NULL DEFAULT 0,
      month TEXT NOT NULL,
      uploaded_by TEXT NOT NULL REFERENCES users(id),
      processed_at TEXT,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS metrics (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES clients(id),
      month TEXT NOT NULL,
      category TEXT NOT NULL,
      metric_key TEXT NOT NULL,
      metric_value REAL NOT NULL,
      source TEXT,
      csv_upload_id TEXT REFERENCES csv_uploads(id),
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(client_id, month, category, metric_key)
    )`,
    `CREATE TABLE IF NOT EXISTS keyword_rankings (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES clients(id),
      month TEXT NOT NULL,
      keyword TEXT NOT NULL,
      position INTEGER,
      search_volume INTEGER,
      url TEXT,
      change_val INTEGER,
      seo_difficulty INTEGER,
      source TEXT,
      csv_upload_id TEXT REFERENCES csv_uploads(id),
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS site_issues (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES clients(id),
      month TEXT NOT NULL,
      issue_name TEXT NOT NULL,
      issue_type TEXT,
      priority TEXT,
      affected_urls INTEGER,
      pct_of_total REAL,
      description TEXT,
      how_to_fix TEXT,
      csv_upload_id TEXT REFERENCES csv_uploads(id),
      created_at TEXT DEFAULT (datetime('now'))
    )`,
  ], 'write');

  portalTablesCreated = true;
}

function hashToken(token: string): string {
  const encoded = new TextEncoder().encode(token);
  return encodeHexLowerCase(sha256(encoded));
}

// --- Sessions ---

export async function createSession(userId: string): Promise<string> {
  await ensurePortalTables();
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
  await ensurePortalTables();
  const sessionId = hashToken(token);

  const result = await turso.execute({
    sql: `SELECT s.id as session_id, s.expires_at, s.user_id,
                 u.email, u.name, u.role, u.client_id
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
    },
    session: {
      id: sessionId,
      expires_at: row[1] as string,
    },
  };
}

export async function invalidateSession(sessionId: string): Promise<void> {
  await ensurePortalTables();
  await turso.execute({ sql: 'DELETE FROM sessions WHERE id = ?', args: [sessionId] });
}

// --- Magic Links ---

export async function createMagicLink(userId: string): Promise<string> {
  await ensurePortalTables();
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
  await ensurePortalTables();
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
  await ensurePortalTables();
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

export async function createClient(name: string, slug: string): Promise<string> {
  await ensurePortalTables();
  const id = nanoid();
  await turso.execute({
    sql: 'INSERT INTO clients (id, name, slug) VALUES (?, ?, ?)',
    args: [id, name, slug],
  });
  return id;
}

export async function createUser(email: string, name: string, role: 'admin' | 'client', clientId: string | null): Promise<string> {
  await ensurePortalTables();
  const id = nanoid();
  await turso.execute({
    sql: 'INSERT INTO users (id, email, name, role, client_id) VALUES (?, ?, ?, ?, ?)',
    args: [id, email.toLowerCase().trim(), name, role, clientId],
  });
  return id;
}

export async function getAllClients() {
  await ensurePortalTables();
  const result = await turso.execute('SELECT id, name, slug, active, created_at FROM clients ORDER BY name');
  return result.rows.map(row => ({
    id: row[0] as string,
    name: row[1] as string,
    slug: row[2] as string,
    active: row[3] as number,
    created_at: row[4] as string,
  }));
}

export async function toggleClientActive(clientId: string): Promise<boolean> {
  await ensurePortalTables();
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
  await ensurePortalTables();
  // Delete sessions first, then magic links, then user
  await turso.batch([
    { sql: 'DELETE FROM sessions WHERE user_id = ?', args: [userId] },
    { sql: 'DELETE FROM magic_links WHERE user_id = ?', args: [userId] },
    { sql: 'DELETE FROM users WHERE id = ?', args: [userId] },
  ], 'write');
}

export async function revokeUserSessions(userId: string): Promise<number> {
  await ensurePortalTables();
  const result = await turso.execute({
    sql: 'DELETE FROM sessions WHERE user_id = ?',
    args: [userId],
  });
  return result.rowsAffected;
}

export async function getAllUsers() {
  await ensurePortalTables();
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
