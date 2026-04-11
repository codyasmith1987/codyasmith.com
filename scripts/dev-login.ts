/**
 * Generate a local dev login link.
 * Run with: npx tsx scripts/dev-login.ts
 */
import { createClient } from '@libsql/client';
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeHexLowerCase } from '@oslojs/encoding';
import { nanoid } from 'nanoid';
import 'dotenv/config';

const turso = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

async function devLogin() {
  // Find admin user
  const result = await turso.execute({
    sql: 'SELECT id FROM users WHERE email = ?',
    args: ['cody@codyasmith.com'],
  });

  if (result.rows.length === 0) {
    console.error('No admin user found. Run seed-admin.ts first.');
    process.exit(1);
  }

  const userId = result.rows[0][0] as string;
  const token = nanoid(48);
  const tokenHash = encodeHexLowerCase(sha256(new TextEncoder().encode(token)));
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  await turso.execute({
    sql: 'INSERT INTO magic_links (id, token_hash, user_id, expires_at) VALUES (?, ?, ?, ?)',
    args: [nanoid(), tokenHash, userId, expiresAt],
  });

  console.log('\nOpen this in your browser:\n');
  console.log(`http://localhost:4321/portal/auth/verify?token=${token}`);
  console.log('\nExpires in 15 minutes.\n');
}

devLogin().catch(console.error);
