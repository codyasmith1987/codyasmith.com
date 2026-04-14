// Phase 1 Slice 12 — applier for migration 018-contacts.
//
// Creates the contacts table with UNIQUE(client_id, email) and two
// indexes. Idempotent: IF NOT EXISTS + _migrations tracking row.
//
// Run:
//   npx tsx scripts/phase1-apply-migration-018.ts --dry-run
//   npx tsx scripts/phase1-apply-migration-018.ts --apply

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
const MIGRATION_ID = '018-contacts';

const STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES clients(id),
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    roles_json TEXT NOT NULL DEFAULT '[]',
    receives_invoices INTEGER NOT NULL DEFAULT 0,
    receives_reminders INTEGER NOT NULL DEFAULT 0,
    user_id TEXT REFERENCES users(id),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(client_id, email)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_contacts_client ON contacts(client_id)`,
  `CREATE INDEX IF NOT EXISTS idx_contacts_active ON contacts(client_id, active)`,
];

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY-RUN' : 'APPLY'}`);
  console.log();

  const already = await db.execute({
    sql: 'SELECT 1 FROM _migrations WHERE id = ?',
    args: [MIGRATION_ID],
  });
  if (already.rows.length > 0) {
    console.log(`${MIGRATION_ID} already recorded.`);
    const tbl = await db.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='contacts'`
    );
    if (tbl.rows.length === 0) {
      console.error('ABORT: tracking row exists but contacts table does not.');
      process.exit(2);
    }
    console.log('Table present — nothing to do.');
    return;
  }

  console.log('Planned statements:');
  for (const s of STATEMENTS) console.log('  ' + s.replace(/\s+/g, ' ').trim());
  console.log();

  if (DRY_RUN) {
    console.log('Dry run complete.');
    return;
  }

  for (const s of STATEMENTS) await db.execute(s);

  await db.execute({
    sql: 'INSERT OR IGNORE INTO _migrations (id) VALUES (?)',
    args: [MIGRATION_ID],
  });

  // Verify.
  const cols = await db.execute('PRAGMA table_info(contacts)');
  const colNames = cols.rows.map((r) => r[1] as string);
  const required = [
    'id',
    'client_id',
    'name',
    'email',
    'roles_json',
    'receives_invoices',
    'receives_reminders',
    'user_id',
    'active',
    'created_at',
  ];
  for (const c of required) {
    if (!colNames.includes(c)) throw new Error(`contacts.${c} missing`);
  }
  console.log('contacts columns:', colNames.join(', '));

  const uniqDdl = await db.execute(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='contacts'`
  );
  const ddl = String(uniqDdl.rows[0][0] ?? '');
  if (!/UNIQUE\s*\(\s*client_id\s*,\s*email\s*\)/i.test(ddl)) {
    throw new Error('contacts is missing UNIQUE(client_id, email)');
  }
  console.log('UNIQUE(client_id, email) present.');

  console.log();
  console.log('Migration 018 applied and verified.');
}

main().catch((err) => {
  console.error('Migration 018 failed:', err);
  process.exit(1);
});
