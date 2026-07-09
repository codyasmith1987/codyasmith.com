/**
 * Seed the dev2 test database with the three test users the HTTP
 * integration test runners expect:
 *
 *   admin@dev2.test       admin, no client_id            testpass123
 *   testuser@dev2.test    client of Client A             testpass123
 *   clientb@dev2.test     client of Client B             testpass123
 *
 * Run with: npx tsx scripts/seed-dev2-fixtures.ts
 *
 * Idempotent: re-runs leave existing rows in place but refresh the
 * password hash so a stale dev2.db can be brought back up to date
 * without manual surgery. Migrations should already be applied; this
 * only seeds users + their parent clients.
 *
 * Client IDs are hard-coded so tests can reference them directly:
 *   Client A  jlCeA1SCHv8D6zD4U3h0b   (slug 'dev2-test-client-a')
 *   Client B  generated on first run  (slug 'test-client-b')
 *
 * The 12-char password policy in src/lib/auth.ts only fires on the
 * setPassword() path; verifyPassword() accepts any bcrypt hash, so
 * 'testpass123' (11 chars) works when seeded directly here.
 */
import { createClient } from '@libsql/client';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import 'dotenv/config';

const turso = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const BCRYPT_ROUNDS = 12;
const TEST_PASSWORD = 'testpass123';
const CLIENT_A_ID = 'jlCeA1SCHv8D6zD4U3h0b';
const CLIENT_A_NAME = 'DEV2 TEST Client';
const CLIENT_A_SLUG = 'dev2-test-client-a';
const CLIENT_B_SLUG = 'test-client-b';
const CLIENT_B_NAME = 'DEV2 TEST Client B';

async function ensureClient(id: string | null, name: string, slug: string): Promise<string> {
  const existing = await turso.execute({
    sql: 'SELECT id FROM clients WHERE slug = ? LIMIT 1',
    args: [slug],
  });
  if (existing.rows.length > 0) {
    return existing.rows[0][0] as string;
  }
  const useId = id ?? nanoid();
  await turso.execute({
    sql: 'INSERT INTO clients (id, name, slug, active) VALUES (?, ?, ?, 1)',
    args: [useId, name, slug],
  });
  console.log(`Created client: ${name} (${useId})`);
  return useId;
}

async function ensureUser(
  email: string,
  name: string,
  role: 'admin' | 'client',
  clientId: string | null,
  password: string,
): Promise<void> {
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const existing = await turso.execute({
    sql: 'SELECT id FROM users WHERE email = ? LIMIT 1',
    args: [email],
  });
  if (existing.rows.length > 0) {
    const userId = existing.rows[0][0] as string;
    await turso.execute({
      sql: 'UPDATE users SET password_hash = ?, name = ?, role = ?, client_id = ? WHERE id = ?',
      args: [hash, name, role, clientId, userId],
    });
    console.log(`Refreshed user: ${email} (${userId})`);
    return;
  }
  const id = nanoid();
  await turso.execute({
    sql: `INSERT INTO users (id, email, name, role, client_id, password_hash)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [id, email, name, role, clientId, hash],
  });
  console.log(`Created user: ${email} (${id})`);
}

async function ensurePasswordColumn(): Promise<void> {
  try {
    await turso.execute('ALTER TABLE users ADD COLUMN password_hash TEXT');
  } catch (e: any) {
    if (!/duplicate column/i.test(String(e?.message || ''))) {
      throw e;
    }
  }
}

async function clearLoginRateLimits(): Promise<void> {
  try {
    await turso.execute({
      sql: "DELETE FROM portal_rate_limits WHERE key LIKE 'login:%'",
      args: [],
    });
  } catch (e: any) {
    if (!/no such table/i.test(String(e?.message || ''))) {
      throw e;
    }
  }
}

async function main(): Promise<void> {
  if (!process.env.TURSO_DATABASE_URL) {
    console.error('TURSO_DATABASE_URL is required. Point .env at file:./data/dev2.db before running.');
    process.exit(1);
  }
  console.log(`Seeding fixtures into ${process.env.TURSO_DATABASE_URL}`);

  await ensurePasswordColumn();
  const clientAId = await ensureClient(CLIENT_A_ID, CLIENT_A_NAME, CLIENT_A_SLUG);
  const clientBId = await ensureClient(null, CLIENT_B_NAME, CLIENT_B_SLUG);

  await ensureUser('admin@dev2.test', 'DEV2 Test Admin', 'admin', null, TEST_PASSWORD);
  await ensureUser('testuser@dev2.test', 'DEV2 Test Client A User', 'client', clientAId, TEST_PASSWORD);
  await ensureUser('clientb@dev2.test', 'DEV2 Test Client B User', 'client', clientBId, TEST_PASSWORD);
  await clearLoginRateLimits();

  console.log('\nDone. Test users seeded; password "testpass123" set for all three; login rate limits cleared.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
