// Turso-backed cache layer for proposal-ai features. One table
// (proposal_gemini_cache) holds all features; each entry is tagged
// with its feature for lookup and observability. Key derivation lives
// here so every feature uses the same SHA-256(promptVersion | model |
// feature | inputs) shape.

import { createHash } from 'node:crypto';
import turso from '../turso';
import type { ProposalCacheClient, ProposalCacheEntry } from './types';

export function deriveCacheKey(parts: {
  promptVersion: string;
  model: string;
  feature: string;
  inputs: string;
}): string {
  return createHash('sha256')
    .update(`${parts.promptVersion}|${parts.model}|${parts.feature}|${parts.inputs}`)
    .digest('hex');
}

export function createProposalCacheClient(db = turso): ProposalCacheClient {
  return {
    async get<T = unknown>(key: string): Promise<ProposalCacheEntry<T> | null> {
      const result = await db.execute({
        sql: `SELECT response_json, expires_at
              FROM proposal_gemini_cache
              WHERE cache_key = ? AND expires_at > datetime('now')
              LIMIT 1`,
        args: [key],
      });
      if (result.rows.length === 0) return null;
      const row = result.rows[0] as any;
      return {
        value: JSON.parse(String(row[0])) as T,
        expiresAt: String(row[1]),
      };
    },

    async set<T = unknown>(key: string, value: T, ttlDays: number, feature: string): Promise<void> {
      const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
      await db.execute({
        sql: `INSERT INTO proposal_gemini_cache
                (cache_key, feature, response_json, created_at, expires_at)
              VALUES (?, ?, ?, datetime('now'), ?)
              ON CONFLICT(cache_key) DO UPDATE SET
                feature = excluded.feature,
                response_json = excluded.response_json,
                created_at = datetime('now'),
                expires_at = excluded.expires_at`,
        args: [key, feature, JSON.stringify(value), expiresAt],
      });
    },
  };
}
