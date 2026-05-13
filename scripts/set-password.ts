/**
 * Set a password for an existing user.
 * Run with: npx tsx scripts/set-password.ts cody@codyasmith.com YourPassword
 *
 * Writes a bcrypt hash via the same primitive as src/lib/auth.ts. Earlier
 * versions of this script wrote unsalted SHA-256 hashes, which put users
 * onto the deprecated legacy verify path; see security-audit-2026-05-12
 * round 4 SEC4-005.
 */
import { createClient } from '@libsql/client';
import bcrypt from 'bcryptjs';
import 'dotenv/config';

const turso = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

const BCRYPT_ROUNDS = 12;
const MIN_LENGTH = 12;
const MAX_BYTES = 72;

async function main() {
  const email = process.argv[2];
  const password = process.argv[3];

  if (!email || !password) {
    console.error('Usage: npx tsx scripts/set-password.ts <email> <password>');
    process.exit(1);
  }

  if (password.length < MIN_LENGTH) {
    console.error(`Password must be at least ${MIN_LENGTH} characters`);
    process.exit(1);
  }
  if (new TextEncoder().encode(password).length > MAX_BYTES) {
    console.error(`Password must be at most ${MAX_BYTES} bytes (bcrypt limit)`);
    process.exit(1);
  }

  // Add password_hash column if it doesn't exist (idempotent).
  try {
    await turso.execute('ALTER TABLE users ADD COLUMN password_hash TEXT');
    console.log('Added password_hash column to users table');
  } catch (e: any) {
    if (e.message?.includes('duplicate column')) {
      // Column already exists; fine.
    } else {
      console.log('Column may already exist:', e.message);
    }
  }

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const result = await turso.execute({
    sql: 'UPDATE users SET password_hash = ? WHERE email = ?',
    args: [hash, email.toLowerCase().trim()],
  });

  if (result.rowsAffected === 0) {
    console.error(`No user found with email: ${email}`);
    process.exit(1);
  }

  // Revoke existing sessions so the user re-authenticates with the new
  // password on next access (matches the production setPassword in
  // src/lib/auth.ts).
  await turso.execute({
    sql: `DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ?)`,
    args: [email.toLowerCase().trim()],
  });

  console.log(`Password set for ${email}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
