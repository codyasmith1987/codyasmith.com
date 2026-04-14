// Phase 1 Slice 10 — applier for migration 017-contract-rules.
//
// Adds six columns across contracts, pending_charges, and invoices
// to support contract-declared passthrough + reminder rules. All
// additions are nullable or default-bearing so the migration
// applies cleanly over existing data.
//
// Run:
//   npx tsx scripts/phase1-apply-migration-017.ts --dry-run
//   npx tsx scripts/phase1-apply-migration-017.ts --apply

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
const MIGRATION_ID = '017-contract-rules';

const ALTERS: Array<[string, string]> = [
  ['contracts', 'passthrough_rule_json TEXT'],
  ['contracts', 'reminder_rule_json TEXT'],
  ['pending_charges', 'category TEXT'],
  ['pending_charges', 'classification TEXT'],
  ['pending_charges', 'needs_approval INTEGER NOT NULL DEFAULT 0'],
  ['invoices', `reminder_ticks_sent_json TEXT NOT NULL DEFAULT '[]'`],
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
    return;
  }

  console.log('Planned alters:');
  for (const [t, c] of ALTERS) console.log(`  ALTER TABLE ${t} ADD COLUMN ${c}`);
  console.log();

  if (DRY_RUN) {
    console.log('Dry run complete.');
    return;
  }

  for (const [table, col] of ALTERS) {
    try {
      await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col}`);
      console.log(`  altered ${table} + ${col.split(' ')[0]}`);
    } catch (err: any) {
      if (/duplicate column/i.test(String(err?.message ?? err))) {
        console.log(`  ${table}.${col.split(' ')[0]} already present`);
      } else {
        throw err;
      }
    }
  }

  await db.execute({
    sql: 'INSERT OR IGNORE INTO _migrations (id) VALUES (?)',
    args: [MIGRATION_ID],
  });

  // Verify every column is present after the run.
  const required = {
    contracts: ['passthrough_rule_json', 'reminder_rule_json'],
    pending_charges: ['category', 'classification', 'needs_approval'],
    invoices: ['reminder_ticks_sent_json'],
  };
  for (const [table, cols] of Object.entries(required)) {
    const info = await db.execute(`PRAGMA table_info(${table})`);
    const present = new Set(info.rows.map((r) => r[1] as string));
    for (const c of cols) {
      if (!present.has(c)) throw new Error(`${table}.${c} missing after apply`);
    }
    console.log(`  ${table} columns ok: ${cols.join(', ')}`);
  }
  console.log();
  console.log('Migration 017 applied and verified.');
}

main().catch((err) => {
  console.error('Migration 017 failed:', err);
  process.exit(1);
});
