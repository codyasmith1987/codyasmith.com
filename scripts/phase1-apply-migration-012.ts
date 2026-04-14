// Phase 1 Step 3 — one-shot applier for migration 012-periods-imports.
//
// Does two jobs:
//   (a) Executes the schema statements from src/lib/migrations/012-periods-imports.ts
//       directly against prod Turso and records the migration in _migrations.
//   (b) Backfills: for every existing csv_uploads row, creates a matching
//       periods row (if absent) and an imports row, then updates the
//       corresponding metrics/keyword_rankings/site_issues rows with
//       period_id and import_id.
//
// Import status derivation:
//   - csv_uploads.error IS NULL                       → 'applied'
//   - error = 'Unrecognized CSV format'                → 'failed'
//   - error LIKE 'Superseded during Phase 1 cleanup%'  → 'superseded'
//   - any other non-null error                         → 'failed'
//
// Content hash: historical bytes are unrecoverable. Use 'legacy:<upload_id>'
// so the UNIQUE(client_id, period_id, source, content_hash) constraint holds.
//
// Run:
//   npx tsx scripts/phase1-apply-migration-012.ts --dry-run
//   npx tsx scripts/phase1-apply-migration-012.ts --apply

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
const MIGRATION_ID = '012-periods-imports';

// Which data tables a given format writes to. Mirrors FORMAT_SOURCES in
// src/lib/csv/index.ts. Kept in sync manually for now.
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

function monthToPeriod(month: string): { start: string; end: string } {
  // month is 'YYYY-MM'. Period start = YYYY-MM-01, end = last day of month.
  const [y, m] = month.split('-').map(Number);
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  // JS Date trick: day 0 of next month = last day of this month
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const end = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { start, end };
}

