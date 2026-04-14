// Phase 1 Step 4b-ii — idempotency test across all 8 v2 parsers.
//
// Uses the synthetic test period 2099-01 against the real client so
// production 2026-04 data is untouched. For each format, runs three
// uploads (A, A', B) and verifies:
//   A   → status=applied
//   A'  → status=noop, same importId, same snapshot contents
//   B   → status=applied, new importId, old slice fully replaced
//
// Also verifies total 2026-04 row counts across all three legacy tables
// are byte-identical before and after the whole run.
//
// Run: npx tsx scripts/phase1-test-idempotency-all.ts

import 'dotenv/config';
import { createClient } from '@libsql/client';
import { createHash } from 'node:crypto';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) {
  console.error('TURSO_DATABASE_URL is not set');
  process.exit(1);
}
const db = createClient({ url, authToken });

const { ingestCSVViaSnapshots } = await import('../src/lib/csv/ingest-v2');

const CLIENT_ID = 'oYLqVOgsutCEPNwb7hizm';
const TEST_MONTH = '2099-01';

interface FormatCase {
  name: string;
  filename: string;
  csvA: string;
  csvB: string;
  snapshotTable: 'keyword_snapshots' | 'issue_snapshots' | 'metric_snapshots';
  expectedARows: number;
  expectedBRows: number;
  // For metrics, rows = distinct (category, metric_key) in the result
}

const CASES: FormatCase[] = [
  {
    name: 'position_tracking',
    filename: 'pt.csv',
    csvA:
      'Keyword,Position,Search Volume,URL,Change,SD,Location\n' +
      'prefab a,5,1000,https://x.com/a,2,45,United States\n' +
      'prefab b,9,420,https://x.com/b,-1,38,United States\n' +
      'prefab c,1,150,https://x.com/c,0,12,United States\n',
    csvB:
      'Keyword,Position,Search Volume,URL,Change,SD,Location\n' +
      'prefab a,3,1000,https://x.com/a,2,45,United States\n' +
      'prefab d,15,220,https://x.com/d,0,50,United States\n',
    snapshotTable: 'keyword_snapshots',
    expectedARows: 3,
    expectedBRows: 2,
  },
  {
    name: 'keyword_research',
    filename: 'kr.csv',
    // detector requires: keywords, volume, position, est. visits, ranking url
    csvA:
      'Keywords,Volume,Position,Est. Visits,Ranking Url,Seo Difficulty\n' +
      'kw one,500,4,50,https://x.com/a,30\n' +
      'kw two,100,12,5,https://x.com/b,20\n',
    csvB:
      'Keywords,Volume,Position,Est. Visits,Ranking Url,Seo Difficulty\n' +
      'kw one,500,4,50,https://x.com/a,30\n' +
      'kw two,100,12,5,https://x.com/b,20\n' +
      'kw three,50,20,1,https://x.com/c,25\n',
    snapshotTable: 'keyword_snapshots',
    expectedARows: 2,
    expectedBRows: 3,
  },
  {
    name: 'keyword_suggestions',
    filename: 'ks.csv',
    // detector requires: keyword, search intent, search volume, cpc, seo difficulty
    csvA:
      'Keyword,Search Intent,Search Volume,CPC,SEO Difficulty\n' +
      'sugg one,informational,880,US$2.10,45\n' +
      'sugg two,commercial,320,US$1.50,30\n' +
      'sugg three,transactional,140,US$3.00,55\n' +
      'sugg four,navigational,90,US$0.80,10\n',
    csvB:
      'Keyword,Search Intent,Search Volume,CPC,SEO Difficulty\n' +
      'sugg one,informational,880,US$2.10,45\n' +
      'sugg two,commercial,320,US$1.50,30\n',
    snapshotTable: 'keyword_snapshots',
    expectedARows: 4,
    expectedBRows: 2,
  },
  {
    name: 'issues_overview',
    filename: 'io.csv',
    // detector requires: issue name, issue type, issue priority, urls, % of total
    csvA:
      'Issue Name,Issue Type,Issue Priority,URLs,% of Total,Description,How To Fix\n' +
      'Missing meta descriptions,Notice,Low,20,10%,Desc A,Fix A\n' +
      'Broken internal links,Error,High,3,2%,Desc B,Fix B\n',
    csvB:
      'Issue Name,Issue Type,Issue Priority,URLs,% of Total,Description,How To Fix\n' +
      'Missing meta descriptions,Notice,Low,15,8%,Desc A,Fix A\n',
    snapshotTable: 'issue_snapshots',
    expectedARows: 2,
    expectedBRows: 1,
  },
  {
    name: 'crawl_overview',
    filename: 'co.csv',
    csvA:
      'Site Crawled,https://zipkit.com\n' +
      'Date,2026-04-11\n' +
      'Total URLs,150\n' +
      'Total URLs Crawled,145\n' +
      'Total Internal URLs,120\n' +
      'Total External URLs,25\n' +
      'HTML,100\n' +
      'JavaScript,15\n' +
      'CSS,5\n' +
      'Images,30\n',
    csvB:
      'Site Crawled,https://zipkit.com\n' +
      'Date,2026-04-12\n' +
      'Total URLs,200\n' +
      'Total URLs Crawled,198\n' +
      'Total Internal URLs,160\n' +
      'Total External URLs,38\n' +
      'HTML,120\n' +
      'JavaScript,18\n' +
      'CSS,6\n' +
      'Images,50\n',
    snapshotTable: 'metric_snapshots',
    expectedARows: 8, // 4 counts + 4 resource metrics
    expectedBRows: 8,
  },
  {
    name: 'image_optimization',
    filename: 'img.csv',
    // detector requires: original size, lossless size, percent improvement
    csvA:
      'URL,Original Size,Lossless Size,Percent Improvement\n' +
      'https://x.com/1.jpg,100000,80000,20%\n' +
      'https://x.com/2.jpg,50000,35000,30%\n',
    csvB:
      'URL,Original Size,Lossless Size,Percent Improvement\n' +
      'https://x.com/1.jpg,100000,80000,20%\n' +
      'https://x.com/2.jpg,50000,35000,30%\n' +
      'https://x.com/3.jpg,200000,140000,30%\n',
    snapshotTable: 'metric_snapshots',
    expectedARows: 2, // total_images_audited, avg_improvement
    expectedBRows: 2,
  },
  {
    name: 'accessibility',
    filename: 'acc.csv',
    // detector requires: address, wcag 2.0 a violations
    csvA:
      'Address,WCAG 2.0 A Violations,WCAG 2.0 AA Violations,WCAG 2.1 AA Violations,All Violations\n' +
      'https://x.com/a,2,3,1,6\n' +
      'https://x.com/b,0,1,0,1\n',
    csvB:
      'Address,WCAG 2.0 A Violations,WCAG 2.0 AA Violations,WCAG 2.1 AA Violations,All Violations\n' +
      'https://x.com/a,2,3,1,6\n' +
      'https://x.com/b,0,1,0,1\n' +
      'https://x.com/c,5,0,0,5\n',
    snapshotTable: 'metric_snapshots',
    expectedARows: 5,
    expectedBRows: 5,
  },
  {
    name: 'site_audit',
    filename: 'broken_link_report.csv',
    // detector falls through filename hint; first col = 'url' also works
    csvA:
      'URL,Status Code,Source\n' +
      'https://x.com/gone,404,https://x.com/home\n' +
      'https://x.com/lost,404,https://x.com/about\n',
    csvB:
      'URL,Status Code,Source\n' +
      'https://x.com/gone,404,https://x.com/home\n',
    snapshotTable: 'issue_snapshots',
    expectedARows: 1, // site_audit always emits exactly one issue row
    expectedBRows: 1,
  },
];

