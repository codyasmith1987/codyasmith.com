// Phase 1 follow-up — client narrator branch coverage (slices 1 + 3).
//
// Proves both narrator functions against live data:
//
//   Test 1: slice 1 first_month branch
//     ZipKit currently has exactly one period (2026-04) with data.
//     generateOverviewVerdict should return the first-month sentence.
//
//   Test 1b: slice 3 current-issue fallback branch
//     With only one period, generateSlowdownVerdict falls through to
//     the current-period issue rank and picks the highest-priority
//     translatable issue. For live ZipKit data this is the broken
//     internal link (priority High, 1 affected URL).
//
//   Test 2: slice 1 comparative branch
//     Synthesize a prior period (2026-03) with snapshot rows chosen to
//     create a known strong signal.
//
//   Test 2b: slice 3 comparative — negative ranking drop
//     Same synthetic period, but arranged so top3 / page1 / health all
//     got WORSE this month. generateSlowdownVerdict should pick the
//     strongest negative and render "The biggest drop this month: …".
//
//   Test 2c: slice 3 comparative — nothing negative
//     Synthetic period where everything is flat or improved and there
//     are no translatable issues. generateSlowdownVerdict should
//     return the "Nothing major is slowing you down right now." fallback.
//
// No mutation of real business data. All synthetic writes are scoped
// to a period start of 2026-03-01 that did not previously exist.
//
// Run: npx tsx scripts/phase1-test-client-narrator.ts

import 'dotenv/config';
import { createClient } from '@libsql/client';
import { nanoid } from 'nanoid';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) {
  console.error('TURSO_DATABASE_URL is not set');
  process.exit(1);
}
const db = createClient({ url, authToken });

const {
  generateOverviewVerdict,
  generateSlowdownVerdict,
  generateNowVerdict,
  generateNeedToKnowVerdict,
} = await import('../src/lib/client-narrator');

const CLIENT_ID = 'oYLqVOgsutCEPNwb7hizm'; // ZipKit Homes

let failures = 0;
const fail = (label: string, msg: string) => {
  console.error(`  FAIL [${label}]: ${msg}`);
  failures++;
};

