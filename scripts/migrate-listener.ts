/**
 * Run with: npx tsx scripts/migrate-listener.ts
 * Applies the 013-listener-sentiment-cache schema against the libsql DB pointed
 * at by TURSO_DATABASE_URL. Idempotent: every CREATE uses IF NOT EXISTS.
 *
 * Bypasses src/lib/migrate.ts (which uses Astro's import.meta.env) and reads
 * LISTENER_SENTIMENT_CACHE_SQL directly from the migration module.
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';
import { LISTENER_SENTIMENT_CACHE_SQL } from '../src/lib/migrations/013-listener-sentiment-cache';

const url = (process.env.TURSO_DATABASE_URL || '').trim();
if (!url) {
  console.error('TURSO_DATABASE_URL is not set in .env');
  process.exit(1);
}

const authToken = (process.env.TURSO_AUTH_TOKEN || '').trim();
const turso = createClient(authToken ? { url, authToken } : { url });

console.log(`Applying 013-listener-sentiment-cache schema against ${url}`);
await turso.batch(LISTENER_SENTIMENT_CACHE_SQL, 'write');

const tables = await turso.execute(
  `SELECT name FROM sqlite_master WHERE type='table' AND name='listener_sentiment_cache'`,
);
const indexes = await turso.execute(
  `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_listener_sentiment_cache_expires'`,
);
console.log(`Tables present: ${tables.rows.length === 1 ? 'listener_sentiment_cache' : 'NONE'}`);
console.log(`Indexes present: ${indexes.rows.length === 1 ? 'idx_listener_sentiment_cache_expires' : 'NONE'}`);
console.log('Done.');
