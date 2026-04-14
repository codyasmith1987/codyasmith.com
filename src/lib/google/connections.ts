// CRUD for google_connections + lazy access-token refresh.
//
// A connection is a (admin user, Google account) pair holding a
// long-lived refresh token (encrypted) plus a short-lived access
// token with an explicit expiry. getValidAccessToken() is the only
// function the rest of the system should call to obtain a token for
// API requests — it refreshes on demand and persists the new values
// back to the row.

import { nanoid } from 'nanoid';
import turso from '../turso';
import { encryptSecret, decryptSecret } from './crypto';
import { refreshAccessToken, type GoogleOAuthEnv } from './oauth';

export interface GoogleConnection {
  id: string;
  admin_user_id: string;
  google_account_email: string;
  refresh_token_encrypted: string;
  access_token: string | null;
  access_token_expires_at: string | null;
  scopes: string[];
  connected_at: string;
  last_refresh_at: string | null;
  last_refresh_error: string | null;
}

function rowToConnection(row: any[]): GoogleConnection {
  let scopes: string[] = [];
  try {
    const parsed = JSON.parse((row[6] as string | null) ?? '[]');
    if (Array.isArray(parsed)) scopes = parsed.filter((s) => typeof s === 'string');
  } catch {}
  return {
    id: row[0] as string,
    admin_user_id: row[1] as string,
    google_account_email: row[2] as string,
    refresh_token_encrypted: row[3] as string,
    access_token: (row[4] as string | null) ?? null,
    access_token_expires_at: (row[5] as string | null) ?? null,
    scopes,
    connected_at: row[7] as string,
    last_refresh_at: (row[8] as string | null) ?? null,
    last_refresh_error: (row[9] as string | null) ?? null,
  };
}

const SELECT_COLS = `
  id, admin_user_id, google_account_email, refresh_token_encrypted,
  access_token, access_token_expires_at, scopes_json,
  connected_at, last_refresh_at, last_refresh_error
`;

export async function createConnection(data: {
  admin_user_id: string;
  google_account_email: string;
  refresh_token: string;
  access_token: string;
  access_token_expires_at: string;
  scopes: string[];
}): Promise<string> {
  const id = nanoid();
  const encrypted = encryptSecret(data.refresh_token);
  // Upsert: if (admin, email) already exists, replace its tokens so
  // re-connecting doesn't fail the UNIQUE constraint.
  const existing = await turso.execute({
    sql: `SELECT id FROM google_connections
          WHERE admin_user_id = ? AND google_account_email = ?`,
    args: [data.admin_user_id, data.google_account_email],
  });
  if (existing.rows.length > 0) {
    const existingId = existing.rows[0][0] as string;
    await turso.execute({
      sql: `UPDATE google_connections
            SET refresh_token_encrypted = ?,
                access_token = ?,
                access_token_expires_at = ?,
                scopes_json = ?,
                last_refresh_at = datetime('now'),
                last_refresh_error = NULL
            WHERE id = ?`,
      args: [
        encrypted,
        data.access_token,
        data.access_token_expires_at,
        JSON.stringify(data.scopes),
        existingId,
      ],
    });
    return existingId;
  }
  await turso.execute({
    sql: `INSERT INTO google_connections
          (id, admin_user_id, google_account_email, refresh_token_encrypted,
           access_token, access_token_expires_at, scopes_json, last_refresh_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    args: [
      id,
      data.admin_user_id,
      data.google_account_email,
      encrypted,
      data.access_token,
      data.access_token_expires_at,
      JSON.stringify(data.scopes),
    ],
  });
  return id;
}

export async function getConnectionById(id: string): Promise<GoogleConnection | null> {
  const r = await turso.execute({
    sql: `SELECT ${SELECT_COLS} FROM google_connections WHERE id = ?`,
    args: [id],
  });
  if (r.rows.length === 0) return null;
  return rowToConnection(Array.from(r.rows[0] as any));
}

export async function listConnectionsForAdmin(
  adminUserId: string
): Promise<GoogleConnection[]> {
  const r = await turso.execute({
    sql: `SELECT ${SELECT_COLS} FROM google_connections WHERE admin_user_id = ? ORDER BY connected_at DESC`,
    args: [adminUserId],
  });
  return r.rows.map((row) => rowToConnection(Array.from(row as any)));
}

export async function deleteConnection(id: string): Promise<void> {
  await turso.execute({
    sql: `DELETE FROM google_connections WHERE id = ?`,
    args: [id],
  });
}

// Returns a valid access token for API calls. Refreshes via the
// refresh_token if the stored access_token is missing or expires
// within 60 seconds. Persists the new access_token + expiry. On
// refresh failure, writes the error to last_refresh_error and
// rethrows so the caller can surface it.
export async function getValidAccessToken(
  connectionId: string,
  env?: GoogleOAuthEnv
): Promise<string> {
  const conn = await getConnectionById(connectionId);
  if (!conn) throw new Error(`google connection ${connectionId} not found`);

  const nowMs = Date.now();
  const expiresAtMs = conn.access_token_expires_at
    ? new Date(conn.access_token_expires_at).getTime()
    : 0;
  if (conn.access_token && expiresAtMs - nowMs > 60 * 1000) {
    return conn.access_token;
  }

  const refreshToken = decryptSecret(conn.refresh_token_encrypted);
  try {
    const token = await refreshAccessToken(refreshToken, env);
    const newExpiry = new Date(nowMs + token.expires_in * 1000).toISOString();
    await turso.execute({
      sql: `UPDATE google_connections
            SET access_token = ?,
                access_token_expires_at = ?,
                last_refresh_at = datetime('now'),
                last_refresh_error = NULL
            WHERE id = ?`,
      args: [token.access_token, newExpiry, connectionId],
    });
    return token.access_token;
  } catch (err) {
    await turso.execute({
      sql: `UPDATE google_connections
            SET last_refresh_error = ?, last_refresh_at = datetime('now')
            WHERE id = ?`,
      args: [String((err as Error)?.message ?? err), connectionId],
    });
    throw err;
  }
}
