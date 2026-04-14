// Phase 1 Step 4c — dashboard read-path parity check.
//
// Before we rewrite the dashboard APIs to read from the snapshot tables,
// verify that the snapshot data produces the same results as the legacy
// tables for every query the dashboard currently runs.
//
// If this script reports zero diffs, the read-path cutover is safe.
// If it reports any diff, the cutover must be delayed until resolved.
//
// Run: npx tsx scripts/phase1-dashboard-parity.ts

import 'dotenv/config';
import { createClient } from '@libsql/client';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) {
  console.error('TURSO_DATABASE_URL is not set');
  process.exit(1);
}
const db = createClient({ url, authToken });

const CLIENT_ID = 'oYLqVOgsutCEPNwb7hizm'; // ZipKit — only client with data

let diffs = 0;
function diff(label: string, a: any, b: any) {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa === sb) {
    console.log(`  ${label.padEnd(40)} ✓`);
  } else {
    console.error(`  ${label.padEnd(40)} DIFF`);
    console.error(`    legacy : ${sa}`);
    console.error(`    snapshot: ${sb}`);
    diffs++;
  }
}

async function summary() {
  console.log('--- summary ---');

  // Legacy: pick latest month from metrics, return (category, key, value) rows.
  const legacyMonths = await db.execute({
    sql: 'SELECT DISTINCT month FROM metrics WHERE client_id = ? ORDER BY month DESC LIMIT 2',
    args: [CLIENT_ID],
  });
  const legacyCurrent = legacyMonths.rows[0]?.[0] as string | undefined;
  const legacyPrev = legacyMonths.rows[1]?.[0] as string | undefined;

  // Snapshot equivalent: use periods.
  const snapPeriods = await db.execute({
    sql: `SELECT p.id, p.period_start, SUBSTR(p.period_start, 1, 7) AS month_label
          FROM periods p
          WHERE p.client_id = ?
            AND EXISTS (SELECT 1 FROM metric_snapshots m WHERE m.period_id = p.id)
          ORDER BY p.period_start DESC
          LIMIT 2`,
    args: [CLIENT_ID],
  });
  const snapCurrentMonth = snapPeriods.rows[0]?.[2] as string | undefined;
  const snapPrevMonth = snapPeriods.rows[1]?.[2] as string | undefined;
  diff('latest month label', legacyCurrent, snapCurrentMonth);
  diff('prev month label', legacyPrev, snapPrevMonth);

  if (!legacyCurrent) return;

  const legacyMetrics = (
    await db.execute({
      sql: 'SELECT category, metric_key, metric_value FROM metrics WHERE client_id = ? AND month = ? ORDER BY category, metric_key',
      args: [CLIENT_ID, legacyCurrent],
    })
  ).rows.map((r) => ({ category: r[0], key: r[1], value: r[2] }));

  const snapMetrics = (
    await db.execute({
      sql: `SELECT m.category, m.metric_key, m.metric_value
            FROM metric_snapshots m
            JOIN periods p ON p.id = m.period_id
            WHERE m.client_id = ? AND SUBSTR(p.period_start, 1, 7) = ?
            ORDER BY m.category, m.metric_key`,
      args: [CLIENT_ID, legacyCurrent],
    })
  ).rows.map((r) => ({ category: r[0], key: r[1], value: r[2] }));
  diff('current month metrics set', legacyMetrics, snapMetrics);
}

async function keywords() {
  console.log('--- keywords ---');

  // Compare the full latest-month slice as a set, not as an ordered list.
  // The dashboard's ORDER BY position tiebreaker is non-deterministic
  // (internal rowid), so an ordered diff would fail on tied positions
  // even when the logical content is identical. Canonical sort by
  // (keyword ASC) for comparison.
  for (const source of ['position_tracking', 'keyword_research', 'keyword_suggestions']) {
    const legacyMonth = (
      await db.execute({
        sql: 'SELECT DISTINCT month FROM keyword_rankings WHERE client_id = ? AND source = ? ORDER BY month DESC LIMIT 1',
        args: [CLIENT_ID, source],
      })
    ).rows[0]?.[0] as string | undefined;
    if (!legacyMonth) {
      diff(`${source} latest month`, legacyMonth, null);
      continue;
    }
    const legacyRows = (
      await db.execute({
        sql: `SELECT keyword, position, search_volume, url, change_val, seo_difficulty
              FROM keyword_rankings
              WHERE client_id = ? AND month = ? AND source = ?
              ORDER BY keyword`,
        args: [CLIENT_ID, legacyMonth, source],
      })
    ).rows.map((r) => [r[0], r[1], r[2], r[3], r[4], r[5]]);

    const snapRows = (
      await db.execute({
        sql: `SELECT k.keyword, k.position, k.search_volume, k.url, k.change_val, k.seo_difficulty
              FROM keyword_snapshots k
              JOIN periods p ON p.id = k.period_id
              WHERE k.client_id = ? AND SUBSTR(p.period_start, 1, 7) = ? AND k.source = ?
              ORDER BY k.keyword`,
        args: [CLIENT_ID, legacyMonth, source],
      })
    ).rows.map((r) => [r[0], r[1], r[2], r[3], r[4], r[5]]);
    diff(`${source} full slice (${legacyRows.length} rows)`, legacyRows, snapRows);
  }
}