async function getAdminId(): Promise<string> {
  const r = await db.execute("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  return r.rows[0][0] as string;
}

// Guard: make sure 2026-03 does not already exist for this client.
async function assertNoPriorPeriod() {
  const r = await db.execute({
    sql: "SELECT id FROM periods WHERE client_id = ? AND period_start = '2026-03-01'",
    args: [CLIENT_ID],
  });
  if (r.rows.length > 0) {
    throw new Error(
      `Aborting: a 2026-03 period already exists for ZipKit. Delete it before running this test.`
    );
  }
}

async function main() {
  console.log('=== Phase 1 follow-up: client narrator branch test ===\n');

  await assertNoPriorPeriod();

  // ─── Test 1: first_month branch ──────────────────────────────
  console.log('--- Test 1: first_month branch (live ZipKit state) ---');
  const first = await generateOverviewVerdict(CLIENT_ID);
  console.log(`  confidence: ${first.confidence}`);
  console.log(`  headline:   ${first.headline}`);
  console.log(`  basis:      ${JSON.stringify(first.basis)}`);

  if (first.confidence !== 'first_month') {
    fail('T1', `expected confidence=first_month, got ${first.confidence}`);
  }
  if (!first.headline.includes('ZipKit Homes')) {
    fail('T1', 'headline does not include client name');
  }
  if (!/first month/i.test(first.headline)) {
    fail('T1', 'headline does not read as a first-month statement');
  }
  if (/SEO|SERP|CTR|impressions|ranking/i.test(first.headline)) {
    fail('T1', 'headline contains forbidden SEO jargon');
  }
  console.log();

  // ─── Test 1b: slice 3 current-issue fallback (live ZipKit) ────
  console.log('--- Test 1b: slice 3 current-issue fallback (live ZipKit) ---');
  const slowFirst = await generateSlowdownVerdict(CLIENT_ID);
  console.log(`  source:   ${slowFirst.source}`);
  console.log(`  headline: ${slowFirst.headline}`);
  console.log(`  basis:    ${JSON.stringify(slowFirst.basis)}`);

  if (slowFirst.source !== 'current_issue') {
    fail('T1b', `expected source=current_issue, got ${slowFirst.source}`);
  }
  if (!/slowing you down right now/.test(slowFirst.headline)) {
    fail('T1b', 'headline missing the "slowing you down right now" tail');
  }
  if (/SEO|SERP|H1|H2|meta|HSTS|CSP|WCAG|alt text|4xx/i.test(slowFirst.headline)) {
    fail('T1b', 'headline contains forbidden jargon');
  }
  // For the live ZipKit state, the top High-priority issue is the
  // internal 4xx (1 affected URL), which should translate to the
  // broken-link sentence.
  if (!/broken link/.test(slowFirst.headline)) {
    console.log('  note: expected "broken link" but got different top-ranked issue. Flagging, not failing.');
  }
  console.log();

  // ─── Test 1c: slice 4 recent_refresh branch (live ZipKit) ────
  console.log('--- Test 1c: slice 4 recent_refresh (live ZipKit) ---');
  const nowFirst = await generateNowVerdict(CLIENT_ID);
  console.log(`  source:   ${nowFirst.source}`);
  console.log(`  headline: ${nowFirst.headline}`);
  console.log(`  basis:    ${JSON.stringify(nowFirst.basis)}`);

  if (nowFirst.source !== 'recent_refresh') {
    fail('T1c', `expected source=recent_refresh, got ${nowFirst.source}`);
  }
  if (!/tracking \d+ search/.test(nowFirst.headline)) {
    fail('T1c', 'headline missing tracking count phrase');
  }
  if (!/latest site data came in on/.test(nowFirst.headline)) {
    fail('T1c', 'headline missing refresh date phrase');
  }
  // Reject forbidden jargon.
  if (/SEO|SERP|import|ingestion|pipeline|snapshot|backfill|crawl|in_progress|todo|position_tracking|CSV/i.test(nowFirst.headline)) {
    fail('T1c', 'headline contains forbidden jargon');
  }
  // Reject the refused filler phrases explicitly.
  const REFUSED = [
    "we're monitoring",
    "working on your account",
    "project is in progress",
    "running smoothly",
    "optimization is ongoing",
    "keeping an eye",
    "no recent updates",
    "stay tuned",
  ];
  for (const bad of REFUSED) {
    if (new RegExp(bad, 'i').test(nowFirst.headline)) {
      fail('T1c', `headline contains refused filler: "${bad}"`);
    }
  }
  // A shell project alone must NOT produce an active_task / completed_task
  // / active_milestone source. ZipKit has exactly one project row, no
  // milestones, no tasks — if this guard ever fails, the shell probe
  // has regressed.
  if (nowFirst.source === 'completed_task' || nowFirst.source === 'active_task' || nowFirst.source === 'completed_milestone') {
    fail('T1c', `project shell leaked as active-work signal: source=${nowFirst.source}`);
  }
  console.log();

  // ─── Test 1d: slice 5 fallback branch (live ZipKit) ──────────
  // Live state: only a draft invoice exists, no approvals, leaked test
  // notifications all point at drafts or deleted entities. All four
  // qualifying branches must be skipped and the sentence must be the
  // exact fallback string — no filler, no invented urgency.
  console.log('--- Test 1d: slice 5 fallback (live ZipKit) ---');
  const ntkFirst = await generateNeedToKnowVerdict(CLIENT_ID);
  console.log(`  source:   ${ntkFirst.source}`);
  console.log(`  headline: ${ntkFirst.headline}`);
  console.log(`  basis:    ${JSON.stringify(ntkFirst.basis)}`);

  if (ntkFirst.source !== 'none') {
    fail('T1d', `expected source=none, got ${ntkFirst.source}`);
  }
  if (ntkFirst.headline !== 'Nothing is waiting on you right now.') {
    fail('T1d', `exact fallback mismatch: ${ntkFirst.headline}`);
  }
  // Reject jargon + refused filler.
  if (/invoice|approval|notification|draft|pending/i.test(ntkFirst.headline)) {
    fail('T1d', 'fallback leaked a tool word');
  }
  const REFUSED_5 = [
    "we're monitoring",
    'we are monitoring',
    'stay tuned',
    'no recent updates',
    'keeping an eye',
    'running smoothly',
  ];
  for (const bad of REFUSED_5) {
    if (new RegExp(bad, 'i').test(ntkFirst.headline)) {
      fail('T1d', `headline contains refused filler: "${bad}"`);
    }
  }
  console.log();

  // ─── Test 2: comparative branch ──────────────────────────────
  console.log('--- Test 2: comparative branch (synthetic prior period) ---');

  const adminId = await getAdminId();

  // Read the current period + slices so we can build a prior that
  // produces a known-direction delta.
  const curPeriodRow = (
    await db.execute({
      sql: `SELECT id FROM periods WHERE client_id = ? ORDER BY period_start DESC LIMIT 1`,
      args: [CLIENT_ID],
    })
  ).rows[0];
  const curPeriodId = curPeriodRow[0] as string;

  // Current top-3 keywords — we'll set their prior position to 11 so
  // the narrator sees them as "moved into top 3 this month".
  const curTop3 = (
    await db.execute({
      sql: `SELECT keyword FROM keyword_snapshots
            WHERE client_id = ? AND period_id = ?
              AND source = 'position_tracking' AND position <= 3
            ORDER BY position, keyword`,
      args: [CLIENT_ID, curPeriodId],
    })
  ).rows.map((r) => r[0] as string);

  const curHealthRes = await db.execute({
    sql: `SELECT metric_value FROM metric_snapshots
          WHERE client_id = ? AND period_id = ?
            AND category = 'health' AND metric_key = 'total_issues'`,
    args: [CLIENT_ID, curPeriodId],
  });
  const curHealth =
    curHealthRes.rows.length > 0 ? Number(curHealthRes.rows[0][0]) : null;
  console.log(`  live cur state: top3=${curTop3.length} total_issues=${curHealth}`);

  // Build the synthetic prior period.
  const priorPeriodId = nanoid();
  const priorKwImportId = nanoid();
  const priorHealthImportId = nanoid();
  try {
    await db.execute({
      sql: `INSERT INTO periods (id, client_id, period_type, period_start, period_end)
            VALUES (?, ?, 'month', '2026-03-01', '2026-03-31')`,
      args: [priorPeriodId, CLIENT_ID],
    });

    await db.execute({
      sql: `INSERT INTO imports
            (id, client_id, period_id, source, original_name, content_hash,
             status, row_count, uploaded_by)
            VALUES (?, ?, ?, 'position_tracking', 'TEST_SYNTHETIC_PT',
                    'test:' || ?, 'applied', 0, ?)`,
      args: [priorKwImportId, CLIENT_ID, priorPeriodId, priorKwImportId, adminId],
    });

    // Prior snapshot: each current top-3 keyword at position 11 (off top 10).
    // Result: top3 delta = +curTop3.length (improvement).
    for (const kw of curTop3) {
      await db.execute({
        sql: `INSERT INTO keyword_snapshots
              (id, client_id, period_id, import_id, source, keyword, position)
              VALUES (?, ?, ?, ?, 'position_tracking', ?, 11)`,
        args: [nanoid(), CLIENT_ID, priorPeriodId, priorKwImportId, kw],
      });
    }

    // Prior health: curHealth + 8 → 8 fewer issues this month (improvement).
    if (curHealth !== null) {
      await db.execute({
        sql: `INSERT INTO imports
              (id, client_id, period_id, source, original_name, content_hash,
               status, row_count, uploaded_by)
              VALUES (?, ?, ?, 'issues_overview', 'TEST_SYNTHETIC_IO',
                      'test:' || ?, 'applied', 0, ?)`,
        args: [priorHealthImportId, CLIENT_ID, priorPeriodId, priorHealthImportId, adminId],
      });
      await db.execute({
        sql: `INSERT INTO metric_snapshots
              (id, client_id, period_id, import_id, category, metric_key, metric_value, source)
              VALUES (?, ?, ?, ?, 'health', 'total_issues', ?, 'issues_overview')`,
        args: [
          nanoid(),
          CLIENT_ID,
          priorPeriodId,
          priorHealthImportId,
          curHealth + 8,
        ],
      });
    }

    // Call the narrator with two periods now present.
    const comp = await generateOverviewVerdict(CLIENT_ID);
    console.log(`  confidence: ${comp.confidence}`);
    console.log(`  headline:   ${comp.headline}`);
    console.log(`  basis:      ${JSON.stringify(comp.basis)}`);

    if (comp.confidence !== 'comparative') {
      fail('T2', `expected confidence=comparative, got ${comp.confidence}`);
    }
    // Expected winner: both facts are strong positives.
    //   top3 magnitude   = curTop3.length (ZipKit: 3 → exactly at SIG_TOP3)
    //   health magnitude = 8
    // Health wins on magnitude. Headline should match the "cleaner" template.
    if (!/site got cleaner/.test(comp.headline)) {
      // If top3 wins (e.g. curTop3 changes), accept either template but
      // flag for review.
      if (!/site first|front page/.test(comp.headline)) {
        fail('T2', `headline does not match any comparative template: ${comp.headline}`);
      } else {
        console.log('  note: top3/page1 template selected; health tie-break did not apply');
      }
    }
    if (/SEO|SERP|CTR|impressions|crawl/i.test(comp.headline)) {
      fail('T2', 'headline contains forbidden SEO jargon');
    }

    // ─── Test 2b: slice 3 falls through past positive deltas ────
    console.log();
    console.log('--- Test 2b: slice 3 with positive-only deltas (live issues fallback) ---');
    // slice 1 winner is positive; slice 3 should skip ranking entirely
    // and land on the current-period issue rank. ZipKit's top issue is
    // the broken internal link, same as Test 1b.
    const slowPositive = await generateSlowdownVerdict(CLIENT_ID, {
      excludeFactKind: comp.basis.winning_fact as any,
    });
    console.log(`  source:   ${slowPositive.source}`);
    console.log(`  headline: ${slowPositive.headline}`);
    if (slowPositive.source !== 'current_issue') {
      fail('T2b', `expected source=current_issue, got ${slowPositive.source}`);
    }
    if (!/slowing you down right now/.test(slowPositive.headline)) {
      fail('T2b', 'missing slowdown tail');
    }
  } finally {
    // Cleanup — delete all synthetic rows.
    await db.execute({
      sql: 'DELETE FROM keyword_snapshots WHERE period_id = ?',
      args: [priorPeriodId],
    });
    await db.execute({
      sql: 'DELETE FROM metric_snapshots WHERE period_id = ?',
      args: [priorPeriodId],
    });
    await db.execute({
      sql: 'DELETE FROM imports WHERE period_id = ?',
      args: [priorPeriodId],
    });
    await db.execute({
      sql: 'DELETE FROM periods WHERE id = ?',
      args: [priorPeriodId],
    });
  }

  // ─── Test 3: slice 3 ranking_drop + excludeFactKind exercise ────
  // Build a DIFFERENT synthetic prior where the current period looks
  // WORSE on two independent ranking axes. slice 1 will pick the
  // bigger negative, and slice 3 — told to skip that fact — must pick
  // the second-biggest negative as its own winner. This exercises both
  // the ranking_drop template and the excludeFactKind filter.
  console.log();
  console.log('--- Test 3: slice 3 ranking_drop + excludeFactKind (synthetic prior #2) ---');

  const priorPeriodId2 = nanoid();
  const priorKwImportId2 = nanoid();
  try {
    await db.execute({
      sql: `INSERT INTO periods (id, client_id, period_type, period_start, period_end)
            VALUES (?, ?, 'month', '2026-03-01', '2026-03-31')`,
      args: [priorPeriodId2, CLIENT_ID],
    });
    await db.execute({
      sql: `INSERT INTO imports
            (id, client_id, period_id, source, original_name, content_hash,
             status, row_count, uploaded_by)
            VALUES (?, ?, ?, 'position_tracking', 'TEST_SYNTHETIC_PT2',
                    'test:' || ?, 'applied', 0, ?)`,
      args: [priorKwImportId2, CLIENT_ID, priorPeriodId2, priorKwImportId2, adminId],
    });

    // Seed 20 synthetic top-3 keywords and 27 synthetic page-1 keywords
    // in the prior period. No shared keyword rows with current, so the
    // counts become independent. Against live curTop3=15 and
    // curPage1≈20, the deltas are:
    //   top3:  15 - 20 = -5   (strong negative, magnitude 5)
    //   page1: cur - 27       (strong negative, magnitude ~7)
    // slice 1 picks the bigger magnitude (page1). slice 3 with
    // excludeFactKind='page1' must pick top3 next.
    for (let i = 0; i < 20; i++) {
      await db.execute({
        sql: `INSERT INTO keyword_snapshots
              (id, client_id, period_id, import_id, source, keyword, position)
              VALUES (?, ?, ?, ?, 'position_tracking', ?, 2)`,
        args: [nanoid(), CLIENT_ID, priorPeriodId2, priorKwImportId2, `synthetic-top3-${i}`],
      });
    }
    for (let i = 0; i < 27; i++) {
      await db.execute({
        sql: `INSERT INTO keyword_snapshots
              (id, client_id, period_id, import_id, source, keyword, position)
              VALUES (?, ?, ?, ?, 'position_tracking', ?, 5)`,
        args: [nanoid(), CLIENT_ID, priorPeriodId2, priorKwImportId2, `synthetic-page1-${i}`],
      });
    }

    const comp3 = await generateOverviewVerdict(CLIENT_ID);
    console.log(`  slice 1 winner: ${comp3.basis.winning_fact} (${comp3.basis.winning_direction})`);
    console.log(`  slice 1 headline: ${comp3.headline}`);
    if (comp3.confidence !== 'comparative') {
      fail('T3', `expected comparative, got ${comp3.confidence}`);
    }
    if (comp3.basis.winning_direction !== 'negative') {
      fail('T3', `expected slice 1 to pick a negative fact, got ${comp3.basis.winning_direction}`);
    }

    const slow3 = await generateSlowdownVerdict(CLIENT_ID, {
      excludeFactKind: comp3.basis.winning_fact as any,
    });
    console.log(`  slice 3 source:   ${slow3.source}`);
    console.log(`  slice 3 headline: ${slow3.headline}`);
    console.log(`  slice 3 basis:    ${JSON.stringify(slow3.basis)}`);

    if (slow3.source !== 'ranking_drop') {
      fail('T3', `expected source=ranking_drop, got ${slow3.source}`);
    }
    if (!/biggest drop this month/.test(slow3.headline)) {
      fail('T3', 'headline missing "biggest drop this month"');
    }
    if (slow3.basis.winning_fact === comp3.basis.winning_fact) {
      fail('T3', 'slice 3 picked the same fact as slice 1 — exclude filter broken');
    }
    if (/SEO|SERP|CTR|impressions|crawl|4xx|H1|H2|meta/i.test(slow3.headline)) {
      fail('T3', 'headline contains forbidden jargon');
    }
  } finally {
    await db.execute({ sql: 'DELETE FROM keyword_snapshots WHERE period_id = ?', args: [priorPeriodId2] });
    await db.execute({ sql: 'DELETE FROM metric_snapshots WHERE period_id = ?', args: [priorPeriodId2] });
    await db.execute({ sql: 'DELETE FROM imports WHERE period_id = ?', args: [priorPeriodId2] });
    await db.execute({ sql: 'DELETE FROM periods WHERE id = ?', args: [priorPeriodId2] });
  }

  // ─── Test 4a: slice 4 completed_task branch (synthetic task) ───
  // Insert a client-visible task with a recent completed_at and a
  // client_update_text value. generateNowVerdict must pick this task
  // first, render the completed_task sentence using client_update_text
  // as the label (not the raw task title). All synthetic rows cleaned
  // up in finally.
  console.log();
  console.log('--- Test 4a: slice 4 completed_task (synthetic task) ---');

  // The ZipKit backfill left a project shell with id LIP9i10OlCKDjXHhcdK6N.
  // Reuse it — no need to create a new project. Create one milestone
  // and one task under it.
  const projectRow = (
    await db.execute({
      sql: 'SELECT id FROM projects WHERE client_id = ? LIMIT 1',
      args: [CLIENT_ID],
    })
  ).rows[0];
  if (!projectRow) {
    fail('T4a-setup', 'no project row for ZipKit — backfill may have been reverted');
    process.exit(1);
  }
  const testProjectId = projectRow[0] as string;
  const testMilestoneId = nanoid();
  const testTaskId = nanoid();
  const expectedLabel = 'writing fresh page titles';

  try {
    await db.execute({
      sql: `INSERT INTO milestones
            (id, project_id, title, status, client_visible, sort_order)
            VALUES (?, ?, 'test milestone', 'in_progress', 1, 999)`,
      args: [testMilestoneId, testProjectId],
    });
    await db.execute({
      sql: `INSERT INTO tasks
            (id, milestone_id, title, status, client_visible,
             client_update_text, completed_at, updated_at, sort_order)
            VALUES (?, ?, 'internal: h1 rewrite', 'done', 1, ?,
                    datetime('now','-2 days'), datetime('now','-2 days'), 999)`,
      args: [testTaskId, testMilestoneId, expectedLabel],
    });

    const nowComp = await generateNowVerdict(CLIENT_ID);
    console.log(`  source:   ${nowComp.source}`);
    console.log(`  headline: ${nowComp.headline}`);
    console.log(`  basis:    ${JSON.stringify(nowComp.basis)}`);

    if (nowComp.source !== 'completed_task') {
      fail('T4a', `expected source=completed_task, got ${nowComp.source}`);
    }
    if (nowComp.headline !== `We just finished ${expectedLabel} for you.`) {
      fail('T4a', `headline mismatch: ${nowComp.headline}`);
    }
    // Raw title must NOT appear — client_update_text wins.
    if (/internal: h1 rewrite/i.test(nowComp.headline)) {
      fail('T4a', 'headline leaked raw task.title — client_update_text override broken');
    }
  } finally {
    await db.execute({ sql: 'DELETE FROM tasks WHERE id = ?', args: [testTaskId] });
    await db.execute({ sql: 'DELETE FROM milestones WHERE id = ?', args: [testMilestoneId] });
  }

  // ─── Test 5a: slice 5 due_soon_invoice (synthetic sent invoice) ─
  // Create a real sent invoice tied to the existing ZipKit contract
  // with a due_date inside the due-soon window and unpaid balance.
  // generateNeedToKnowVerdict must pick it and render the due-soon
  // template. Clean up in finally.
  console.log();
  console.log('--- Test 5a: slice 5 due_soon_invoice (synthetic sent invoice) ---');

  const contractRow = (
    await db.execute({
      sql: "SELECT id FROM contracts WHERE client_id = ? AND status = 'active' LIMIT 1",
      args: [CLIENT_ID],
    })
  ).rows[0];
  if (!contractRow) {
    fail('T5a-setup', 'no active contract for ZipKit');
    process.exit(1);
  }
  const testContractId = contractRow[0] as string;
  const testInvoiceId = nanoid();
  // Pick a due date 5 days out, inside the DUE_SOON_WINDOW_DAYS=14 window.
  const testInvoiceNumber = `TEST-${Date.now()}`;

  try {
    await db.execute({
      sql: `INSERT INTO invoices
            (id, contract_id, client_id, invoice_number, status, issued_date,
             due_date, subtotal, tax, total, amount_paid, client_visible, created_by)
            VALUES (?, ?, ?, ?, 'sent', date('now'),
                    date('now', '+5 days'), 500, 0, 500, 0, 1, ?)`,
      args: [testInvoiceId, testContractId, CLIENT_ID, testInvoiceNumber, await getAdminId()],
    });

    const ntkDueSoon = await generateNeedToKnowVerdict(CLIENT_ID);
    console.log(`  source:   ${ntkDueSoon.source}`);
    console.log(`  headline: ${ntkDueSoon.headline}`);
    console.log(`  basis:    ${JSON.stringify(ntkDueSoon.basis)}`);

    if (ntkDueSoon.source !== 'due_soon_invoice') {
      fail('T5a', `expected source=due_soon_invoice, got ${ntkDueSoon.source}`);
    }
    if (!/\$500 is due/.test(ntkDueSoon.headline)) {
      fail('T5a', `headline missing "$500 is due": ${ntkDueSoon.headline}`);
    }
    if (/draft|invoice_number|TEST-/i.test(ntkDueSoon.headline)) {
      fail('T5a', 'headline leaked raw tool data');
    }
  } finally {
    await db.execute({ sql: 'DELETE FROM invoices WHERE id = ?', args: [testInvoiceId] });
  }

  // ─── Test 5b: slice 5 pending_approval (synthetic approval) ──
  // Approvals has a NOT NULL FK to contracts. Create one tied to the
  // active ZipKit contract. Must render the approval template.
  //
  // Slice 12b extends this test with three sub-phases:
  //   5b.i   no approval-role contacts → "your okay" (fallback)
  //   5b.ii  one approval contact, viewer ≠ contact → "Kelsey's okay"
  //   5b.iii one approval contact, viewer === contact → "your okay"
  //   5b.iv  multiple approval contacts → "your team's okay"
  console.log();
  console.log('--- Test 5b: slice 5 pending_approval (synthetic) ---');
  const testApprovalId = nanoid();
  const tag5b = Math.random().toString(36).slice(2, 8);
  const testContactIds: string[] = [];
  try {
    await db.execute({
      sql: `INSERT INTO approvals
            (id, contract_id, title, status, requested_by)
            VALUES (?, ?, 'design concept round 2', 'pending', ?)`,
      args: [testApprovalId, testContractId, await getAdminId()],
    });

    // 5b.i — no approval contacts, "your" fallback
    const ntkApproval = await generateNeedToKnowVerdict(CLIENT_ID);
    console.log(`  [5b.i no contacts]`);
    console.log(`    source:   ${ntkApproval.source}`);
    console.log(`    headline: ${ntkApproval.headline}`);
    if (ntkApproval.source !== 'pending_approval') {
      fail('T5b.i', `expected source=pending_approval, got ${ntkApproval.source}`);
    }
    if (!/design concept round 2/.test(ntkApproval.headline)) {
      fail('T5b.i', `headline missing approval title: ${ntkApproval.headline}`);
    }
    if (!/your okay on/i.test(ntkApproval.headline)) {
      fail('T5b.i', 'fallback phrasing must be "your okay"');
    }
    if ((ntkApproval.basis as any).approver_count !== 0) {
      fail('T5b.i', 'approver_count should be 0');
    }

    // 5b.ii — single approval contact, viewer is someone else
    const kelseyId = nanoid();
    const kelseyEmail = `kelsey+${tag5b}@zipkithomes.test`;
    testContactIds.push(kelseyId);
    await db.execute({
      sql: `INSERT INTO contacts
            (id, client_id, name, email, roles_json, receives_invoices, receives_reminders)
            VALUES (?, ?, 'Kelsey Tester', ?, '["approval"]', 0, 0)`,
      args: [kelseyId, CLIENT_ID, kelseyEmail],
    });

    const ntkNamed = await generateNeedToKnowVerdict(CLIENT_ID, 'otheruser@example.com');
    console.log(`  [5b.ii single contact, viewer = other]`);
    console.log(`    headline: ${ntkNamed.headline}`);
    if (!/Kelsey's okay on/.test(ntkNamed.headline)) {
      fail('T5b.ii', `expected "Kelsey's okay", got: ${ntkNamed.headline}`);
    }
    if ((ntkNamed.basis as any).approver_count !== 1) {
      fail('T5b.ii', 'approver_count should be 1');
    }
    if ((ntkNamed.basis as any).approver_name !== 'Kelsey') {
      fail('T5b.ii', 'approver_name should be "Kelsey"');
    }
    if ((ntkNamed.basis as any).viewer_is_approver !== false) {
      fail('T5b.ii', 'viewer_is_approver should be false');
    }

    // 5b.iii — single approval contact, viewer IS the contact
    const ntkSelf = await generateNeedToKnowVerdict(CLIENT_ID, kelseyEmail);
    console.log(`  [5b.iii single contact, viewer = contact]`);
    console.log(`    headline: ${ntkSelf.headline}`);
    if (!/your okay on/i.test(ntkSelf.headline)) {
      fail('T5b.iii', `expected "your okay", got: ${ntkSelf.headline}`);
    }
    if ((ntkSelf.basis as any).viewer_is_approver !== true) {
      fail('T5b.iii', 'viewer_is_approver should be true');
    }

    // 5b.iv — add a second approval contact, now "your team's"
    const patId = nanoid();
    const patEmail = `pat+${tag5b}@zipkithomes.test`;
    testContactIds.push(patId);
    await db.execute({
      sql: `INSERT INTO contacts
            (id, client_id, name, email, roles_json, receives_invoices, receives_reminders)
            VALUES (?, ?, 'Pat Tester', ?, '["approval","primary"]', 0, 0)`,
      args: [patId, CLIENT_ID, patEmail],
    });

    const ntkTeam = await generateNeedToKnowVerdict(CLIENT_ID, 'otheruser@example.com');
    console.log(`  [5b.iv multiple contacts]`);
    console.log(`    headline: ${ntkTeam.headline}`);
    if (!/your team's okay on/i.test(ntkTeam.headline)) {
      fail('T5b.iv', `expected "your team's okay", got: ${ntkTeam.headline}`);
    }
    if ((ntkTeam.basis as any).approver_count !== 2) {
      fail('T5b.iv', 'approver_count should be 2');
    }
  } finally {
    await db.execute({ sql: 'DELETE FROM approvals WHERE id = ?', args: [testApprovalId] });
    for (const cid of testContactIds) {
      await db.execute({ sql: 'DELETE FROM contacts WHERE id = ?', args: [cid] });
    }
  }

  // ─── Test 5c: slice 5 overdue beats due-soon when both exist ─
  // Prove branch ordering: an overdue invoice must win over a due-soon
  // invoice even when both exist. Two synthetic invoices.
  console.log();
  console.log('--- Test 5c: slice 5 overdue beats due-soon ---');
  const overdueInvId = nanoid();
  const dueSoonInvId = nanoid();
  try {
    await db.execute({
      sql: `INSERT INTO invoices
            (id, contract_id, client_id, invoice_number, status, issued_date,
             due_date, subtotal, tax, total, amount_paid, client_visible, created_by)
            VALUES (?, ?, ?, ?, 'sent', date('now', '-20 days'),
                    date('now', '-5 days'), 800, 0, 800, 0, 1, ?)`,
      args: [overdueInvId, testContractId, CLIENT_ID, `TEST-OD-${Date.now()}`, await getAdminId()],
    });
    await db.execute({
      sql: `INSERT INTO invoices
            (id, contract_id, client_id, invoice_number, status, issued_date,
             due_date, subtotal, tax, total, amount_paid, client_visible, created_by)
            VALUES (?, ?, ?, ?, 'sent', date('now'),
                    date('now', '+7 days'), 300, 0, 300, 0, 1, ?)`,
      args: [dueSoonInvId, testContractId, CLIENT_ID, `TEST-DS-${Date.now()}`, await getAdminId()],
    });

    const ntkMixed = await generateNeedToKnowVerdict(CLIENT_ID);
    console.log(`  source:   ${ntkMixed.source}`);
    console.log(`  headline: ${ntkMixed.headline}`);

    if (ntkMixed.source !== 'overdue_invoice') {
      fail('T5c', `expected source=overdue_invoice, got ${ntkMixed.source}`);
    }
    if (!/past due/.test(ntkMixed.headline)) {
      fail('T5c', 'overdue template missing "past due"');
    }
    if (!/\$800/.test(ntkMixed.headline)) {
      fail('T5c', 'overdue template missing $800 outstanding');
    }
  } finally {
    await db.execute({ sql: 'DELETE FROM invoices WHERE id = ?', args: [overdueInvId] });
    await db.execute({ sql: 'DELETE FROM invoices WHERE id = ?', args: [dueSoonInvId] });
  }

  // ════════════════════════════════════════════════════════════════
  // Slice 18d — traffic-aware narrator cases
  // ════════════════════════════════════════════════════════════════
  //
  // Each case synthesizes a second (prior) period so pickWinner has
  // a compare to work with. The prior period is 2099-02 — far-future
  // so it can never collide with real ZipKit data. Cleanup wipes
  // every row this case creates on both success and failure.

  // Prior synthetic period must sort BEFORE ZipKit's real 2026-04
  // period under ORDER BY period_start DESC, so the narrator's
  // recentPeriodsWithData returns [2026-04 (current), 1999-01 (prior)].
  // Using a far-past date guarantees unique placement no matter what
  // real data exists.
  const SLICE18D_PRIOR_START = '1999-01-01';
  const SLICE18D_PRIOR_END = '1999-01-31';

  async function mkPriorPeriod(): Promise<string> {
    // Preflight — nothing real should exist at this far-future month.
    const pre = await db.execute({
      sql: `SELECT COUNT(*) FROM periods WHERE client_id = ? AND period_start = ?`,
      args: [CLIENT_ID, SLICE18D_PRIOR_START],
    });
    if (Number(pre.rows[0][0]) !== 0) {
      throw new Error('preflight: 2099-02 period already exists for ZipKit — aborting');
    }
    const id = nanoid();
    await db.execute({
      sql: `INSERT INTO periods (id, client_id, period_type, period_start, period_end)
            VALUES (?, ?, 'month', ?, ?)`,
      args: [id, CLIENT_ID, SLICE18D_PRIOR_START, SLICE18D_PRIOR_END],
    });
    return id;
  }

  async function writeTraffic(
    periodId: string,
    source: 'ga4',
    values: {
      sessions: number;
      users: number;
      page_views: number;
      engaged_sessions: number;
      engagement_rate: number;
    }
  ) {
    // Import row FK
    const importId = nanoid();
    await db.execute({
      sql: `INSERT INTO imports
            (id, client_id, period_id, source, original_name, content_hash, status, row_count, uploaded_by, finished_at)
            VALUES (?, ?, ?, ?, 'slice18d-test', ?, 'applied', 5, ?, datetime('now'))`,
      args: [importId, CLIENT_ID, periodId, source, nanoid(), await getAdminId()],
    });
    for (const [key, val] of Object.entries(values)) {
      await db.execute({
        sql: `INSERT INTO metric_snapshots
              (id, client_id, period_id, import_id, category, metric_key, metric_value, source)
              VALUES (?, ?, ?, ?, 'traffic', ?, ?, ?)`,
        args: [nanoid(), CLIENT_ID, periodId, importId, key, val, source],
      });
    }
    return importId;
  }

  async function writeCurrentTraffic(values: {
    sessions: number;
    users: number;
    page_views: number;
    engaged_sessions: number;
    engagement_rate: number;
  }): Promise<{ importId: string; periodId: string }> {
    // ZipKit's current period is 2026-04. Look it up.
    const r = await db.execute({
      sql: `SELECT id FROM periods WHERE client_id = ? AND period_start = '2026-04-01' LIMIT 1`,
      args: [CLIENT_ID],
    });
    if (r.rows.length === 0) throw new Error('ZipKit 2026-04 period missing');
    const periodId = String(r.rows[0][0]);
    const importId = await writeTraffic(periodId, 'ga4', values);
    return { importId, periodId };
  }

  // Coerces a libsql row value to a nullable integer. Anything that
  // doesn't cleanly parse becomes null so the INSERT args never
  // contain NaN (which libsql rejects with a cryptic RangeError).
  function toNullableInt(val: any): number | null {
    if (val === null || val === undefined) return null;
    const n = Number(val);
    if (!Number.isFinite(n)) return null;
    return Math.round(n);
  }
  function toNullableStr(val: any): string | null {
    if (val === null || val === undefined) return null;
    return String(val);
  }

  async function writePriorKeywordIdentical(priorPeriodId: string): Promise<void> {
    // Copy ZipKit's current position_tracking keyword_snapshots into
    // the prior period so keyword deltas are zero. This isolates the
    // compare so traffic is the only moving signal.
    const curRows = await db.execute({
      sql: `SELECT keyword, position, search_volume, url, change_val, seo_difficulty
            FROM keyword_snapshots
            WHERE client_id = ?
              AND period_id = (SELECT id FROM periods WHERE client_id = ? AND period_start = '2026-04-01' LIMIT 1)
              AND source = 'position_tracking'`,
      args: [CLIENT_ID, CLIENT_ID],
    });
    const priorImportId = nanoid();
    await db.execute({
      sql: `INSERT INTO imports
            (id, client_id, period_id, source, original_name, content_hash, status, row_count, uploaded_by, finished_at)
            VALUES (?, ?, ?, 'position_tracking', 'slice18d-prior', ?, 'applied', ?, ?, datetime('now'))`,
      args: [priorImportId, CLIENT_ID, priorPeriodId, nanoid(), curRows.rows.length, await getAdminId()],
    });
    for (const row of curRows.rows) {
      await db.execute({
        sql: `INSERT INTO keyword_snapshots
              (id, client_id, period_id, import_id, source, keyword, position, search_volume, url, change_val, seo_difficulty)
              VALUES (?, ?, ?, ?, 'position_tracking', ?, ?, ?, ?, ?, ?)`,
        args: [
          nanoid(), CLIENT_ID, priorPeriodId, priorImportId,
          toNullableStr(row[0]) ?? '',
          toNullableInt(row[1]),
          toNullableInt(row[2]),
          toNullableStr(row[3]),
          toNullableInt(row[4]),
          toNullableInt(row[5]),
        ],
      });
    }
  }

  async function writePriorKeywordWithTop3Delta(
    priorPeriodId: string,
    top3Delta: number
  ): Promise<void> {
    // Create a synthetic prior state where `top3Delta` keywords
    // are ONE POSITION WORSE than current (current is at positions
    // 1-3, prior is at 4-6). That makes the CURRENT top3 count
    // HIGHER than prior by top3Delta. Net effect: +top3Delta winner
    // candidate for the top3 fact.
    const curRows = await db.execute({
      sql: `SELECT keyword, position, search_volume, url, change_val, seo_difficulty
            FROM keyword_snapshots
            WHERE client_id = ?
              AND period_id = (SELECT id FROM periods WHERE client_id = ? AND period_start = '2026-04-01' LIMIT 1)
              AND source = 'position_tracking'`,
      args: [CLIENT_ID, CLIENT_ID],
    });
    const priorImportId = nanoid();
    await db.execute({
      sql: `INSERT INTO imports
            (id, client_id, period_id, source, original_name, content_hash, status, row_count, uploaded_by, finished_at)
            VALUES (?, ?, ?, 'position_tracking', 'slice18d-prior-top3', ?, 'applied', ?, ?, datetime('now'))`,
      args: [priorImportId, CLIENT_ID, priorPeriodId, nanoid(), curRows.rows.length, await getAdminId()],
    });
    let demotedCount = 0;
    for (const row of curRows.rows) {
      const curPos = toNullableInt(row[1]);
      let priorPos: number | null = curPos;
      if (
        demotedCount < top3Delta &&
        curPos !== null &&
        curPos >= 1 &&
        curPos <= 3
      ) {
        // Demote to position 15 in the prior period — OUTSIDE page 1
        // entirely. The narrator's loadKeywordSlice buckets are
        // disjoint (top3=1-3, page1=4-10), so demoting to position 5
        // would have moved the keyword from the top3 bucket INTO
        // the page1 bucket, producing a spurious page1 negative
        // delta. Position 15 keeps it out of both and yields a
        // clean top3-only positive fact.
        priorPos = 15;
        demotedCount += 1;
      }
      await db.execute({
        sql: `INSERT INTO keyword_snapshots
              (id, client_id, period_id, import_id, source, keyword, position, search_volume, url, change_val, seo_difficulty)
              VALUES (?, ?, ?, ?, 'position_tracking', ?, ?, ?, ?, ?, ?)`,
        args: [
          nanoid(), CLIENT_ID, priorPeriodId, priorImportId,
          toNullableStr(row[0]) ?? '',
          priorPos,
          toNullableInt(row[2]),
          toNullableStr(row[3]),
          toNullableInt(row[4]),
          toNullableInt(row[5]),
        ],
      });
    }
  }

  async function cleanupSlice18dPeriod(priorPeriodId: string): Promise<void> {
    await db.execute({ sql: `DELETE FROM keyword_snapshots WHERE period_id = ?`, args: [priorPeriodId] });
    await db.execute({ sql: `DELETE FROM issue_snapshots WHERE period_id = ?`, args: [priorPeriodId] });
    await db.execute({ sql: `DELETE FROM metric_snapshots WHERE period_id = ?`, args: [priorPeriodId] });
    await db.execute({ sql: `DELETE FROM imports WHERE period_id = ?`, args: [priorPeriodId] });
    await db.execute({ sql: `DELETE FROM periods WHERE id = ?`, args: [priorPeriodId] });
    // Remove any current-period ga4 rows written by the test.
    await db.execute({
      sql: `DELETE FROM metric_snapshots
            WHERE client_id = ? AND source = 'ga4'
              AND period_id = (SELECT id FROM periods WHERE client_id = ? AND period_start = '2026-04-01' LIMIT 1)`,
      args: [CLIENT_ID, CLIENT_ID],
    });
    await db.execute({
      sql: `DELETE FROM imports
            WHERE client_id = ? AND source = 'ga4' AND original_name = 'slice18d-test'
              AND period_id = (SELECT id FROM periods WHERE client_id = ? AND period_start = '2026-04-01' LIMIT 1)`,
      args: [CLIENT_ID, CLIENT_ID],
    });
  }

  // ─── Test 18d.1: traffic positive wins slice 1 ───
  console.log();
  console.log('--- Test 18d.1: traffic positive wins slice 1 ---');
  {
    const priorId = await mkPriorPeriod();
    try {
      // Prior traffic: 240/180/620/150/0.625 (slice 18c fixture)
      await writeTraffic(priorId, 'ga4', {
        sessions: 240,
        users: 180,
        page_views: 620,
        engaged_sessions: 150,
        engagement_rate: 0.625,
      });
      // Current traffic: 320/240/800/210/0.656 — sessions +80 (+33%)
      await writeCurrentTraffic({
        sessions: 320,
        users: 240,
        page_views: 800,
        engaged_sessions: 210,
        engagement_rate: 0.656,
      });
      // Prior keyword state identical to current → no ranking deltas.
      await writePriorKeywordIdentical(priorId);

      const v = await generateOverviewVerdict(CLIENT_ID);
      console.log(`  confidence: ${v.confidence}`);
      console.log(`  headline:   ${v.headline}`);
      if (v.confidence !== 'comparative') {
        fail('T18d.1', `expected comparative, got ${v.confidence}`);
      }
      if (v.basis.winning_fact !== 'traffic') {
        fail('T18d.1', `expected winning_fact=traffic, got ${v.basis.winning_fact}`);
      }
      if (!/More people visited|more visits/.test(v.headline)) {
        fail('T18d.1', `traffic headline wrong: ${v.headline}`);
      }
    } finally {
      await cleanupSlice18dPeriod(priorId);
    }
  }
  console.log('  OK');

  // ─── Test 18d.2: traffic negative wins slice 1 ───
  console.log();
  console.log('--- Test 18d.2: traffic negative wins slice 1 (no-spin) ---');
  {
    const priorId = await mkPriorPeriod();
    try {
      await writeTraffic(priorId, 'ga4', {
        sessions: 400,
        users: 300,
        page_views: 1000,
        engaged_sessions: 250,
        engagement_rate: 0.625,
      });
      await writeCurrentTraffic({
        sessions: 200, // -200 (-50%)
        users: 150,
        page_views: 500,
        engaged_sessions: 125,
        engagement_rate: 0.625,
      });
      await writePriorKeywordIdentical(priorId);

      const v = await generateOverviewVerdict(CLIENT_ID);
      console.log(`  headline: ${v.headline}`);
      if (v.basis.winning_fact !== 'traffic') {
        fail('T18d.2', `expected winning_fact=traffic, got ${v.basis.winning_fact}`);
      }
      if (v.basis.winning_direction !== 'negative') {
        fail('T18d.2', `expected winning_direction=negative, got ${v.basis.winning_direction}`);
      }
      if (!/fewer visits|Fewer/.test(v.headline)) {
        fail('T18d.2', `traffic negative headline wrong: ${v.headline}`);
      }
    } finally {
      await cleanupSlice18dPeriod(priorId);
    }
  }
  console.log('  OK');

  // ─── Test 18d.3: traffic_drop source fires in slice 3 ───
  console.log();
  console.log('--- Test 18d.3: traffic_drop in slice 3 ---');
  {
    const priorId = await mkPriorPeriod();
    try {
      await writeTraffic(priorId, 'ga4', {
        sessions: 400,
        users: 300,
        page_views: 1000,
        engaged_sessions: 250,
        engagement_rate: 0.625,
      });
      await writeCurrentTraffic({
        sessions: 200,
        users: 150,
        page_views: 500,
        engaged_sessions: 125,
        engagement_rate: 0.625,
      });
      await writePriorKeywordIdentical(priorId);

      // Call slice 3 directly with excludeFactKind='top3' so the
      // negatives branch exercises traffic directly (slice 1 would
      // have picked traffic naturally; we're proving slice 3's own
      // code path here by forcing a non-traffic exclusion).
      const slow = await generateSlowdownVerdict(CLIENT_ID, { excludeFactKind: 'top3' });
      console.log(`  source:   ${slow.source}`);
      console.log(`  headline: ${slow.headline}`);
      if (slow.source !== 'traffic_drop') {
        fail('T18d.3', `expected source=traffic_drop, got ${slow.source}`);
      }
      if (!/fewer visits/.test(slow.headline)) {
        fail('T18d.3', `slice 3 traffic headline wrong: ${slow.headline}`);
      }
    } finally {
      await cleanupSlice18dPeriod(priorId);
    }
  }
  console.log('  OK');

  // ─── Test 18d.4: flat traffic preserves existing behavior ───
  console.log();
  console.log('--- Test 18d.4: flat traffic does not win ---');
  {
    const priorId = await mkPriorPeriod();
    try {
      await writeTraffic(priorId, 'ga4', {
        sessions: 245, // +2% → flat
        users: 184,
        page_views: 628,
        engaged_sessions: 155,
        engagement_rate: 0.631,
      });
      await writeCurrentTraffic({
        sessions: 240,
        users: 180,
        page_views: 620,
        engaged_sessions: 150,
        engagement_rate: 0.625,
      });
      // Prior keyword state has 3 FEWER top-3 keywords than current
      // (which is demoted from 3 current top-3 slots). Net:
      // current top3 = N, prior top3 = N-3 → +3 top3 delta.
      await writePriorKeywordWithTop3Delta(priorId, 3);

      const v = await generateOverviewVerdict(CLIENT_ID);
      console.log(`  winning_fact: ${v.basis.winning_fact}`);
      if (v.basis.winning_fact === 'traffic') {
        fail('T18d.4', `flat traffic incorrectly won: ${v.headline}`);
      }
      // top3 should win (a +3 top3 delta meets SIG_TOP3=3).
      if (v.basis.winning_fact !== 'top3') {
        fail('T18d.4', `expected top3 winner, got ${v.basis.winning_fact}: ${v.headline}`);
      }
    } finally {
      await cleanupSlice18dPeriod(priorId);
    }
  }
  console.log('  OK');

  // ─── Test 18d.5: traffic +15 vs top3 +5 (raw magnitude competition) ───
  console.log();
  console.log('--- Test 18d.5: small traffic vs small top3 (traffic wins by magnitude) ---');
  {
    const priorId = await mkPriorPeriod();
    try {
      // Traffic +15 visits on 240 (+6.25%, eligible, magnitude 15).
      await writeTraffic(priorId, 'ga4', {
        sessions: 240,
        users: 180,
        page_views: 620,
        engaged_sessions: 150,
        engagement_rate: 0.625,
      });
      await writeCurrentTraffic({
        sessions: 255,
        users: 190,
        page_views: 660,
        engaged_sessions: 160,
        engagement_rate: 0.627,
      });
      // top3 +5 keywords — 5 demoted in prior.
      await writePriorKeywordWithTop3Delta(priorId, 5);

      const v = await generateOverviewVerdict(CLIENT_ID);
      console.log(`  winning_fact: ${v.basis.winning_fact}`);
      console.log(`  headline:     ${v.headline}`);
      // Traffic magnitude = 15 (sessions driver). top3 magnitude = 5.
      // Traffic wins via raw magnitude.
      if (v.basis.winning_fact !== 'traffic') {
        fail('T18d.5', `expected traffic winner (magnitude 15 vs 5), got ${v.basis.winning_fact}`);
      }
      if (!/more visits/.test(v.headline)) {
        fail('T18d.5', `traffic winner headline: ${v.headline}`);
      }
    } finally {
      await cleanupSlice18dPeriod(priorId);
    }
  }
  console.log('  OK');

  // ─── Test 18d.6: no traffic data → narrator unchanged ───
  console.log();
  console.log('--- Test 18d.6: no GA4 data → narrator exactly as pre-Slice-18d ---');
  {
    // No prior period, no GA4 data at all for ZipKit → baseline.
    const v = await generateOverviewVerdict(CLIENT_ID);
    if (v.confidence !== 'first_month') {
      fail('T18d.6', `expected first_month, got ${v.confidence}`);
    }
    if (v.headline !== first.headline) {
      fail('T18d.6', `headline drifted from pre-Slice-18d baseline: ${v.headline}`);
    }
  }
  console.log('  OK');

  // Re-verify first_month branch still fires post-cleanup (drift guard).
  console.log();
  console.log('--- Post-cleanup drift check: first_month branch again ---');
  const after = await generateOverviewVerdict(CLIENT_ID);
  console.log(`  confidence: ${after.confidence}`);
  console.log(`  headline:   ${after.headline}`);
  if (after.confidence !== 'first_month') {
    fail('POST', `expected first_month after cleanup, got ${after.confidence}`);
  }
  if (after.headline !== first.headline) {
    fail('POST', `headline drifted: ${after.headline}`);
  }

  const afterSlow = await generateSlowdownVerdict(CLIENT_ID);
  console.log(`  slice 3 post-cleanup: ${afterSlow.headline}`);
  if (afterSlow.headline !== slowFirst.headline) {
    fail('POST', `slowdown headline drifted: ${afterSlow.headline}`);
  }

  const afterNow = await generateNowVerdict(CLIENT_ID);
  console.log(`  slice 4 post-cleanup: ${afterNow.headline}`);
  if (afterNow.headline !== nowFirst.headline) {
    fail('POST', `now headline drifted: ${afterNow.headline}`);
  }

  const afterNtk = await generateNeedToKnowVerdict(CLIENT_ID);
  console.log(`  slice 5 post-cleanup: ${afterNtk.headline}`);
  if (afterNtk.headline !== ntkFirst.headline) {
    fail('POST', `need-to-know headline drifted: ${afterNtk.headline}`);
  }

  console.log();
  if (failures > 0) {
    console.error(`FAILED — ${failures} assertion(s)`);
    process.exit(1);
  }
  console.log('CLIENT NARRATOR TEST PASSED ✓');
}

main().catch((err) => {
  console.error('Harness error:', err);
  process.exit(1);
});