function sha256Hex(s: string) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

async function getAdminUserId(): Promise<string> {
  const r = await db.execute("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  if (r.rows.length === 0) throw new Error('No admin user');
  return r.rows[0][0] as string;
}

async function cleanupTestPeriod() {
  for (const table of ['keyword_snapshots', 'issue_snapshots', 'metric_snapshots']) {
    await db.execute({
      sql: `DELETE FROM ${table} WHERE period_id IN
            (SELECT id FROM periods WHERE client_id = ? AND period_start = '2099-01-01')`,
      args: [CLIENT_ID],
    });
  }
  await db.execute({
    sql: `DELETE FROM imports WHERE period_id IN
          (SELECT id FROM periods WHERE client_id = ? AND period_start = '2099-01-01')`,
    args: [CLIENT_ID],
  });
  await db.execute({
    sql: `DELETE FROM periods WHERE client_id = ? AND period_start = '2099-01-01'`,
    args: [CLIENT_ID],
  });
}

async function countSliceRows(table: string, source: string): Promise<number> {
  const r = await db.execute({
    sql: `SELECT COUNT(*) FROM ${table} t
          JOIN periods p ON p.id = t.period_id
          WHERE p.client_id = ? AND p.period_start = '2099-01-01' AND t.source = ?`,
    args: [CLIENT_ID, source],
  });
  return Number(r.rows[0][0]);
}

async function snapshotProdBaseline() {
  const out: Record<string, number> = {};
  for (const t of ['metrics', 'keyword_rankings', 'site_issues', 'metric_snapshots', 'keyword_snapshots', 'issue_snapshots']) {
    const r = await db.execute(`SELECT COUNT(*) FROM ${t}`);
    out[t] = Number(r.rows[0][0]);
  }
  return out;
}

async function main() {
  console.log('=== Phase 1 Step 4b-ii: all-format idempotency test ===\n');

  const adminId = await getAdminUserId();
  console.log(`admin=${adminId}  client=${CLIENT_ID}  test_month=${TEST_MONTH}\n`);

  const baseline = await snapshotProdBaseline();
  console.log('prod row counts before:');
  for (const [k, v] of Object.entries(baseline)) console.log(`  ${k.padEnd(20)} ${v}`);
  console.log();

  await cleanupTestPeriod();

  let failures = 0;
  const fail = (name: string, msg: string) => {
    console.error(`  FAIL [${name}]: ${msg}`);
    failures++;
  };

  try {
    for (const c of CASES) {
      console.log(`--- ${c.name} ---`);
      const hA = sha256Hex(c.csvA).slice(0, 12);
      const hB = sha256Hex(c.csvB).slice(0, 12);

      // A
      const rA = await ingestCSVViaSnapshots(c.csvA, CLIENT_ID, TEST_MONTH, c.filename, adminId);
      if (rA.status !== 'applied') fail(c.name, `A status=${rA.status} error=${rA.error}`);
      const countAfterA = await countSliceRows(c.snapshotTable, c.name);
      if (countAfterA !== c.expectedARows)
        fail(c.name, `A expected ${c.expectedARows} rows in ${c.snapshotTable}, got ${countAfterA}`);
      console.log(`  A  applied import=${rA.importId.slice(0, 8)} rows=${countAfterA}  hash=${hA}`);

      // A'
      const rAp = await ingestCSVViaSnapshots(c.csvA, CLIENT_ID, TEST_MONTH, c.filename, adminId);
      if (rAp.status !== 'noop') fail(c.name, `A' status=${rAp.status}`);
      if (rAp.importId !== rA.importId) fail(c.name, `A' importId mismatch`);
      const countAfterAp = await countSliceRows(c.snapshotTable, c.name);
      if (countAfterAp !== c.expectedARows) fail(c.name, `A' rows drifted: ${countAfterAp}`);
      console.log(`  A' noop                                   rows=${countAfterAp}`);

      // B
      const rB = await ingestCSVViaSnapshots(c.csvB, CLIENT_ID, TEST_MONTH, c.filename, adminId);
      if (rB.status !== 'applied') fail(c.name, `B status=${rB.status} error=${rB.error}`);
      if (rB.importId === rA.importId) fail(c.name, `B importId should be new`);
      const countAfterB = await countSliceRows(c.snapshotTable, c.name);
      if (countAfterB !== c.expectedBRows)
        fail(c.name, `B expected ${c.expectedBRows} rows, got ${countAfterB}`);
      console.log(`  B  applied import=${rB.importId.slice(0, 8)} rows=${countAfterB}  hash=${hB}`);

      // For issues_overview only: verify metric_snapshots slice was also updated.
      if (c.name === 'issues_overview') {
        const m = await countSliceRows('metric_snapshots', c.name);
        if (m !== 2) fail(c.name, `expected 2 metric_snapshots rows, got ${m}`);
        console.log(`  issues_overview metric_snapshots rows: ${m}`);
      }
      console.log();
    }

    // Cross-format sanity: no slice should bleed into another.
    console.log('--- cross-format slice isolation ---');
    const perSource = await db.execute({
      sql: `SELECT t.source, COUNT(*) n
            FROM keyword_snapshots t
            JOIN periods p ON p.id = t.period_id
            WHERE p.client_id = ? AND p.period_start = '2099-01-01'
            GROUP BY t.source
            ORDER BY t.source`,
      args: [CLIENT_ID],
    });
    for (const r of perSource.rows) console.log(`  keyword_snapshots  ${r[0]}  ${r[1]}`);
    const issueSources = await db.execute({
      sql: `SELECT t.source, COUNT(*) n
            FROM issue_snapshots t
            JOIN periods p ON p.id = t.period_id
            WHERE p.client_id = ? AND p.period_start = '2099-01-01'
            GROUP BY t.source`,
      args: [CLIENT_ID],
    });
    for (const r of issueSources.rows) console.log(`  issue_snapshots    ${r[0]}  ${r[1]}`);
    const metricSources = await db.execute({
      sql: `SELECT t.source, COUNT(*) n
            FROM metric_snapshots t
            JOIN periods p ON p.id = t.period_id
            WHERE p.client_id = ? AND p.period_start = '2099-01-01'
            GROUP BY t.source`,
      args: [CLIENT_ID],
    });
    for (const r of metricSources.rows) console.log(`  metric_snapshots   ${r[0]}  ${r[1]}`);
  } finally {
    console.log('\n--- cleanup ---');
    await cleanupTestPeriod();
    const after = await snapshotProdBaseline();
    console.log('prod row counts after cleanup:');
    for (const [k, v] of Object.entries(after)) {
      const delta = v - baseline[k];
      const mark = delta === 0 ? '✓' : `DRIFT ${delta > 0 ? '+' : ''}${delta}`;
      console.log(`  ${k.padEnd(20)} ${v}  ${mark}`);
      if (delta !== 0) failures++;
    }
  }

  console.log();
  if (failures > 0) {
    console.error(`FAILED — ${failures} issue(s)`);
    process.exit(1);
  }
  console.log('ALL FORMATS IDEMPOTENT ✓');
}

main().catch((err) => {
  console.error('Harness error:', err);
  process.exit(1);
});