function statusFromError(err: string | null): 'applied' | 'superseded' | 'failed' {
  if (err === null) return 'applied';
  if (/^Superseded during Phase 1 cleanup/.test(err)) return 'superseded';
  return 'failed';
}

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY-RUN' : 'APPLY'}`);
  console.log();

  // Already applied?
  const already = await db.execute({
    sql: 'SELECT 1 FROM _migrations WHERE id = ?',
    args: [MIGRATION_ID],
  });
  const needsSchema = already.rows.length === 0;
  console.log(`Migration 012 schema recorded: ${!needsSchema}`);

  // Load csv_uploads.
  const uploads = (
    await db.execute(
      'SELECT id, client_id, original_name, detected_format, row_count, month, uploaded_by, error, created_at FROM csv_uploads ORDER BY created_at'
    )
  ).rows.map((r) => ({
    id: r[0] as string,
    client_id: r[1] as string,
    original_name: r[2] as string,
    detected_format: r[3] as string,
    row_count: Number(r[4]),
    month: r[5] as string,
    uploaded_by: r[6] as string,
    error: r[7] as string | null,
    created_at: r[8] as string,
  }));
  console.log(`csv_uploads rows: ${uploads.length}`);

  // Plan periods.
  const periodKey = (clientId: string, month: string) => `${clientId}|month|${month}`;
  const plannedPeriods = new Map<string, { id: string; client_id: string; period_start: string; period_end: string }>();
  for (const u of uploads) {
    const k = periodKey(u.client_id, u.month);
    if (plannedPeriods.has(k)) continue;
    const { start, end } = monthToPeriod(u.month);
    plannedPeriods.set(k, { id: nanoid(), client_id: u.client_id, period_start: start, period_end: end });
  }
  console.log(`Periods to ensure: ${plannedPeriods.size}`);
  for (const p of plannedPeriods.values()) {
    console.log(`  period  ${p.client_id}  ${p.period_start} .. ${p.period_end}`);
  }

  // Plan imports (1 per csv_upload).
  interface PlannedImport {
    id: string;
    upload_id: string;
    client_id: string;
    period_key: string;
    source: string;
    original_name: string;
    content_hash: string;
    status: 'applied' | 'superseded' | 'failed';
    row_count: number;
    uploaded_by: string;
    started_at: string;
  }
  const plannedImports: PlannedImport[] = uploads.map((u) => ({
    id: nanoid(),
    upload_id: u.id,
    client_id: u.client_id,
    period_key: periodKey(u.client_id, u.month),
    source: u.detected_format === 'unknown' ? 'unknown' : u.detected_format,
    original_name: u.original_name,
    content_hash: `legacy:${u.id}`,
    status: u.detected_format === 'unknown' ? 'failed' : statusFromError(u.error),
    row_count: u.row_count,
    uploaded_by: u.uploaded_by,
    started_at: u.created_at,
  }));
  const byStatus = plannedImports.reduce<Record<string, number>>((acc, i) => {
    acc[i.status] = (acc[i.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`Imports to create: ${plannedImports.length}  ${JSON.stringify(byStatus)}`);

  // Plan data-row backfill counts.
  console.log();
  console.log('=== Data row backfill plan ===');
  const tables = ['metrics', 'keyword_rankings', 'site_issues'];
  const backfillCounts: Record<string, number> = {};
  for (const t of tables) {
    const r = await db.execute(`SELECT COUNT(*) FROM "${t}" WHERE csv_upload_id IS NOT NULL`);
    backfillCounts[t] = Number(r.rows[0][0]);
    console.log(`  ${t.padEnd(18)} rows with csv_upload_id: ${backfillCounts[t]}`);
  }
  const unlinked: Record<string, number> = {};
  for (const t of tables) {
    const r = await db.execute(`SELECT COUNT(*) FROM "${t}" WHERE csv_upload_id IS NULL`);
    unlinked[t] = Number(r.rows[0][0]);
    if (unlinked[t] > 0) console.log(`  ${t.padEnd(18)} rows WITHOUT csv_upload_id: ${unlinked[t]} (will stay null)`);
  }
  console.log();

  if (DRY_RUN) {
    console.log('Dry run complete.');
    return;
  }

  // === APPLY ===

  if (needsSchema) {
    console.log('Applying schema statements...');
    await db.batch(
      [
        `CREATE TABLE IF NOT EXISTS periods (
          id TEXT PRIMARY KEY,
          client_id TEXT NOT NULL REFERENCES clients(id),
          period_type TEXT NOT NULL DEFAULT 'month',
          period_start TEXT NOT NULL,
          period_end TEXT NOT NULL,
          locked_at TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          UNIQUE(client_id, period_type, period_start)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_periods_client ON periods(client_id, period_start)`,
        `CREATE TABLE IF NOT EXISTS imports (
          id TEXT PRIMARY KEY,
          client_id TEXT NOT NULL REFERENCES clients(id),
          period_id TEXT NOT NULL REFERENCES periods(id),
          source TEXT NOT NULL,
          original_name TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          status TEXT NOT NULL,
          row_count INTEGER NOT NULL DEFAULT 0,
          uploaded_by TEXT NOT NULL REFERENCES users(id),
          started_at TEXT DEFAULT (datetime('now')),
          finished_at TEXT,
          error TEXT,
          UNIQUE(client_id, period_id, source, content_hash)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_imports_period ON imports(period_id)`,
        `CREATE INDEX IF NOT EXISTS idx_imports_client_status ON imports(client_id, status)`,
      ],
      'write'
    );

    // ALTER TABLE ADD COLUMN — individual with try/catch so partial re-runs survive.
    const alters: Array<[string, string]> = [
      ['metrics', 'period_id TEXT REFERENCES periods(id)'],
      ['metrics', 'import_id TEXT REFERENCES imports(id)'],
      ['keyword_rankings', 'period_id TEXT REFERENCES periods(id)'],
      ['keyword_rankings', 'import_id TEXT REFERENCES imports(id)'],
      ['site_issues', 'period_id TEXT REFERENCES periods(id)'],
      ['site_issues', 'import_id TEXT REFERENCES imports(id)'],
    ];
    for (const [table, col] of alters) {
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
  }

  // Backfill periods + imports + data-row linkage inside one transaction.
  console.log('Backfilling periods, imports, and data rows...');
  const tx = await db.transaction('write');
  try {
    // Periods
    for (const p of plannedPeriods.values()) {
      await tx.execute({
        sql: `INSERT OR IGNORE INTO periods (id, client_id, period_type, period_start, period_end)
              VALUES (?, ?, 'month', ?, ?)`,
        args: [p.id, p.client_id, p.period_start, p.period_end],
      });
    }
    // Re-read periods so we pick up canonical ids even if an IGNORE silently skipped.
    const periodLookup = new Map<string, string>();
    for (const p of plannedPeriods.values()) {
      const row = await tx.execute({
        sql: "SELECT id FROM periods WHERE client_id = ? AND period_type = 'month' AND period_start = ?",
        args: [p.client_id, p.period_start],
      });
      const pid = row.rows[0][0] as string;
      periodLookup.set(`${p.client_id}|month|${p.period_start.slice(0, 7)}`, pid);
    }

    // Imports
    const importLookupByUpload = new Map<string, string>();
    for (const imp of plannedImports) {
      const pid = periodLookup.get(imp.period_key);
      if (!pid) throw new Error(`No period resolved for ${imp.period_key}`);
      await tx.execute({
        sql: `INSERT OR IGNORE INTO imports
              (id, client_id, period_id, source, original_name, content_hash,
               status, row_count, uploaded_by, started_at, finished_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          imp.id,
          imp.client_id,
          pid,
          imp.source,
          imp.original_name,
          imp.content_hash,
          imp.status,
          imp.row_count,
          imp.uploaded_by,
          imp.started_at,
          imp.status === 'applied' ? imp.started_at : null,
        ],
      });
      // Resolve the actual id (in case of IGNORE). Use the content_hash unique.
      const row = await tx.execute({
        sql: 'SELECT id FROM imports WHERE client_id = ? AND period_id = ? AND source = ? AND content_hash = ?',
        args: [imp.client_id, pid, imp.source, imp.content_hash],
      });
      importLookupByUpload.set(imp.upload_id, row.rows[0][0] as string);
    }

    // Data-row backfill
    let totalBackfilled = 0;
    for (const table of tables) {
      for (const [uploadId, importId] of importLookupByUpload.entries()) {
        // Resolve period_id for this import.
        const r = await tx.execute({
          sql: 'SELECT period_id FROM imports WHERE id = ?',
          args: [importId],
        });
        const periodId = r.rows[0][0] as string;
        const res = await tx.execute({
          sql: `UPDATE "${table}" SET period_id = ?, import_id = ? WHERE csv_upload_id = ? AND period_id IS NULL`,
          args: [periodId, importId, uploadId],
        });
        totalBackfilled += Number((res as any).rowsAffected ?? 0);
      }
    }
    console.log(`  linked ${totalBackfilled} data rows to period_id + import_id`);

    // Record migration
    if (needsSchema) {
      await tx.execute({
        sql: 'INSERT OR IGNORE INTO _migrations (id) VALUES (?)',
        args: [MIGRATION_ID],
      });
    }

    await tx.commit();
    console.log('Commit OK.');
  } catch (err) {
    await tx.rollback();
    console.error('ROLLED BACK:', err);
    process.exit(2);
  }

  // Verify.
  console.log();
  console.log('=== Post-apply verification ===');
  const periodsCount = await db.execute('SELECT COUNT(*) FROM periods');
  const importsCount = await db.execute('SELECT COUNT(*) FROM imports');
  console.log(`  periods: ${periodsCount.rows[0][0]}`);
  console.log(`  imports: ${importsCount.rows[0][0]}`);

  for (const t of tables) {
    const linked = await db.execute(`SELECT COUNT(*) FROM "${t}" WHERE period_id IS NOT NULL AND import_id IS NOT NULL`);
    const unlinkedWithUpload = await db.execute(
      `SELECT COUNT(*) FROM "${t}" WHERE (period_id IS NULL OR import_id IS NULL) AND csv_upload_id IS NOT NULL`
    );
    const total = await db.execute(`SELECT COUNT(*) FROM "${t}"`);
    console.log(`  ${t.padEnd(18)} total=${total.rows[0][0]} linked=${linked.rows[0][0]} missing_but_had_upload_id=${unlinkedWithUpload.rows[0][0]}`);
    if (Number(unlinkedWithUpload.rows[0][0]) > 0) {
      console.error(`  ${t}: ${unlinkedWithUpload.rows[0][0]} rows had csv_upload_id but no period_id/import_id`);
      process.exit(3);
    }
  }

  console.log();
  console.log('Migration 012 applied and verified.');
}

main().catch((err) => {
  console.error('Migration 012 failed:', err);
  process.exit(1);
});
