// Emergency restore — slice 9 test reinserted position_tracking over
// ZipKit's real April 2026 keyword_snapshots (ingest-v2 does a
// snapshot-replace DELETE before inserting). The test's cleanup then
// removed the replacement rows, leaving zero rows for
// (ZipKit, period=kr9KaTaHS2xf9gjZEqT-D, source=position_tracking).
//
// The legacy keyword_rankings table still holds the original 100 rows
// from the 2026-04-11 ingest, and the original imports row
// (vaCn0hfnW8xAwzMFaWrmb, applied, rows=100) is intact. This script
// re-inserts the 100 rows into keyword_snapshots, binding them to
// the original import so downstream joins stay correct.
//
// Preflights refuse to run if:
//   - keyword_snapshots already has any position_tracking rows for
//     this period (would mean someone else already restored; abort
//     rather than double-insert).
//   - legacy keyword_rankings row count is not exactly 100.
//   - the original import is missing or not in 'applied' status.
//
// Run:
//   npx tsx scripts/phase1-restore-zipkit-position-tracking.ts --dry-run
//   npx tsx scripts/phase1-restore-zipkit-position-tracking.ts --apply

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

const ZIPKIT_CLIENT_ID = 'oYLqVOgsutCEPNwb7hizm';
const APRIL_PERIOD_ID = 'kr9KaTaHS2xf9gjZEqT-D';
const ORIGINAL_IMPORT_ID = 'vaCn0hfnW8xAwzMFaWrmb';
const SOURCE = 'position_tracking';
const LEGACY_MONTH = '2026-04';
const EXPECTED_ROW_COUNT = 100;

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY-RUN' : 'APPLY'}`);
  console.log();

  console.log('=== Preflight ===');

  // 1. keyword_snapshots must be empty for this (client, period, source).
  const currentSnapshots = await db.execute({
    sql: `SELECT COUNT(*) FROM keyword_snapshots
          WHERE client_id = ? AND period_id = ? AND source = ?`,
    args: [ZIPKIT_CLIENT_ID, APRIL_PERIOD_ID, SOURCE],
  });
  const existing = Number(currentSnapshots.rows[0][0]);
  console.log(`  keyword_snapshots (existing for period+source): ${existing}`);
  if (existing !== 0) {
    console.error(`ABORT: ${existing} rows already exist. Would duplicate the restore.`);
    process.exit(2);
  }

  // 2. Legacy keyword_rankings must hold exactly 100 rows.
  const legacyCount = await db.execute({
    sql: `SELECT COUNT(*) FROM keyword_rankings
          WHERE client_id = ? AND month = ? AND source = ?`,
    args: [ZIPKIT_CLIENT_ID, LEGACY_MONTH, SOURCE],
  });
  const legacyN = Number(legacyCount.rows[0][0]);
  console.log(`  legacy keyword_rankings count:              ${legacyN}`);
  if (legacyN !== EXPECTED_ROW_COUNT) {
    console.error(`ABORT: expected ${EXPECTED_ROW_COUNT} legacy rows, found ${legacyN}`);
    process.exit(2);
  }

  // 3. Original import must exist and be applied.
  const imp = await db.execute({
    sql: `SELECT id, source, status, row_count FROM imports WHERE id = ?`,
    args: [ORIGINAL_IMPORT_ID],
  });
  if (imp.rows.length !== 1) {
    console.error(`ABORT: original import ${ORIGINAL_IMPORT_ID} not found`);
    process.exit(2);
  }
  const impRow = imp.rows[0];
  console.log(`  original import ${impRow[0]}: source=${impRow[1]} status=${impRow[2]} rows=${impRow[3]}`);
  if (String(impRow[1]) !== SOURCE) {
    console.error(`ABORT: original import source is '${impRow[1]}', expected '${SOURCE}'`);
    process.exit(2);
  }
  if (String(impRow[2]) !== 'applied') {
    console.error(`ABORT: original import status is '${impRow[2]}', expected 'applied'`);
    process.exit(2);
  }

  console.log();
  console.log('Preflight passed. Loading legacy rows...');

  // Fetch the 100 legacy rows.
  const legacy = await db.execute({
    sql: `SELECT keyword, position, search_volume, url, change_val, seo_difficulty
          FROM keyword_rankings
          WHERE client_id = ? AND month = ? AND source = ?`,
    args: [ZIPKIT_CLIENT_ID, LEGACY_MONTH, SOURCE],
  });
  console.log(`  fetched ${legacy.rows.length} legacy rows`);
  console.log();

  console.log('=== Planned writes ===');
  console.log(`  INSERT INTO keyword_snapshots (${legacy.rows.length} rows)`);
  console.log(`    client_id  = ${ZIPKIT_CLIENT_ID}`);
  console.log(`    period_id  = ${APRIL_PERIOD_ID}`);
  console.log(`    import_id  = ${ORIGINAL_IMPORT_ID}`);
  console.log(`    source     = ${SOURCE}`);
  console.log();

  if (DRY_RUN) {
    console.log('Dry run complete. No rows written.');
    return;
  }

  // Transactional insert. If any one row fails the UNIQUE
  // (client_id, period_id, source, keyword) constraint, we'd rather
  // abort the whole restore than leave a partial state.
  const tx = await db.transaction('write');
  try {
    for (const row of legacy.rows) {
      await tx.execute({
        sql: `INSERT INTO keyword_snapshots
              (id, client_id, period_id, import_id, source, keyword, position, search_volume, url, change_val, seo_difficulty)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          nanoid(),
          ZIPKIT_CLIENT_ID,
          APRIL_PERIOD_ID,
          ORIGINAL_IMPORT_ID,
          SOURCE,
          row[0],
          row[1],
          row[2],
          row[3],
          row[4],
          row[5],
        ],
      });
    }
    await tx.commit();
    console.log('Commit OK.');
  } catch (err) {
    await tx.rollback();
    console.error('ROLLED BACK:', err);
    process.exit(3);
  }

  // Verify.
  const after = await db.execute({
    sql: `SELECT COUNT(*) FROM keyword_snapshots
          WHERE client_id = ? AND period_id = ? AND source = ?`,
    args: [ZIPKIT_CLIENT_ID, APRIL_PERIOD_ID, SOURCE],
  });
  const afterN = Number(after.rows[0][0]);
  console.log(`Post-apply keyword_snapshots count: ${afterN}`);
  if (afterN !== EXPECTED_ROW_COUNT) {
    console.error(`ABORT: expected ${EXPECTED_ROW_COUNT} rows after insert, found ${afterN}`);
    process.exit(3);
  }
  console.log('Restore verified.');
}

main().catch((err) => {
  console.error('Restore failed:', err);
  process.exit(1);
});
