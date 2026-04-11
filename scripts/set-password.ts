/**
 * Set a password for an existing user.
 * Run with: npx tsx scripts/set-password.ts cody@codyasmith.com YourPassword
 */
import { createClient } from '@libsql/client';
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeHexLowerCase } from '@oslojs/encoding';
import 'dotenv/config';

const turso = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

function hashPassword(password: string): string {
  const encoded = new TextEncoder().encode(password);
  return encodeHexLowerCase(sha256(encoded));
}

async function main() {
  const email = process.argv[2];
  const password = process.argv[3];

  if (!email || !password) {
    console.error('Usage: npx tsx scripts/set-password.ts <email> <password>');
    process.exit(1);
  }

  if (password.length < 8) {
    console.error('Password must be at least 8 characters');
    process.exit(1);
  }

  // Add password_hash column if it doesn't exist
  try {
    await turso.execute('ALTER TABLE users ADD COLUMN password_hash TEXT');
    console.log('Added password_hash column to users table');
  } catch (e: any) {
    if (e.message?.includes('duplicate column')) {
      // Column already exists
    } else {
      console.log('Column may already exist:', e.message);
    }
  }

  const hash = hashPassword(password);
  const result = await turso.execute({
    sql: 'UPDATE users SET password_hash = ? WHERE email = ?',
    args: [hash, email.toLowerCase().trim()],
  });

  if (result.rowsAffected === 0) {
    console.error(`No user found with email: ${email}`);
    process.exit(1);
  }

  console.log(`Password set for ${email}`);
}

main().catch(console.error);
