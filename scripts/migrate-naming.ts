/**
 * Run with: npx tsx scripts/migrate-naming.ts
 * Applies the 012-naming schema against the libsql DB pointed at by
 * TURSO_DATABASE_URL. Idempotent: every CREATE uses IF NOT EXISTS.
 *
 * This script bypasses src/lib/migrate.ts (which uses Astro's
 * import.meta.env and is not callable from plain Node tooling) and reads
 * NAMING_TABLES_SQL directly from the migration module.
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';
import { NAMING_TABLES_SQL } from '../src/lib/migrations/012-naming';

const url = (process.env.TURSO_DATABASE_URL || '').trim();
if (!url) {
  console.error('TURSO_DATABASE_URL is not set in .env');
  process.exit(1);
}

const authToken = (process.env.TURSO_AUTH_TOKEN || '').trim();
const turso = createClient(authToken ? { url, authToken } : { url });

console.log(`Applying 012-naming schema against ${url}`);
await turso.batch(NAMING_TABLES_SQL, 'write');

const tables = await turso.execute(
  `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'naming_%' ORDER BY name`,
);
const tableNames = tables.rows.map((r) => String(r[0]));
console.log(`Tables present (${tableNames.length}):`);
for (const t of tableNames) console.log(`  - ${t}`);
console.log('Done.');
