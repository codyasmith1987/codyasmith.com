// Phase 1 Step 2 — one-shot applier for migration 011-uniqueness-guards.
//
// The normal migrate.ts runner uses import.meta.glob, which only works
// inside the Astro/Vite build context. This script applies the same SQL
// immediately against prod Turso and records the migration in _migrations
// so the runtime runner will see it as already-applied on next cold start.
//
// Pre-apply check: scans keyword_rankings and site_issues for any
// duplicates that would block index creation. Aborts with a clear error
// if found (Step 1 should have removed them).
//
// Run:
//   npx tsx scripts/phase1-apply-migration-011.ts --dry-run
//   npx tsx scripts/phase1-apply-migration-011.ts --apply

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

const MIGRATION_ID = '011-uniqueness-guards';

const STATEMENTS = [
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_keyword_rankings_client_month_source_keyword ON keyword_rankings(client_id, month, source, keyword)',
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_site_issues_client_month_issue ON site_issues(client_id, month, issue_name)',
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_contract_period ON invoices(contract_id, billing_period_start, billing_period_end)',
];

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY-RUN' : 'APPLY'}`);
  console.log();

  // Already applied?
  const existsRes = await db.execute(
    "SELECT 1 FROM _migrations WHERE id = ?",
    // libSQL execute with positional args
  );
  // Re-run with args to be safe (the overloaded exec above was without args).
  const already = await db.execute({
    sql: 'SELECT 1 FROM _migrations WHERE id = ?',
    args: [MIGRATION_ID],
  });
  if (already.rows.length > 0) {
    console.log(`Migration ${MIGRATION_ID} is already recorded in _migrations. Nothing to do.`);
    return;
  }
  void existsRes; // silence unused

  // Pre-apply duplicate checks.
  console.log('=== Pre-apply duplicate scan ===');
  const kwDupes = await db.execute(`
    SELECT client_id, month, source, keyword, COUNT(*) n
    FROM keyword_rankings
    GROUP BY client_id, month, source, keyword
    HAVING n > 1
    LIMIT 10
  `);
  const issueDupes = await db.execute(`
    SELECT client_id, month, issue_name, COUNT(*) n
    FROM site_issues
    GROUP BY client_id, month, issue_name
    HAVING n > 1
    LIMIT 10
  `);
  const invoiceDupes = await db.execute(`
    SELECT contract_id, billing_period_start, billing_period_end, COUNT(*) n
    FROM invoices
    WHERE billing_period_start IS NOT NULL
    GROUP BY contract_id, billing_period_start, billing_period_end
    HAVING n > 1
    LIMIT 10
  `);
  console.log(`  keyword_rankings duplicate groups: ${kwDupes.rows.length}`);
  console.log(`  site_issues duplicate groups:      ${issueDupes.rows.length}`);
  console.log(`  invoices period duplicate groups:  ${invoiceDupes.rows.length}`);
  if (kwDupes.rows.length || issueDupes.rows.length || invoiceDupes.rows.length) {
    console.error('Duplicates remain. Re-run Step 1 dedupe before applying this migration.');
    for (const r of kwDupes.rows) console.error('  kw:', r);
    for (const r of issueDupes.rows) console.error('  issue:', r);
    for (const r of invoiceDupes.rows) console.error('  invoice:', r);
    process.exit(2);
  }
  console.log();

  console.log('=== Statements to execute ===');
  for (const s of STATEMENTS) console.log('  ' + s);
  console.log();

  if (DRY_RUN) {
    console.log('Dry run complete. No changes made.');
    return;
  }

  console.log('Applying...');
  // batch() runs as an implicit transaction in libSQL.
  await db.batch([...STATEMENTS, { sql: 'INSERT INTO _migrations (id) VALUES (?)', args: [MIGRATION_ID] }], 'write');
  console.log('Batch committed.');

  // Verify indexes exist.
  console.log();
  console.log('=== Post-apply verification ===');
  const indexes = await db.execute(
    "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'uq\\_%' ESCAPE '\\' ORDER BY name"
  );
  for (const r of indexes.rows) console.log('  index present: ' + r[0]);

  // Probe by attempting a harmless duplicate INSERT that must fail.
  console.log();
  console.log('=== Constraint probe (expected: 3 failures) ===');
  for (const probe of [
    {
      name: 'keyword_rankings',
      sql: `INSERT INTO keyword_rankings (id, client_id, month, keyword, source)
            SELECT 'probe-kw-' || hex(randomblob(4)), client_id, month, keyword, source FROM keyword_rankings LIMIT 1`,
    },
    {
      name: 'site_issues',
      sql: `INSERT INTO site_issues (id, client_id, month, issue_name)
            SELECT 'probe-si-' || hex(randomblob(4)), client_id, month, issue_name FROM site_issues LIMIT 1`,
    },
  ]) {
    try {
      await db.execute(probe.sql);
      console.error(`  ${probe.name}: PROBE SUCCEEDED — constraint NOT enforcing`);
      process.exit(3);
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (/UNIQUE constraint failed/i.test(msg)) {
        console.log(`  ${probe.name}: UNIQUE enforced ✓`);
      } else {
        console.error(`  ${probe.name}: unexpected error: ${msg}`);
        process.exit(3);
      }
    }
  }

  console.log();
  console.log('Migration 011 applied and verified.');
}

main().catch((err) => {
  console.error('Migration 011 failed:', err);
  process.exit(1);
});
