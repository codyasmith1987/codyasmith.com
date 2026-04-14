// Phase 1 Step 4a — applier for migration 013-snapshot-tables.
//
// (a) Executes the DDL for the three snapshot tables.
// (b) Backfills every existing legacy data row into the matching
//     snapshot table. The legacy rows already have period_id and
//     import_id populated (from Step 3), and the import's `source` is
//     the canonical source for each row.
//
// Only rows whose import.status = 'applied' are backfilled. After the
// Step 1 dedupe, no data rows exist under superseded imports anyway,
// but the filter is defensive.
//
// Row id: reuse the legacy `id` so it's easy to cross-reference both
// models during the Step 4c cutover.
//
// Run:
//   npx tsx scripts/phase1-apply-migration-013.ts --dry-run
//   npx tsx scripts/phase1-apply-migration-013.ts --apply

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
const MIGRATION_ID = '013-snapshot-tables';

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS metric_snapshots (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES clients(id),
    period_id TEXT NOT NULL REFERENCES periods(id),
    import_id TEXT NOT NULL REFERENCES imports(id),
    category TEXT NOT NULL,
    metric_key TEXT NOT NULL,
    metric_value REAL NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(client_id, period_id, category, metric_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_metric_snapshots_period ON metric_snapshots(client_id, period_id)`,
  `CREATE INDEX IF NOT EXISTS idx_metric_snapshots_cat ON metric_snapshots(client_id, period_id, category)`,
  `CREATE TABLE IF NOT EXISTS keyword_snapshots (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES clients(id),
    period_id TEXT NOT NULL REFERENCES periods(id),
    import_id TEXT NOT NULL REFERENCES imports(id),
    source TEXT NOT NULL,
    keyword TEXT NOT NULL,
    position INTEGER,
    search_volume INTEGER,
    url TEXT,
    change_val INTEGER,
    seo_difficulty INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(client_id, period_id, source, keyword)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_keyword_snapshots_period ON keyword_snapshots(client_id, period_id)`,
  `CREATE INDEX IF NOT EXISTS idx_keyword_snapshots_source ON keyword_snapshots(client_id, period_id, source)`,
  `CREATE TABLE IF NOT EXISTS issue_snapshots (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES clients(id),
    period_id TEXT NOT NULL REFERENCES periods(id),
    import_id TEXT NOT NULL REFERENCES imports(id),
    source TEXT NOT NULL,
    issue_name TEXT NOT NULL,
    issue_type TEXT,
    priority TEXT,
    affected_urls INTEGER,
    pct_of_total REAL,
    description TEXT,
    how_to_fix TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(client_id, period_id, source, issue_name)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_issue_snapshots_period ON issue_snapshots(client_id, period_id)`,
];

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY-RUN' : 'APPLY'}`);
  console.log();

  const already = await db.execute({
    sql: 'SELECT 1 FROM _migrations WHERE id = ?',
    args: [MIGRATION_ID],
  });
  const needsSchema = already.rows.length === 0;
  console.log(`Migration 013 schema recorded: ${!needsSchema}`);
  console.log();

  // Plan: count eligible legacy rows.
  console.log('=== Backfill plan (eligible = import.status = applied) ===');
  const plan = {
    metrics: 0,
    keyword_rankings: 0,
    site_issues: 0,
  };
  for (const table of ['metrics', 'keyword_rankings', 'site_issues'] as const) {
    const res = await db.execute(
      `SELECT COUNT(*) FROM "${table}" t
       JOIN imports i ON i.id = t.import_id
       WHERE i.status = 'applied'`
    );
    plan[table] = Number(res.rows[0][0]);
    console.log(`  ${table.padEnd(18)} → snapshot rows: ${plan[table]}`);
  }

  // Rows with no import linkage (should be zero after Step 3).
  for (const table of ['metrics', 'keyword_rankings', 'site_issues']) {
    const res = await db.execute(
      `SELECT COUNT(*) FROM "${table}" WHERE import_id IS NULL OR period_id IS NULL`
    );
    const n = Number(res.rows[0][0]);
    if (n > 0) {
      console.error(`  WARNING: ${table} has ${n} rows without period_id/import_id — those will NOT be backfilled`);
    }
  }
  console.log();

  if (DRY_RUN) {
    console.log('Dry run complete.');
    return;
  }

  // === APPLY ===

  if (needsSchema) {
    console.log('Applying schema...');
    await db.batch(SCHEMA_STATEMENTS, 'write');
  }

  console.log('Backfilling snapshots...');
  const tx = await db.transaction('write');
  try {
    // metric_snapshots ← metrics
    // Take import.source as the canonical source (ignore any legacy metrics.source value).
    const metricsRes = await tx.execute(`
      INSERT OR IGNORE INTO metric_snapshots
        (id, client_id, period_id, import_id, category, metric_key, metric_value, source, created_at)
      SELECT
        m.id, m.client_id, m.period_id, m.import_id, m.category, m.metric_key, m.metric_value,
        i.source, m.created_at
      FROM metrics m
      JOIN imports i ON i.id = m.import_id
      WHERE i.status = 'applied'
    `);
    const mCount = Number((metricsRes as any).rowsAffected ?? 0);

    // keyword_snapshots ← keyword_rankings
    const keywordsRes = await tx.execute(`
      INSERT OR IGNORE INTO keyword_snapshots
        (id, client_id, period_id, import_id, source, keyword, position, search_volume, url,
         change_val, seo_difficulty, created_at)
      SELECT
        k.id, k.client_id, k.period_id, k.import_id, k.source, k.keyword, k.position,
        k.search_volume, k.url, k.change_val, k.seo_difficulty, k.created_at
      FROM keyword_rankings k
      JOIN imports i ON i.id = k.import_id
      WHERE i.status = 'applied'
    `);
    const kCount = Number((keywordsRes as any).rowsAffected ?? 0);

    // issue_snapshots ← site_issues (derive source from import)
    const issuesRes = await tx.execute(`
      INSERT OR IGNORE INTO issue_snapshots
        (id, client_id, period_id, import_id, source, issue_name, issue_type, priority,
         affected_urls, pct_of_total, description, how_to_fix, created_at)
      SELECT
        s.id, s.client_id, s.period_id, s.import_id, i.source, s.issue_name, s.issue_type,
        s.priority, s.affected_urls, s.pct_of_total, s.description, s.how_to_fix, s.created_at
      FROM site_issues s
      JOIN imports i ON i.id = s.import_id
      WHERE i.status = 'applied'
    `);
    const iCount = Number((issuesRes as any).rowsAffected ?? 0);

    console.log(`  metric_snapshots  inserted: ${mCount}`);
    console.log(`  keyword_snapshots inserted: ${kCount}`);
    console.log(`  issue_snapshots   inserted: ${iCount}`);

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

  // Post-verify: row-count parity.
  console.log();
  console.log('=== Post-apply verification ===');
  const checks: Array<[string, string]> = [
    ['metrics', 'metric_snapshots'],
    ['keyword_rankings', 'keyword_snapshots'],
    ['site_issues', 'issue_snapshots'],
  ];
  for (const [legacy, snap] of checks) {
    const legacyCount = Number(
      (
        await db.execute(
          `SELECT COUNT(*) FROM "${legacy}" t JOIN imports i ON i.id = t.import_id WHERE i.status = 'applied'`
        )
      ).rows[0][0]
    );
    const snapCount = Number((await db.execute(`SELECT COUNT(*) FROM "${snap}"`)).rows[0][0]);
    const ok = legacyCount === snapCount ? '✓' : 'MISMATCH';
    console.log(`  ${legacy.padEnd(18)} ${legacyCount}  →  ${snap.padEnd(18)} ${snapCount}  ${ok}`);
    if (legacyCount !== snapCount) process.exit(3);
  }

  // Check unique constraints enforcing by probing.
  console.log();
  console.log('=== Constraint probe ===');
  for (const probe of [
    {
      name: 'metric_snapshots',
      sql: `INSERT INTO metric_snapshots (id, client_id, period_id, import_id, category, metric_key, metric_value, source)
            SELECT 'probe-' || hex(randomblob(4)), client_id, period_id, import_id, category, metric_key, metric_value, source FROM metric_snapshots LIMIT 1`,
    },
    {
      name: 'keyword_snapshots',
      sql: `INSERT INTO keyword_snapshots (id, client_id, period_id, import_id, source, keyword)
            SELECT 'probe-' || hex(randomblob(4)), client_id, period_id, import_id, source, keyword FROM keyword_snapshots LIMIT 1`,
    },
    {
      name: 'issue_snapshots',
      sql: `INSERT INTO issue_snapshots (id, client_id, period_id, import_id, source, issue_name)
            SELECT 'probe-' || hex(randomblob(4)), client_id, period_id, import_id, source, issue_name FROM issue_snapshots LIMIT 1`,
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
  console.log('Migration 013 applied and verified.');
}

main().catch((err) => {
  console.error('Migration 013 failed:', err);
  process.exit(1);
});
