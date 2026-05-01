// Listener sentiment cache. Mirrors naming_gemini_cache.
// Holds Gemini-scored mention results keyed on SHA-256(prompt_version + model + full_text).
// 7-day TTL applied at write time by the scorer; expires_at index speeds eviction sweeps.

import turso from '../turso';
import type { Migration } from '../migrate';

// Exported so a tsx-run helper script can apply the schema without importing
// turso.ts (which uses Vite's import.meta.env). See scripts/migrate-listener.ts.
export const LISTENER_SENTIMENT_CACHE_SQL: string[] = [
  `CREATE TABLE IF NOT EXISTS listener_sentiment_cache (
    cache_key TEXT PRIMARY KEY,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_listener_sentiment_cache_expires
     ON listener_sentiment_cache(expires_at)`,
];

const migration: Migration = {
  id: '013-listener-sentiment-cache',
  async up() {
    await turso.batch(LISTENER_SENTIMENT_CACHE_SQL, 'write');
  },
};

export default migration;
