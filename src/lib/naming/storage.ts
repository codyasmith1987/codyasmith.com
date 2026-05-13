// Typed wrappers around Turso queries for the naming pipeline.
// Phase 3: storage interface rewritten to handle the 200-candidates shape
// (with typology, tonality, score, exclusion reason) instead of the Phase 1
// parents-and-variants nested structure.
//
// Factory pattern preserved: production wires the real turso client, tests
// pass an in-memory libsql client.

import type { Client, InValue } from '@libsql/client';

import type {
  AvailabilityResult,
  CacheEntry,
  InsertRunOptions,
  QuizResponse,
  ScoredCandidate,
} from './types';

export interface PersistedCandidate {
  id: number;
  runId: number;
  name: string;
  typology: string | null;
  rationale: string | null;
  tonality: Record<string, number> | null;
  score: number | null;
  excludedReason: string | null;
  secondaryPriceUsd: number | null;
}

export interface NamingStorage {
  insertRun(opts: InsertRunOptions): Promise<number>;
  insertScoredCandidates(
    runId: number,
    scored: ScoredCandidate[],
  ): Promise<Map<string, number>>;
  insertAvailability(
    nameIdsByName: Map<string, number>,
    results: AvailabilityResult[],
  ): Promise<void>;
  getRun(runId: number): Promise<{
    id: number;
    seedTerm: string;
    createdAt: string;
  } | null>;
  getCandidatesForRun(runId: number): Promise<PersistedCandidate[]>;
  insertQuizResponse(response: QuizResponse): Promise<number>;
  getQuizResponseForRun(runId: number): Promise<QuizResponse | null>;
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

    async insertScoredCandidates(runId, scored) {
      const map = new Map<string, number>();
      // Use single inserts; libsql batch with 200 inserts works but per-row
      // is more debuggable and the volume is low enough not to matter.
      for (const sc of scored) {
        const r = await turso.execute({
          sql: `INSERT INTO naming_names
                  (run_id, parent_name, parent_rationale, name, variant_rationale,
                   is_parent, typology, tonality_json, score, excluded_reason,
                   secondary_price_usd)
                VALUES (?, NULL, NULL, ?, ?, 0, ?, ?, ?, ?, ?)`,
          args: [
            runId,
            sc.candidate.name,
            sc.candidate.rationale,
            sc.candidate.typology,
            JSON.stringify(sc.candidate.tonality),
            sc.score,
            sc.excluded ?? null,
            sc.domain.secondaryPriceUsd ?? null,
          ],
        });
        map.set(sc.candidate.name, Number(r.lastInsertRowid));
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

      if (stmts.length > 0) await turso.batch(stmts, 'write');
    },

    async getRun(runId) {
      const r = await turso.execute({
        sql: `SELECT id, seed_term, created_at FROM naming_runs WHERE id = ? LIMIT 1`,
        args: [runId],
      });
      if (r.rows.length === 0) return null;
      const row = r.rows[0];
      return {
        id: Number(row[0]),
        seedTerm: String(row[1]),
        createdAt: String(row[2]),
      };
    },

    async getCandidatesForRun(runId) {
      const r = await turso.execute({
        sql: `SELECT id, run_id, name, typology, variant_rationale, tonality_json,
                     score, excluded_reason, secondary_price_usd
              FROM naming_names
              WHERE run_id = ?
              ORDER BY score DESC NULLS LAST`,
        args: [runId],
      });
      return r.rows.map((row) => {
        let tonality: Record<string, number> | null = null;
        const tj = row[5];
        if (typeof tj === 'string' && tj.length > 0) {
          try { tonality = JSON.parse(tj); } catch { tonality = null; }
        }
        return {
          id: Number(row[0]),
          runId: Number(row[1]),
          name: String(row[2]),
          typology: row[3] === null ? null : String(row[3]),
          rationale: row[4] === null ? null : String(row[4]),
          tonality,
          score: row[6] === null ? null : Number(row[6]),
          excludedReason: row[7] === null ? null : String(row[7]),
          secondaryPriceUsd: row[8] === null ? null : Number(row[8]),
        } satisfies PersistedCandidate;
      });
    },

    async insertQuizResponse(response) {
      const r = await turso.execute({
        sql: `INSERT INTO naming_quiz_responses
                (run_id, selected_names_json, audience, density, brand_kind, email, created_at)
              VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
        args: [
          response.runId,
          JSON.stringify(response.selectedNames),
          response.audience,
          response.density,
          response.brandKind,
          response.email,
        ],
      });
      return Number(r.lastInsertRowid);
    },

    async getQuizResponseForRun(runId) {
      const r = await turso.execute({
        sql: `SELECT run_id, selected_names_json, audience, density, brand_kind, email
              FROM naming_quiz_responses
              WHERE run_id = ?
              ORDER BY id DESC LIMIT 1`,
        args: [runId],
      });
      if (r.rows.length === 0) return null;
      const row = r.rows[0];
      let selectedNames: string[] = [];
      try { selectedNames = JSON.parse(String(row[1])); } catch { /* keep [] */ }
      return {
        runId: Number(row[0]),
        selectedNames,
        audience: String(row[2]),
        density: String(row[3]) as QuizResponse['density'],
        brandKind: String(row[4]) as QuizResponse['brandKind'],
        email: String(row[5]),
      };
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
      return { value: JSON.parse(String(row[0])), expiresAt: String(row[1]) };
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
