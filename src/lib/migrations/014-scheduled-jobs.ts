// Phase 1 Step 5 — scheduled jobs table.
//
// Moves recurring work (invoice generation, reminder email checks) off
// admin page-load and onto an explicit runner. Each row represents one
// unit of work to perform at or after `scheduled_for`. The runner takes
// a lease (writes `lease_until`) before executing; another runner with
// a fresh lease skips rows whose lease hasn't expired.
//
// Schema:
//   id             stable id
//   job_type       'generate_invoices' | 'send_reminders'
//   scheduled_for  earliest time the job should run (UTC iso)
//   lease_until    active lease expiry (UTC iso) or NULL
//   status         'pending' | 'running' | 'done' | 'failed'
//   last_run_at    when it last transitioned out of running
//   last_result    short human-readable summary of the last run
//   payload_json   optional JSON blob for job-specific inputs
//   created_at
//
// A partial index on (status, scheduled_for) keeps the "what's due"
// query fast even once the table grows.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '014-scheduled-jobs',
  async up() {
    await turso.batch(
      [
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
        `CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_due
         ON scheduled_jobs(status, scheduled_for)`,
        `CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_type
         ON scheduled_jobs(job_type, status)`,
      ],
      'write'
    );
  },
};

export default migration;
