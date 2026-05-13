/**
 * Run with: npx tsx scripts/migrate-naming-phase3.ts
 * Applies Phase 3 schema additions: column adds to naming_names, plus the
 * naming_quiz_responses table.
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';
import {
  NAMING_PHASE3_ALTERS,
  NAMING_PHASE3_TABLES,
} from '../src/lib/migrations/014-naming-phase3';

const url = (process.env.TURSO_DATABASE_URL || '').trim();
if (!url) {
  console.error('TURSO_DATABASE_URL not set in .env');
  process.exit(1);
}
const authToken = (process.env.TURSO_AUTH_TOKEN || '').trim();
const turso = createClient(authToken ? { url, authToken } : { url });

console.log(`Applying 014-naming-phase3 against ${url}`);
for (const sql of NAMING_PHASE3_ALTERS) {
  try {
    await turso.execute(sql);
    console.log(`  applied: ${sql.slice(0, 60)}...`);
  } catch (e) {
    console.log(`  skipped (already applied): ${sql.slice(0, 60)}...`);
  }
}
await turso.batch(NAMING_PHASE3_TABLES, 'write');

const cols = await turso.execute(`PRAGMA table_info(naming_names)`);
const colNames = cols.rows.map((r) => String(r[1]));
console.log(`naming_names columns: ${colNames.join(', ')}`);

const tables = await turso.execute(
  `SELECT name FROM sqlite_master WHERE type='table' AND name='naming_quiz_responses'`,
);
console.log(`naming_quiz_responses present: ${tables.rows.length === 1}`);
console.log('Done.');
