// Typed wrappers around Turso queries for the naming pipeline.
// Factory pattern so production wires the real turso client and tests pass mocks.
// No top-level import of ../turso; see migrations/012-naming.ts for the production
// wire-up at app cold start.

import type { Client, InValue } from '@libsql/client';

import type {
  AvailabilityResult,
  CacheEntry,
  GenerateResult,
  InsertRunOptions,
} from './types';

export interface NamingStorage {
  insertRun(opts: InsertRunOptions): Promise<number>;
  insertNames(runId: number, generation: GenerateResult): Promise<Map<string, number>>;
  insertAvailability(
    nameIdsByName: Map<string, number>,
    results: AvailabilityResult[],
  ): Promise<void>;
  getCache(cacheKey: string): Promise<CacheEntry<unknown> | null>;
  setCache(cacheKey: string, value: unknown, ttlDays: number): Promise<void>;
}

export function createStorage(turso: Client): NamingStorage {
  return {
    async insertRun(opts) {
      const result = await turso.execute({
        sql: `INSERT INTO naming_runs
                (seed_term, creativity, tlds, source, lead_id, created_at, config_snapshot)
              VALUES (?, ?, ?, ?, ?, datetime('now'), ?)`,
        args: [
          opts.seedTerm,
          opts.creativity,
          JSON.stringify(opts.tlds),
          opts.source,
          opts.leadId ?? null,
          opts.configSnapshot ?? null,
        ],
      });
      return Number(result.lastInsertRowid);
    },

    async insertNames(runId, generation) {
      const map = new Map<string, number>();
      for (const parent of generation.parents) {
        const parentResult = await turso.execute({
          sql: `INSERT INTO naming_names
                  (run_id, parent_name, parent_rationale, name, variant_rationale, is_parent)
                VALUES (?, ?, ?, ?, ?, 1)`,
          args: [runId, parent.name, parent.rationale, parent.name, ''],
        });
        map.set(parent.name, Number(parentResult.lastInsertRowid));

        for (const variant of parent.variants) {
          const variantResult = await turso.execute({
            sql: `INSERT INTO naming_names
                    (run_id, parent_name, parent_rationale, name, variant_rationale, is_parent)
                  VALUES (?, ?, ?, ?, ?, 0)`,
            args: [runId, parent.name, parent.rationale, variant.name, variant.rationale],
          });
          map.set(variant.name, Number(variantResult.lastInsertRowid));
        }
      }
      return map;
    },

    async insertAvailability(nameIdsByName, results) {
      const stmts = results
        .map((r) => {
          const nameId = nameIdsByName.get(r.name);
          if (!nameId) return null;
          const availableValue: InValue =
            r.available === null ? null : r.available ? 1 : 0;
          return {
            sql: `INSERT INTO naming_availability
                    (name_id, tld, available, checked_at)
                  VALUES (?, ?, ?, ?)`,
            args: [nameId, r.tld, availableValue, r.checkedAt] as InValue[],
          };
        })
        .filter((s): s is NonNullable<typeof s> => s !== null);

      if (stmts.length > 0) {
        await turso.batch(stmts, 'write');
      }
    },

    async getCache(cacheKey) {
      const result = await turso.execute({
        sql: `SELECT response_json, expires_at
              FROM naming_gemini_cache
              WHERE cache_key = ? AND expires_at > datetime('now')
              LIMIT 1`,
        args: [cacheKey],
      });
      if (result.rows.length === 0) return null;
      const row = result.rows[0];
      return {
        value: JSON.parse(String(row[0])),
        expiresAt: String(row[1]),
      };
    },

    async setCache(cacheKey, value, ttlDays) {
      const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
      await turso.execute({
        sql: `INSERT INTO naming_gemini_cache
                (cache_key, response_json, created_at, expires_at)
              VALUES (?, ?, datetime('now'), ?)
              ON CONFLICT(cache_key) DO UPDATE SET
                response_json = excluded.response_json,
                created_at = datetime('now'),
                expires_at = excluded.expires_at`,
        args: [cacheKey, JSON.stringify(value), expiresAt],
      });
    },
  };
}
