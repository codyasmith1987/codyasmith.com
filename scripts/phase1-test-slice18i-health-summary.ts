// Slice 18i — plain-language health summary tests.
//
// Seven cases covering the new buildHealthSummary behavior:
//
//   1. Screaming Frog 4xx row becomes the top story
//   2. Ubersuggest 'Missing meta description' row becomes the top story
//   3. Duplicate issue_name across sources dedupes to one story with MAX count
//   4. Comparative 'Up from N last month' when the same issue's delta ≥ 2
//   5. No comparative when prior missing / delta < 2 / prior period absent
//   6. No-issue fallback is honest and quiet
//   7. Multi-issue integration: headline + 2 bullets + no callout
//
// Isolation: ONE fully synthetic client Z (created via direct
// INSERT INTO clients) so we never read or mutate ZipKit's real
// issue state. Two synthetic periods: 2099-11-01 = current,
// 2099-10-01 = prior. Issue rows are inserted directly into
// issue_snapshots with a tracked fake import_id per case. Every
// id is recorded and torn down in the try/finally.
//
// Run:
//   npx tsx scripts/phase1-test-slice18i-health-summary.ts

import 'dotenv/config';
import { createClient } from '@libsql/client';
import { nanoid } from 'nanoid';
import { buildHealthSummary } from '../src/lib/client-page-summary';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) {
  console.error('TURSO_DATABASE_URL is not set');
  process.exit(1);
}
const db = createClient({ url, authToken });

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error('ASSERT FAILED:', msg);
    throw new Error(msg);
  }
}
function eq<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) {
    console.error(`ASSERT FAILED: ${label}`);
    console.error(`  expected: ${JSON.stringify(expected)}`);
    console.error(`  actual:   ${JSON.stringify(actual)}`);
    throw new Error(label);
  }
}

async function findAdminUserId(): Promise<string> {
  const r = await db.execute({
    sql: `SELECT id FROM users WHERE role = 'admin' LIMIT 1`,
  });
  assert(r.rows.length > 0, 'admin user exists (needed for imports.uploaded_by FK)');
  return String(r.rows[0][0]);
}

