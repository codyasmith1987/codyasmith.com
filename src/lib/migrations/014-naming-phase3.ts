// Phase 3 schema additions for the naming pipeline.
// Adds typology/tonality/score columns to naming_names (the Phase 1 table),
// plus the naming_quiz_responses table for post-gate quiz capture.
// All DDL is idempotent (CREATE IF NOT EXISTS, ALTER ... ADD COLUMN guarded
// by try/catch on duplicate-column errors).

import turso from '../turso';
import type { Migration } from '../migrate';

// Exported so a tsx-run helper script can apply the schema without importing
// turso.ts. See scripts/migrate-naming-phase3.ts.
export const NAMING_PHASE3_ALTERS: string[] = [
  `ALTER TABLE naming_names ADD COLUMN typology TEXT`,
  `ALTER TABLE naming_names ADD COLUMN tonality_json TEXT`,
  `ALTER TABLE naming_names ADD COLUMN score REAL`,
  `ALTER TABLE naming_names ADD COLUMN excluded_reason TEXT`,
  `ALTER TABLE naming_names ADD COLUMN secondary_price_usd REAL`,
];

export const NAMING_PHASE3_TABLES: string[] = [
  `CREATE TABLE IF NOT EXISTS naming_quiz_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES naming_runs(id),
    selected_names_json TEXT NOT NULL,
    audience TEXT NOT NULL,
    density TEXT NOT NULL,
    brand_kind TEXT NOT NULL,
    email TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_naming_quiz_responses_run ON naming_quiz_responses(run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_naming_quiz_responses_email ON naming_quiz_responses(email)`,
];

const migration: Migration = {
  id: '014-naming-phase3',
  async up() {
    for (const sql of NAMING_PHASE3_ALTERS) {
      try {
        await turso.execute(sql);
      } catch {
        // Likely "duplicate column name" on rerun; silently ignore.
      }
    }
    await turso.batch(NAMING_PHASE3_TABLES, 'write');
  },
};

export default migration;
