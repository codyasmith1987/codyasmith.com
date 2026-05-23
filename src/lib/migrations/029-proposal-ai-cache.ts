// Turso-backed cache for the Gemini-assisted proposal builder.
// Mirrors the naming_gemini_cache and listener_sentiment_cache
// schemas: cache_key is sha256 of (promptVersion | model | feature
// | inputs); response_json is the validated JSON the orchestrator
// returned; expires_at gates lookups so a SELECT WHERE expires_at >
// datetime('now') is enough to evict stale entries lazily.
//
// TTL is feature-dependent and set by the caller, not by the schema.
// Client research uses 30 days; field-suggest uses 14 days; snippet
// drafts use 7 days. Pattern follows naming/storage.ts.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '029-proposal-ai-cache',
  async up() {
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS proposal_gemini_cache (
        cache_key TEXT PRIMARY KEY,
        feature TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL
      )
    `);
    await turso.execute(`
      CREATE INDEX IF NOT EXISTS idx_proposal_gemini_cache_expires
      ON proposal_gemini_cache(expires_at)
    `);
    await turso.execute(`
      CREATE INDEX IF NOT EXISTS idx_proposal_gemini_cache_feature
      ON proposal_gemini_cache(feature)
    `);
  },
};

export default migration;