async function main() {
  console.log('=== Slice 18i test: plain-language health summary ===');
  console.log();

  const adminId = await findAdminUserId();
  const tag = nanoid(6);
  const clientZ = nanoid();
  const clientZSlug = `slice-18i-client-${tag}`;

  // Create the fully synthetic client.
  await db.execute({
    sql: `INSERT INTO clients (id, name, slug, active) VALUES (?, ?, ?, 1)`,
    args: [clientZ, `Slice 18i Client ${tag}`, clientZSlug],
  });

  // Create two periods — current (2099-11) and prior (2099-10).
  const currentPeriodId = nanoid();
  const priorPeriodId = nanoid();
  await db.execute({
    sql: `INSERT INTO periods (id, client_id, period_type, period_start, period_end)
          VALUES (?, ?, 'month', '2099-11-01', '2099-11-30')`,
    args: [currentPeriodId, clientZ],
  });
  await db.execute({
    sql: `INSERT INTO periods (id, client_id, period_type, period_start, period_end)
          VALUES (?, ?, 'month', '2099-10-01', '2099-10-31')`,
    args: [priorPeriodId, clientZ],
  });

  // Per-test-case fake imports; all deleted in cleanup.
  const insertedImportIds: string[] = [];

  async function createFakeImport(
    periodId: string,
    source: string
  ): Promise<string> {
    const id = nanoid();
    insertedImportIds.push(id);
    await db.execute({
      sql: `INSERT INTO imports
            (id, client_id, period_id, source, original_name, content_hash, status, row_count, uploaded_by)
            VALUES (?, ?, ?, ?, ?, ?, 'applied', 0, ?)`,
      args: [
        id,
        clientZ,
        periodId,
        source,
        `slice-18i-${source}-${nanoid(4)}.csv`,
        nanoid(16),
        adminId,
      ],
    });
    return id;
  }

  async function insertIssue(args: {
    periodId: string;
    source: string;
    issue_name: string;
    priority: string;
    affected_urls: number;
  }): Promise<string> {
    const importId = await createFakeImport(args.periodId, args.source);
    const id = nanoid();
    await db.execute({
      sql: `INSERT INTO issue_snapshots
            (id, client_id, period_id, import_id, source, issue_name, issue_type, priority, affected_urls, pct_of_total, description, how_to_fix)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        clientZ,
        args.periodId,
        importId,
        args.source,
        args.issue_name,
        'test',
        args.priority,
        args.affected_urls,
        null,
        null,
        null,
      ],
    });
    return id;
  }

  async function clearIssues(periodId: string): Promise<void> {
    await db.execute({
      sql: `DELETE FROM issue_snapshots WHERE client_id = ? AND period_id = ?`,
      args: [clientZ, periodId],
    });
    await db.execute({
      sql: `DELETE FROM imports WHERE client_id = ? AND period_id = ?`,
      args: [clientZ, periodId],
    });
  }

  try {
    // -------------------------------------------------------------
    // 18i.1 — Screaming Frog 4xx becomes the top story
    // -------------------------------------------------------------
    console.log('--- 18i.1 Screaming Frog 4xx becomes the top story ---');
    await clearIssues(currentPeriodId);
    await clearIssues(priorPeriodId);
    await insertIssue({
      periodId: currentPeriodId,
      source: 'screaming_frog_response_codes',
      issue_name: 'Response Codes: Internal Client Error (4xx)',
      priority: 'critical',
      affected_urls: 5,
    });
    // Delete the prior period row temporarily so prior=null for this case.
    // Simpler: just leave prior empty. recentPeriods orders DESC by
    // period_start so the empty 2099-10 still registers as prior — but
    // with no issue rows, the comparative branch returns null naturally.

    const r1 = await buildHealthSummary(clientZ);
    assert(/5 broken links/i.test(r1.headline), `headline mentions 5 broken links: ${r1.headline}`);
    assert(/right now/i.test(r1.headline), `headline ends with "right now": ${r1.headline}`);
    eq(r1.bullets.length, 0, 'no bullets for single issue');
    eq(r1.callout, null, 'no callout when prior period empty');
    console.log('  OK');
    console.log();

    // -------------------------------------------------------------
    // 18i.2 — Ubersuggest issue becomes the top story
    // -------------------------------------------------------------
    console.log('--- 18i.2 Ubersuggest Missing meta description becomes the top story ---');
    await clearIssues(currentPeriodId);
    await clearIssues(priorPeriodId);
    await insertIssue({
      periodId: currentPeriodId,
      source: 'issues_overview',
      issue_name: 'Missing meta description',
      priority: 'high',
      affected_urls: 7,
    });
    const r2 = await buildHealthSummary(clientZ);
    assert(
      /7 pages missing a short description/i.test(r2.headline),
      `headline translates issue name to plain English: ${r2.headline}`
    );
    assert(/right now/i.test(r2.headline), `headline ends with "right now"`);
    eq(r2.bullets.length, 0, 'no bullets for single issue');
    console.log('  OK');
    console.log();

    // -------------------------------------------------------------
    // 18i.3 — Duplicate issue_name across sources dedupe (MAX count)
    // -------------------------------------------------------------
    console.log('--- 18i.3 duplicate issue_name across sources dedupes to one story ---');
    await clearIssues(currentPeriodId);
    await clearIssues(priorPeriodId);
    // Ubersuggest issues_overview: 3 broken links, high priority.
    await insertIssue({
      periodId: currentPeriodId,
      source: 'issues_overview',
      issue_name: 'Response Codes: Internal Client Error (4xx)',
      priority: 'high',
      affected_urls: 3,
    });
    // Screaming Frog response_codes: 5 broken links, critical.
    await insertIssue({
      periodId: currentPeriodId,
      source: 'screaming_frog_response_codes',
      issue_name: 'Response Codes: Internal Client Error (4xx)',
      priority: 'critical',
      affected_urls: 5,
    });
    const r3 = await buildHealthSummary(clientZ);
    // Headline uses MAX count (5).
    assert(/5 broken links/i.test(r3.headline), `headline uses MAX count: ${r3.headline}`);
    // Count of "3 broken link" appears nowhere.
    const fullText3 = [r3.headline, ...r3.bullets, r3.callout ?? ''].join(' | ');
    assert(
      !/3 broken link/i.test(fullText3),
      `3-count does not appear anywhere in summary: ${fullText3}`
    );
    // 'broken link' appears in EXACTLY one place (the headline).
    const brokenHits = (fullText3.match(/broken link/gi) ?? []).length;
    eq(brokenHits, 1, 'broken-link story referenced exactly once');
    eq(r3.bullets.length, 0, 'no duplicate second broken-link story in bullets');
    console.log('  OK');
    console.log();

    // -------------------------------------------------------------
    // 18i.4 — Comparative 'Up from 2' when same issue persists with +3 delta
    // -------------------------------------------------------------
    console.log('--- 18i.4 comparative "Up from N last month" ---');
    await clearIssues(currentPeriodId);
    await clearIssues(priorPeriodId);
    await insertIssue({
      periodId: priorPeriodId,
      source: 'screaming_frog_response_codes',
      issue_name: 'Response Codes: Internal Client Error (4xx)',
      priority: 'critical',
      affected_urls: 2,
    });
    await insertIssue({
      periodId: currentPeriodId,
      source: 'screaming_frog_response_codes',
      issue_name: 'Response Codes: Internal Client Error (4xx)',
      priority: 'critical',
      affected_urls: 5,
    });
    const r4 = await buildHealthSummary(clientZ);
    assert(/5 broken links/i.test(r4.headline), `headline has current count: ${r4.headline}`);
    assert(
      /up from 2 last month/i.test(r4.callout ?? ''),
      `callout names prior count: ${r4.callout}`
    );
    console.log('  OK');
    console.log();

    // -------------------------------------------------------------
    // 18i.5 — No comparative in the noise cases
    // -------------------------------------------------------------
    console.log('--- 18i.5 no comparative on noise cases ---');
    // 5a: prior period has a DIFFERENT issue; no match for current top.
    await clearIssues(currentPeriodId);
    await clearIssues(priorPeriodId);
    await insertIssue({
      periodId: priorPeriodId,
      source: 'issues_overview',
      issue_name: 'Missing meta description',
      priority: 'high',
      affected_urls: 8,
    });
    await insertIssue({
      periodId: currentPeriodId,
      source: 'screaming_frog_response_codes',
      issue_name: 'Response Codes: Internal Client Error (4xx)',
      priority: 'critical',
      affected_urls: 5,
    });
    const r5a = await buildHealthSummary(clientZ);
    eq(r5a.callout, null, '5a: no callout when prior has a different issue');
    assert(/5 broken links/i.test(r5a.headline), '5a: headline still from current top');

    // 5b: same issue, delta = 1 (below threshold).
    await clearIssues(currentPeriodId);
    await clearIssues(priorPeriodId);
    await insertIssue({
      periodId: priorPeriodId,
      source: 'screaming_frog_response_codes',
      issue_name: 'Response Codes: Internal Client Error (4xx)',
      priority: 'critical',
      affected_urls: 4,
    });
    await insertIssue({
      periodId: currentPeriodId,
      source: 'screaming_frog_response_codes',
      issue_name: 'Response Codes: Internal Client Error (4xx)',
      priority: 'critical',
      affected_urls: 5,
    });
    const r5b = await buildHealthSummary(clientZ);
    eq(r5b.callout, null, '5b: no callout when delta = 1 (below threshold)');
    console.log('  OK');
    console.log();

    // -------------------------------------------------------------
    // 18i.6 — No-issue fallback stays honest and quiet
    // -------------------------------------------------------------
    console.log('--- 18i.6 no-issue fallback ---');
    await clearIssues(currentPeriodId);
    await clearIssues(priorPeriodId);
    const r6 = await buildHealthSummary(clientZ);
    eq(r6.headline, 'No site problems right now.', 'no-issue headline');
    eq(r6.bullets.length, 0, 'no-issue bullets empty');
    eq(r6.callout, null, 'no-issue callout null');
    console.log('  OK');
    console.log();

    // -------------------------------------------------------------
    // 18i.integration — multi-issue state yields headline + 2 bullets
    // -------------------------------------------------------------
    console.log('--- 18i.integration multi-issue state (headline + 2 bullets) ---');
    await clearIssues(currentPeriodId);
    await clearIssues(priorPeriodId);
    await insertIssue({
      periodId: currentPeriodId,
      source: 'screaming_frog_response_codes',
      issue_name: 'Response Codes: Internal Client Error (4xx)',
      priority: 'critical',
      affected_urls: 6,
    });
    await insertIssue({
      periodId: currentPeriodId,
      source: 'issues_overview',
      issue_name: 'Missing meta description',
      priority: 'high',
      affected_urls: 4,
    });
    await insertIssue({
      periodId: currentPeriodId,
      source: 'issues_overview',
      issue_name: 'Duplicate title',
      priority: 'medium',
      affected_urls: 2,
    });
    const rI = await buildHealthSummary(clientZ);
    assert(
      /6 broken links/i.test(rI.headline),
      `integration headline critical-wins: ${rI.headline}`
    );
    eq(rI.bullets.length, 2, 'exactly 2 bullets for 3-issue state');
    assert(
      /4 pages missing a short description/i.test(rI.bullets[0]),
      `bullet[0] is the Ubersuggest high-priority: ${rI.bullets[0]}`
    );
    assert(
      /2 pages with the same page title as another/i.test(rI.bullets[1]),
      `bullet[1] is the medium-priority: ${rI.bullets[1]}`
    );
    eq(rI.callout, null, 'integration callout null (no prior rows)');

    // Shape contract sanity.
    eq(typeof rI.headline, 'string', 'headline is string');
    assert(Array.isArray(rI.bullets), 'bullets is array');
    assert(rI.callout === null || typeof rI.callout === 'string', 'callout string or null');
    console.log('  OK');
    console.log();
  } finally {
    // --- Cleanup ---
    // 1. Wipe all issue_snapshots for this synthetic client.
    await db.execute({
      sql: `DELETE FROM issue_snapshots WHERE client_id = ?`,
      args: [clientZ],
    });
    // 2. Wipe all imports for this client by tracked id + belt-and-braces client_id.
    for (const id of insertedImportIds) {
      try {
        await db.execute({ sql: 'DELETE FROM imports WHERE id = ?', args: [id] });
      } catch {}
    }
    await db.execute({
      sql: `DELETE FROM imports WHERE client_id = ?`,
      args: [clientZ],
    });
    // 3. Periods.
    await db.execute({
      sql: `DELETE FROM periods WHERE client_id = ?`,
      args: [clientZ],
    });
    // 4. Client row.
    try {
      await db.execute({
        sql: `DELETE FROM clients WHERE id = ?`,
        args: [clientZ],
      });
    } catch {}
  }

  console.log('SLICE 18I TEST PASSED ✓');
}

main().catch((err) => {
  console.error();
  console.error('SLICE 18I TEST FAILED:', err);
  process.exit(1);
});
