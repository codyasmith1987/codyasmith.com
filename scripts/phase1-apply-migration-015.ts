// Phase 1 Step 6 — applier for migration 015-contract-engine.
//
// Run:
//   npx tsx scripts/phase1-apply-migration-015.ts --dry-run
//   npx tsx scripts/phase1-apply-migration-015.ts --apply

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
const MIGRATION_ID = '015-contract-engine';

const ALTERS: Array<[string, string]> = [
  ['clients', 'primary_url TEXT'],
  ['clients', 'brand_accent TEXT'],
  ['clients', 'primary_contact_email TEXT'],
  ['clients', 'reading_level_target INTEGER DEFAULT 7'],
  ['contracts', 'service_type TEXT'],
  [
    'contracts',
    `modules_json TEXT NOT NULL DEFAULT '["dashboard","rankings","health","files","invoices"]'`,
  ],
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

  console.log('Planned alters:');
  for (const [t, c] of ALTERS) console.log(`  ALTER TABLE ${t} ADD COLUMN ${c}`);

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

  // Verify.
  const clientsCols = await db.execute('PRAGMA table_info(clients)');
  const contractsCols = await db.execute('PRAGMA table_info(contracts)');
  const clientColNames = clientsCols.rows.map((r) => r[1] as string);
  const contractColNames = contractsCols.rows.map((r) => r[1] as string);
  console.log('clients columns now:', clientColNames.join(', '));
  console.log('contracts columns now:', contractColNames.join(', '));

  const required = {
    clients: ['primary_url', 'brand_accent', 'primary_contact_email', 'reading_level_target'],
    contracts: ['service_type', 'modules_json'],
  };
  for (const c of required.clients) {
    if (!clientColNames.includes(c)) throw new Error(`clients.${c} missing`);
  }
  for (const c of required.contracts) {
    if (!contractColNames.includes(c)) throw new Error(`contracts.${c} missing`);
  }
  console.log('Verified all required columns present.');
}

main().catch((err) => {
  console.error('Migration 015 failed:', err);
  process.exit(1);
});
