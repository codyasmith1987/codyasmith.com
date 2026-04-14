// Slice 18 — applier for migration 019-google-connections.
//
// Run:
//   npx tsx scripts/phase1-apply-migration-019.ts --dry-run
//   npx tsx scripts/phase1-apply-migration-019.ts --apply

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
const MIGRATION_ID = '019-google-connections';

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS google_connections (
    id TEXT PRIMARY KEY,
    admin_user_id TEXT NOT NULL REFERENCES users(id),
    google_account_email TEXT NOT NULL,
    refresh_token_encrypted TEXT NOT NULL,
    access_token TEXT,
    access_token_expires_at TEXT,
    scopes_json TEXT NOT NULL,
    connected_at TEXT DEFAULT (datetime('now')),
    last_refresh_at TEXT,
    last_refresh_error TEXT,
    UNIQUE(admin_user_id, google_account_email)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_google_connections_admin ON google_connections(admin_user_id)`,
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

  console.log('Planned statements:');
  for (const s of STATEMENTS) console.log('  ' + s.replace(/\s+/g, ' ').trim());

  if (DRY_RUN) {
    console.log('Dry run complete.');
    return;
  }

  for (const s of STATEMENTS) await db.execute(s);
  await db.execute({
    sql: 'INSERT OR IGNORE INTO _migrations (id) VALUES (?)',
    args: [MIGRATION_ID],
  });

  const cols = await db.execute('PRAGMA table_info(google_connections)');
  console.log(
    'google_connections columns:',
    cols.rows.map((r) => r[1]).join(', ')
  );
  console.log('Migration 019 applied and verified.');
}

main().catch((err) => {
  console.error('Migration 019 failed:', err);
  process.exit(1);
});
