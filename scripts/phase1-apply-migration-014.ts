// Phase 1 Step 5 — applier for migration 014-scheduled-jobs.
//
// Creates the scheduled_jobs table and its indexes. Records the
// migration in _migrations. Idempotent — safe to re-run.
//
// Run:
//   npx tsx scripts/phase1-apply-migration-014.ts --dry-run
//   npx tsx scripts/phase1-apply-migration-014.ts --apply

import 'dotenv/config';
import { createClient } from '@libsql/client';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) {
  console.error('TURSO_DATABASE_URL is not set');
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const APPLY = args.has('--apply');
if (DRY_RUN === APPLY) {
  console.error('Pass exactly one of --dry-run or --apply');
  process.exit(1);
}

const db = createClient({ url, authToken });
const MIGRATION_ID = '014-scheduled-jobs';

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS scheduled_jobs (
    id TEXT PRIMARY KEY,
    job_type TEXT NOT NULL,
    scheduled_for TEXT NOT NULL,
    lease_until TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    last_run_at TEXT,
    last_result TEXT,
    payload_json TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_due ON scheduled_jobs(status, scheduled_for)`,
  `CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_type ON scheduled_jobs(job_type, status)`,
];

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY-RUN' : 'APPLY'}`);

  const already = await db.execute({
    sql: 'SELECT 1 FROM _migrations WHERE id = ?',
    args: [MIGRATION_ID],
  });
  if (already.rows.length > 0) {
    console.log(`${MIGRATION_ID} already recorded.`);
    return;
  }

  console.log('Statements:');
  for (const s of STATEMENTS) console.log('  ' + s.split('\n')[0] + '...');

  if (DRY_RUN) {
    console.log('Dry run complete.');
    return;
  }

  await db.batch([...STATEMENTS, { sql: 'INSERT INTO _migrations (id) VALUES (?)', args: [MIGRATION_ID] }], 'write');
  console.log('Applied.');

  const verify = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_jobs'");
  if (verify.rows.length !== 1) {
    console.error('Verification failed: scheduled_jobs table not present');
    process.exit(2);
  }
  console.log('Verified scheduled_jobs exists.');
}

main().catch((err) => {
  console.error('Migration 014 failed:', err);
  process.exit(1);
});
