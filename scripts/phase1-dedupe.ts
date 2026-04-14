// Phase 1 Step 1 — dedupe stacked rows in site_issues and keyword_rankings.
//
// Root cause (from audit): clearPreviousData in src/lib/csv/index.ts was
// evidently added after some rows already existed; for at least two formats
// (issues_overview, keyword_suggestions) the historical data was never
// cleaned and now sits in the live tables alongside newer uploads. metrics
// self-healed because of its UNIQUE constraint; the other two have none.
//
// Rule: "last upload wins, per format."
// For every (client_id, month, detected_format) in csv_uploads, pick the
// most recent row where error IS NULL. All earlier uploads of that
// (client_id, month, detected_format) are LOSERS: their rows in the
// affected data tables are deleted, and their csv_uploads row is marked
// error='Superseded during Phase 1 cleanup (<ts>)'.
//
// After format-level dedupe, a second pass collapses any remaining
// (client_id, month, source, keyword) duplicates inside a single winning
// upload by keeping the lowest rowid. This handles intra-file duplicates
// (e.g., the same keyword appearing twice in one Ubersuggest export).
//
// site_issues has no `source` column yet; we group only by issue_name.
//
// Run:
//   npx tsx scripts/phase1-dedupe.ts --dry-run
//   npx tsx scripts/phase1-dedupe.ts --apply
//
// --dry-run  prints every planned DELETE/UPDATE without executing
// --apply    executes inside a single transaction; any error rolls back

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

// Formats from src/lib/csv/index.ts FORMAT_SOURCES.
const FORMAT_TABLES: Record<string, string[]> = {
  position_tracking: ['keyword_rankings'],
  keyword_research: ['keyword_rankings'],
  keyword_suggestions: ['keyword_rankings'],
  issues_overview: ['site_issues', 'metrics'],
  crawl_overview: ['metrics'],
  image_optimization: ['metrics'],
  site_audit: ['site_issues'],
  accessibility: ['metrics'],
};

interface UploadRow {
  id: string;
  client_id: string;
  month: string;
  detected_format: string;
  created_at: string;
  error: string | null;
}

function isoStamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY-RUN (no writes)' : 'APPLY (writes in a transaction)'}`);
  console.log();

  // 1. Load every csv_uploads row.
  const uploadsResult = await db.execute(
    'SELECT id, client_id, month, detected_format, created_at, error FROM csv_uploads ORDER BY client_id, month, detected_format, created_at'
  );
  const uploads: UploadRow[] = uploadsResult.rows.map((r) => ({
    id: r[0] as string,
    client_id: r[1] as string,
    month: r[2] as string,
    detected_format: r[3] as string,
    created_at: r[4] as string,
    error: r[5] as string | null,
  }));

  // 2. Partition by (client_id, month, detected_format) and pick winners.
  const winnersByKey = new Map<string, UploadRow>();
  const losers: UploadRow[] = [];
  for (const u of uploads) {
    if (u.detected_format === 'unknown') continue;
    const key = `${u.client_id}|${u.month}|${u.detected_format}`;
    const currentWinner = winnersByKey.get(key);
    // Only non-errored rows are eligible to be winners. Errored rows are
    // already superseded/failed and should be ignored (they also have no
    // data rows associated).
    if (u.error !== null) continue;
    if (!currentWinner || u.created_at > currentWinner.created_at) {
      if (currentWinner) losers.push(currentWinner);
      winnersByKey.set(key, u);
    } else {
      losers.push(u);
    }
  }

  console.log('=== Format-level dedupe plan ===');
  console.log(`Total uploads: ${uploads.length}`);
  console.log(`Winners:       ${winnersByKey.size}`);
  console.log(`Losers:        ${losers.length}`);
  console.log();

  // 3. For each loser, plan DELETEs on its format's affected tables.
  interface PlannedDelete {
    table: string;
    uploadId: string;
    uploadKey: string;
    expectedRows: number;
  }
  const planned: PlannedDelete[] = [];

  for (const loser of losers) {
    const tables = FORMAT_TABLES[loser.detected_format] ?? [];
    const key = `${loser.client_id}|${loser.month}|${loser.detected_format}`;
    for (const table of tables) {
      const count = await db.execute({
        sql: `SELECT COUNT(*) FROM "${table}" WHERE csv_upload_id = ?`,
        args: [loser.id],
      });
      planned.push({
        table,
        uploadId: loser.id,
        uploadKey: key,
        expectedRows: Number(count.rows[0][0]),
      });
    }
  }

  for (const p of planned) {
    console.log(
      `  DELETE from ${p.table.padEnd(18)}  where csv_upload_id = ${p.uploadId}   (${p.expectedRows} rows)   [${p.uploadKey}]`
    );
  }
  if (planned.length === 0) console.log('  (no format-level losers)');
  console.log();

  // 4. Intra-winner keyword duplicates (same keyword twice in one upload).
  console.log('=== Intra-winner keyword duplicate pass ===');
  const intraDupes = await db.execute(
    `SELECT client_id, month, source, keyword, csv_upload_id, COUNT(*) n, MIN(rowid) keep_rowid
     FROM keyword_rankings
     GROUP BY client_id, month, source, keyword, csv_upload_id
     HAVING n > 1`
  );
  console.log(`Intra-upload keyword duplicate groups: ${intraDupes.rows.length}`);
  let intraDupeDeletes = 0;
  for (const r of intraDupes.rows) {
    const group = {
      client_id: r[0] as string,
      month: r[1] as string,
      source: r[2] as string,
      keyword: r[3] as string,
      upload_id: r[4] as string,
      n: Number(r[5]),
      keep_rowid: Number(r[6]),
    };
    const willDelete = group.n - 1;
    intraDupeDeletes += willDelete;
    console.log(
      `  collapse ${group.n}→1  [${group.client_id} ${group.month} ${group.source}]  "${group.keyword}"  keep rowid=${group.keep_rowid}`
    );
  }
  console.log(`Intra-winner rows to delete: ${intraDupeDeletes}`);
  console.log();

  // 5. Cross-winner issue duplicates (same issue_name, multiple winning uploads).
  // site_issues has no source column, so different formats writing to it
  // can collide on issue_name. Handle only within the same winning upload
  // for now; the snapshot migration in Step 4 re-partitions by source.
  console.log('=== Intra-winner site_issues duplicate pass ===');
  const intraIssueDupes = await db.execute(
    `SELECT client_id, month, issue_name, csv_upload_id, COUNT(*) n, MIN(rowid) keep_rowid
     FROM site_issues
     GROUP BY client_id, month, issue_name, csv_upload_id
     HAVING n > 1`
  );
  console.log(`Intra-upload issue duplicate groups: ${intraIssueDupes.rows.length}`);
  let intraIssueDeletes = 0;
  for (const r of intraIssueDupes.rows) {
    const n = Number(r[4]);
    intraIssueDeletes += n - 1;
    console.log(
      `  collapse ${n}→1  [${r[0]} ${r[1]}]  "${r[2]}"  keep rowid=${r[5]}`
    );
  }
  console.log(`Intra-winner site_issues rows to delete: ${intraIssueDeletes}`);
  console.log();

  // 6. Expected post-state summary per table.
  console.log('=== Expected post-state row counts ===');
  for (const table of ['site_issues', 'keyword_rankings', 'metrics']) {
    const before = await db.execute(`SELECT COUNT(*) FROM "${table}"`);
    let toRemove = 0;
    for (const p of planned) if (p.table === table) toRemove += p.expectedRows;
    if (table === 'keyword_rankings') toRemove += intraDupeDeletes;
    if (table === 'site_issues') toRemove += intraIssueDeletes;
    console.log(
      `  ${table.padEnd(18)}  before=${String(before.rows[0][0]).padStart(5)}  delete=${String(toRemove).padStart(5)}  after=${Number(before.rows[0][0]) - toRemove}`
    );
  }
  console.log();

  if (DRY_RUN) {
    console.log('Dry run complete. No rows were changed.');
    return;
  }

  // 7. APPLY — single transaction.
  console.log('Applying in transaction...');
  const tx = await db.transaction('write');
  try {
    // Format-level deletes.
    for (const p of planned) {
      const res = await tx.execute({
        sql: `DELETE FROM "${p.table}" WHERE csv_upload_id = ?`,
        args: [p.uploadId],
      });
      const n = Number((res as any).rowsAffected ?? 0);
      if (n !== p.expectedRows) {
        throw new Error(
          `Unexpected delete count on ${p.table} for upload ${p.uploadId}: expected ${p.expectedRows}, got ${n}`
        );
      }
    }
    // Mark losers as superseded.
    for (const loser of losers) {
      await tx.execute({
        sql: 'UPDATE csv_uploads SET error = ? WHERE id = ?',
        args: [`Superseded during Phase 1 cleanup (${isoStamp()})`, loser.id],
      });
    }
    // Intra-winner keyword dupes: delete all but the lowest rowid per group.
    for (const r of intraDupes.rows) {
      await tx.execute({
        sql: `DELETE FROM keyword_rankings
              WHERE client_id = ? AND month = ? AND source = ? AND keyword = ? AND csv_upload_id = ?
                AND rowid <> ?`,
        args: [r[0], r[1], r[2], r[3], r[4], r[6]],
      });
    }
    // Intra-winner issue dupes.
    for (const r of intraIssueDupes.rows) {
      await tx.execute({
        sql: `DELETE FROM site_issues
              WHERE client_id = ? AND month = ? AND issue_name = ? AND csv_upload_id = ?
                AND rowid <> ?`,
        args: [r[0], r[1], r[2], r[3], r[5]],
      });
    }
    await tx.commit();
    console.log('Commit OK.');
  } catch (err) {
    await tx.rollback();
    console.error('ROLLED BACK:', err);
    process.exit(2);
  }

  // 8. Post-apply verification.
  console.log();
  console.log('=== Post-apply verification ===');
  const kwDupes = await db.execute(
    'SELECT COUNT(*) FROM (SELECT 1 FROM keyword_rankings GROUP BY client_id, month, source, keyword HAVING COUNT(*) > 1)'
  );
  const issueDupes = await db.execute(
    'SELECT COUNT(*) FROM (SELECT 1 FROM site_issues GROUP BY client_id, month, issue_name HAVING COUNT(*) > 1)'
  );
  console.log(`keyword_rankings (client,month,source,keyword) duplicates: ${kwDupes.rows[0][0]}`);
  console.log(`site_issues (client,month,issue_name) duplicates: ${issueDupes.rows[0][0]}`);
  const kwCount = await db.execute('SELECT COUNT(*) FROM keyword_rankings');
  const siCount = await db.execute('SELECT COUNT(*) FROM site_issues');
  console.log(`keyword_rankings rows: ${kwCount.rows[0][0]}`);
  console.log(`site_issues rows: ${siCount.rows[0][0]}`);
  if (Number(kwDupes.rows[0][0]) !== 0 || Number(issueDupes.rows[0][0]) !== 0) {
    console.error('VERIFICATION FAILED: duplicates remain. Restore from backup.');
    process.exit(3);
  }
  console.log();
  console.log('Phase 1 Step 1 complete. Step 2 (uniqueness constraints) can now run safely.');
}

main().catch((err) => {
  console.error('Dedupe failed:', err);
  process.exit(1);
});
