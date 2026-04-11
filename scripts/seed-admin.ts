/**
 * Run with: npx tsx scripts/seed-admin.ts
 * Creates Cody's admin account and the first client (ZipKit Homes).
 */
import { createClient } from '@libsql/client';
import { nanoid } from 'nanoid';
import 'dotenv/config';

const turso = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

async function seed() {
  console.log('Creating tables...');

  await turso.batch([
    `CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'client', client_id TEXT REFERENCES clients(id),
      created_at TEXT DEFAULT (datetime('now')), last_login_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      expires_at TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS magic_links (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
    )`,
  ], 'write');

  // Create ZipKit Homes client
  const clientId = nanoid();
  try {
    await turso.execute({
      sql: 'INSERT INTO clients (id, name, slug) VALUES (?, ?, ?)',
      args: [clientId, 'ZipKit Homes', 'zipkit-homes'],
    });
    console.log(`Created client: ZipKit Homes (${clientId})`);
  } catch (e: any) {
    if (e.message?.includes('UNIQUE')) {
      console.log('Client "zipkit-homes" already exists, skipping.');
    } else throw e;
  }

  // Create Cody's admin account
  const adminId = nanoid();
  try {
    await turso.execute({
      sql: 'INSERT INTO users (id, email, name, role, client_id) VALUES (?, ?, ?, ?, ?)',
      args: [adminId, 'cody@codyasmith.com', 'Cody Smith', 'admin', null],
    });
    console.log(`Created admin: cody@codyasmith.com (${adminId})`);
  } catch (e: any) {
    if (e.message?.includes('UNIQUE')) {
      console.log('Admin "cody@codyasmith.com" already exists, skipping.');
    } else throw e;
  }

  console.log('\nDone! You can now log in at /portal/login with cody@codyasmith.com');
}

seed().catch(console.error);
