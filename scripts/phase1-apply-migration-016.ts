// Phase 1 Slice 7 — applier for migration 016-data-source-bindings.
//
// Creates the data_source_bindings table and its indexes against the
// live Turso DB. Safe to re-run: IF NOT EXISTS on CREATE, check against
// _migrations table before writing the tracking row.
//
// Run:
//   npx tsx scripts/phase1-apply-migration-016.ts --dry-run
//   npx tsx scripts/phase1-apply-migration-016.ts --apply

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
const MIGRATION_ID = '016-data-source-bindings';

const STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS data_source_bindings (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES clients(id),
    contract_id TEXT NOT NULL REFERENCES contracts(id),
    source TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    config_json TEXT,
    last_seen_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(contract_id, source)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_dsb_client ON data_source_bindings(client_id)`,
  `CREATE INDEX IF NOT EXISTS idx_dsb_contract ON data_source_bindings(contract_id)`,
  `CREATE INDEX IF NOT EXISTS idx_dsb_source_enabled ON data_source_bindings(source, enabled)`,
];

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY-RUN' : 'APPLY'}`);
  console.log();

  const already = await db.execute({
    sql: 'SELECT 1 FROM _migrations WHERE id = ?',
    args: [MIGRATION_ID],
  });
  if (already.rows.length > 0) {
    console.log(`${MIGRATION_ID} already recorded in _migrations.`);
    // Still verify the table+indexes exist in case the tracking row
    // was written before the actual table creation completed.
    const tbl = await db.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='data_source_bindings'`
    );
    if (tbl.rows.length === 0) {
      console.error('ABORT: tracking row exists but data_source_bindings table does not. Manual inspection required.');
      process.exit(2);
    }
    console.log('Table present — nothing to do.');
    return;
  }

  console.log('Planned statements:');
  for (const s of STATEMENTS) {
    console.log('  ' + s.replace(/\s+/g, ' ').trim());
  }
  console.log();

  if (DRY_RUN) {
    console.log('Dry run complete.');
    return;
  }

  for (const s of STATEMENTS) {
    await db.execute(s);
  }

  await db.execute({
    sql: 'INSERT OR IGNORE INTO _migrations (id) VALUES (?)',
    args: [MIGRATION_ID],
  });

  // Verify shape.
  const cols = await db.execute('PRAGMA table_info(data_source_bindings)');
  const colNames = cols.rows.map((r) => r[1] as string);
  const required = [
    'id',
    'client_id',
    'contract_id',
    'source',
    'enabled',
    'config_json',
    'last_seen_at',
    'created_at',
  ];
  const missing = required.filter((c) => !colNames.includes(c));
  if (missing.length > 0) {
    throw new Error(`data_source_bindings missing columns: ${missing.join(', ')}`);
  }
  console.log('data_source_bindings columns:', colNames.join(', '));

  const idx = await db.execute(
    `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='data_source_bindings' ORDER BY name`
  );
  console.log('data_source_bindings indexes:', idx.rows.map((r) => r[0]).join(', '));

  const uniqueCheck = await db.execute(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='data_source_bindings'`
  );
  if (uniqueCheck.rows.length > 0) {
    const ddl = String(uniqueCheck.rows[0][0]);
    if (!/UNIQUE\s*\(\s*contract_id\s*,\s*source\s*\)/i.test(ddl)) {
      throw new Error('data_source_bindings is missing UNIQUE(contract_id, source)');
    }
    console.log('UNIQUE(contract_id, source) present.');
  }

  console.log();
  console.log('Migration 016 applied and verified.');
}

main().catch((err) => {
  console.error('Migration 016 failed:', err);
  process.exit(1);
});
