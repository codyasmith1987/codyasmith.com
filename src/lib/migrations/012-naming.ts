// Naming pipeline schema. Tables prefixed `naming_*`.
// Brand renamed at Phase 4 via a follow-up migration that swaps the prefix.

import turso from '../turso';
import type { Migration } from '../migrate';

// Exported so a tsx-run helper script can apply the schema without importing
// turso.ts (which uses Vite's import.meta.env and is not callable from plain
// Node tooling). See scripts/migrate-naming.ts.
export const NAMING_TABLES_SQL: string[] = [
  `CREATE TABLE IF NOT EXISTS naming_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seed_term TEXT NOT NULL,
    creativity INTEGER NOT NULL,
    tlds TEXT NOT NULL,
    source TEXT NOT NULL,
    lead_id INTEGER,
    created_at TEXT NOT NULL,
    config_snapshot TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS naming_names (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES naming_runs(id),
    parent_name TEXT,
    parent_rationale TEXT,
    name TEXT NOT NULL,
    variant_rationale TEXT,
    is_parent INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS naming_availability (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name_id INTEGER NOT NULL REFERENCES naming_names(id),
    tld TEXT NOT NULL,
    available INTEGER,
    checked_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS naming_pricing_cache (
    tld TEXT PRIMARY KEY,
    first_year REAL,
    renewal REAL,
    currency TEXT,
    cached_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS naming_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name_id INTEGER NOT NULL REFERENCES naming_names(id),
    axis TEXT NOT NULL,
    score REAL NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS naming_trademark_flags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name_id INTEGER NOT NULL REFERENCES naming_names(id),
    concern_level TEXT,
    evidence_json TEXT,
    checked_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS naming_gemini_cache (
    cache_key TEXT PRIMARY KEY,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS naming_jobs (
    id TEXT PRIMARY KEY,
    job_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL,
    progress_step TEXT,
    result_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_naming_jobs_status ON naming_jobs(status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_naming_gemini_cache_expires ON naming_gemini_cache(expires_at)`,
];

const migration: Migration = {
  id: '012-naming',
  async up() {
    await turso.batch(NAMING_TABLES_SQL, 'write');
  },
};

export default migration;