async function issues() {
  console.log('--- issues ---');

  const legacyMonth = (
    await db.execute({
      sql: 'SELECT DISTINCT month FROM site_issues WHERE client_id = ? ORDER BY month DESC LIMIT 1',
      args: [CLIENT_ID],
    })
  ).rows[0]?.[0] as string | undefined;

  // Legacy query collapses by issue_name (GROUP BY + MAX(affected_urls)).
  const legacyRows = (
    await db.execute({
      sql: `SELECT issue_name, MAX(affected_urls) AS affected_urls, MAX(pct_of_total) AS pct_of_total
            FROM site_issues
            WHERE client_id = ? AND month = ?
            GROUP BY issue_name
            ORDER BY affected_urls DESC, issue_name`,
      args: [CLIENT_ID, legacyMonth],
    })
  ).rows.map((r) => ({ issue_name: r[0], affected_urls: r[1], pct_of_total: r[2] }));

  // Snapshot query uses the same grouping (source stays in the table but
  // the dashboard still wants one row per issue_name regardless of source).
  const snapRows = (
    await db.execute({
      sql: `SELECT i.issue_name, MAX(i.affected_urls) AS affected_urls, MAX(i.pct_of_total) AS pct_of_total
            FROM issue_snapshots i
            JOIN periods p ON p.id = i.period_id
            WHERE i.client_id = ? AND SUBSTR(p.period_start, 1, 7) = ?
            GROUP BY i.issue_name
            ORDER BY affected_urls DESC, issue_name`,
      args: [CLIENT_ID, legacyMonth],
    })
  ).rows.map((r) => ({ issue_name: r[0], affected_urls: r[1], pct_of_total: r[2] }));
  diff('issues collapsed by issue_name', legacyRows, snapRows);
}

async function trends() {
  console.log('--- trends ---');
  const months = 6;
  const categories = ['crawl', 'health', 'accessibility'];

  for (const category of categories) {
    const legacyRows = (
      await db.execute({
        sql: `SELECT month, metric_key, metric_value
              FROM metrics
              WHERE client_id = ? AND category = ?
              ORDER BY month DESC
              LIMIT ?`,
        args: [CLIENT_ID, category, months * 20],
      })
    ).rows.map((r) => [r[0], r[1], r[2]]);

    const snapRows = (
      await db.execute({
        sql: `SELECT SUBSTR(p.period_start, 1, 7) AS month, m.metric_key, m.metric_value
              FROM metric_snapshots m
              JOIN periods p ON p.id = m.period_id
              WHERE m.client_id = ? AND m.category = ?
              ORDER BY p.period_start DESC
              LIMIT ?`,
        args: [CLIENT_ID, category, months * 20],
      })
    ).rows.map((r) => [r[0], r[1], r[2]]);

    // Row order isn't guaranteed between the two queries when many rows
    // share a month; sort both canonically for comparison.
    const canon = (rows: any[][]) =>
      [...rows].sort((a, b) => {
        const m = String(a[0]).localeCompare(String(b[0]));
        if (m !== 0) return m;
        return String(a[1]).localeCompare(String(b[1]));
      });
    diff(`trends category=${category}`, canon(legacyRows), canon(snapRows));
  }
}

async function main() {
  console.log(`=== Dashboard read parity: legacy vs snapshot ===\n`);
  console.log(`client: ${CLIENT_ID}\n`);

  await summary();
  await keywords();
  await issues();
  await trends();

  console.log();
  if (diffs > 0) {
    console.error(`PARITY FAILED — ${diffs} diff(s)`);
    process.exit(1);
  }
  console.log('PARITY OK ✓ — dashboard cutover is safe');
}

main().catch((err) => {
  console.error('Parity check error:', err);
  process.exit(1);
});
