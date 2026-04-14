// Phase 1 follow-up — seed the first cleanup_stale_imports job.
//
// The handler self-enqueues at the end of every successful run, so once
// the first row exists and the runner fires it, the sweep runs hourly
// forever (or until Cody deletes the chain). This script is the one-
// time kickoff. Idempotent: if a pending/running cleanup job already
// exists, it does nothing.
//
// Run:
//   npx tsx scripts/phase1-seed-stale-import-sweep.ts --dry-run
//   npx tsx scripts/phase1-seed-stale-import-sweep.ts --apply

import 'dotenv/config';
import { createClient } from '@libsql/client';
import { nanoid } from 'nanoid';

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

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY-RUN' : 'APPLY'}`);
  console.log();

  const existing = await db.execute(
    `SELECT id, status, scheduled_for
     FROM scheduled_jobs
     WHERE job_type = 'cleanup_stale_imports'
       AND status IN ('pending', 'running')
     LIMIT 1`
  );
  if (existing.rows.length > 0) {
    console.log(
      `Already queued: id=${existing.rows[0][0]} status=${existing.rows[0][1]} for=${existing.rows[0][2]}`
    );
    console.log('Nothing to do.');
    return;
  }

  const id = nanoid();
  // Seed scheduled_for in the immediate past so the next external cron
  // hit picks it up on first call — no waiting for a wall-clock hour.
  const when = new Date(Date.now() - 60 * 1000).toISOString();
  console.log('Will enqueue:');
  console.log(`  id=${id}`);
  console.log(`  job_type=cleanup_stale_imports`);
  console.log(`  scheduled_for=${when}`);
  console.log(`  status=pending`);
  console.log();

  if (DRY_RUN) {
    console.log('Dry run complete. Nothing written.');
    return;
  }

  await db.execute({
    sql: `INSERT INTO scheduled_jobs (id, job_type, scheduled_for, status, payload_json)
          VALUES (?, 'cleanup_stale_imports', ?, 'pending', '{}')`,
    args: [id, when],
  });
  console.log('Seeded.');
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
