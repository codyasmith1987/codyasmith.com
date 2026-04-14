// Phase 1 Slice 10 — tests for contract-declared passthrough and
// reminder rules. Covers the pure logic (parsers, classifier, tick
// ladder) plus the integration paths (provision → persist → read,
// expense POST classification path, planDueReminders decision layer).
//
// Isolation rule (permanent): any contract this test touches is
// provisioned fresh under ZipKit with a unique title, then fully
// cleaned up on both success and failure. No snapshot tables are
// written, so there is no period-collision risk here.
//
// Run:
//   npx tsx scripts/phase1-test-contract-rules.ts

import 'dotenv/config';
import { createClient } from '@libsql/client';
import { nanoid } from 'nanoid';
import { provisionContract, deleteContract, getContract } from '../src/lib/contracts';
import {
  parsePassthroughRule,
  parseReminderRule,
  classifyExpense,
  nextReminderTick,
  getContractPassthroughRule,
  getContractReminderRule,
  getMonthToDateInCategory,
  DEFAULT_REMINDER_RULE,
  type PassthroughRule,
  type ReminderRule,
} from '../src/lib/contract-rules';
import { planDueReminders, markReminderTickSent } from '../src/lib/billing';

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
function deepEq(actual: unknown, expected: unknown, label: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`ASSERT FAILED: ${label}`);
    console.error(`  expected: ${JSON.stringify(expected)}`);
    console.error(`  actual:   ${JSON.stringify(actual)}`);
    throw new Error(label);
  }
}

async function findTestClient(): Promise<{ id: string; adminUserId: string }> {
  const c = await db.execute({
    sql: 'SELECT id FROM clients WHERE slug = ? OR name LIKE ? LIMIT 1',
    args: ['zipkit-homes', '%ZipKit%'],
  });
  assert(c.rows.length > 0, 'ZipKit test client missing');
  const a = await db.execute({ sql: `SELECT id FROM users WHERE role = 'admin' LIMIT 1` });
  assert(a.rows.length > 0, 'No admin user');
  return { id: String(c.rows[0][0]), adminUserId: String(a.rows[0][0]) };
}

async function main() {
  console.log('=== Slice 10 test: contract rules ===');
  console.log();

  // Preflight: migration applied.
  const mig = await db.execute({
    sql: `SELECT 1 FROM _migrations WHERE id = ?`,
    args: ['017-contract-rules'],
  });
  assert(mig.rows.length > 0, 'Migration 017 not applied');

  // ---- parsePassthroughRule ----
  console.log('--- parsePassthroughRule ---');
  eq(parsePassthroughRule(undefined), 'absent', 'undefined → absent');
  eq(parsePassthroughRule(null), 'absent', 'null → absent');
  eq(parsePassthroughRule('string'), null, 'string → null');
  eq(parsePassthroughRule([]), null, 'array → null');
  eq(parsePassthroughRule({}), null, 'empty obj → null (no default_action)');
  eq(
    parsePassthroughRule({ categories: [], default_action: 'wrong' }),
    null,
    'invalid default_action → null'
  );
  const goodP = parsePassthroughRule({
    default_action: 'manual_review',
    categories: [
      { name: 'hosting', monthly_cap: 100, auto_bill_under_cap: true, flag_over_cap: true },
      { name: 'ads', monthly_cap: null, auto_bill_under_cap: false, flag_over_cap: false },
    ],
  });
  assert(goodP !== null && goodP !== 'absent', 'good rule parses');
  eq((goodP as PassthroughRule).categories.length, 2, 'two categories');
  eq((goodP as PassthroughRule).categories[0].monthly_cap, 100, 'hosting cap');
  eq((goodP as PassthroughRule).categories[1].monthly_cap, null, 'ads unlimited');
  eq(
    parsePassthroughRule({
      default_action: 'manual_review',
      categories: [
        { name: 'x', monthly_cap: 0, auto_bill_under_cap: true, flag_over_cap: true },
        { name: 'x', monthly_cap: 0, auto_bill_under_cap: true, flag_over_cap: true },
      ],
    }),
    null,
    'duplicate category name → null'
  );
  eq(
    parsePassthroughRule({
      default_action: 'manual_review',
      categories: [{ name: 'x', monthly_cap: -5, auto_bill_under_cap: true, flag_over_cap: true }],
    }),
    null,
    'negative cap → null'
  );
  console.log('  parsePassthroughRule OK');
  console.log();

  // ---- parseReminderRule ----
  console.log('--- parseReminderRule ---');
  eq(parseReminderRule(undefined), 'absent', 'undefined → absent');
  const goodR = parseReminderRule({
    before_due_days: [3, 7, 1],
    after_due_days: [1, 3, 7, 14],
  });
  assert(goodR !== null && goodR !== 'absent', 'valid → parses');
  deepEq((goodR as ReminderRule).before_due_days, [7, 3, 1], 'before sorted desc');
  deepEq((goodR as ReminderRule).after_due_days, [1, 3, 7, 14], 'after sorted asc');
  eq(
    parseReminderRule({ before_due_days: [1.5], after_due_days: [] }),
    null,
    'non-integer day → null'
  );
  eq(
    parseReminderRule({ before_due_days: [-1], after_due_days: [] }),
    null,
    'negative day → null'
  );
  eq(
    parseReminderRule({ before_due_days: [], after_due_days: [], digest: 'daily' }),
    null,
    'invalid digest → null'
  );
  const dedup = parseReminderRule({ before_due_days: [7, 7, 3], after_due_days: [] });
  deepEq((dedup as ReminderRule).before_due_days, [7, 3], 'duplicate days deduped');
  console.log('  parseReminderRule OK');
  console.log();

  // ---- classifyExpense ----
  console.log('--- classifyExpense ---');
  const rule: PassthroughRule = {
    default_action: 'manual_review',
    categories: [
      { name: 'hosting', monthly_cap: 100, auto_bill_under_cap: true, flag_over_cap: true },
      { name: 'ads', monthly_cap: null, auto_bill_under_cap: true, flag_over_cap: false },
      { name: 'tools', monthly_cap: 50, auto_bill_under_cap: false, flag_over_cap: true },
    ],
  };

  // Under cap, auto_bill_under_cap=true → auto_bill
  eq(
    classifyExpense({ amount: 40, category: 'hosting', monthToDateInCategory: 20, rule }).classification,
    'auto_bill',
    'hosting under cap → auto_bill'
  );
  // Over cap, flag_over_cap=true → needs_approval
  eq(
    classifyExpense({ amount: 50, category: 'hosting', monthToDateInCategory: 80, rule }).classification,
    'needs_approval',
    'hosting over cap → needs_approval'
  );
  // Uncategorized → default_action (manual_review)
  eq(
    classifyExpense({ amount: 10, category: null, monthToDateInCategory: 0, rule }).classification,
    'manual_review',
    'uncategorized → default manual_review'
  );
  // Category not in rule → default
  eq(
    classifyExpense({ amount: 10, category: 'nowhere', monthToDateInCategory: 0, rule }).classification,
    'manual_review',
    'unknown category → default manual_review'
  );
  // Unlimited cap: always auto_bill
  eq(
    classifyExpense({ amount: 9999, category: 'ads', monthToDateInCategory: 5000, rule }).classification,
    'auto_bill',
    'unlimited category → auto_bill'
  );
  // Within cap but auto_bill_under_cap=false → manual_review
  eq(
    classifyExpense({ amount: 10, category: 'tools', monthToDateInCategory: 0, rule }).classification,
    'manual_review',
    'tools within cap but not auto → manual_review'
  );
  console.log('  classifyExpense OK');
  console.log();

  // ---- nextReminderTick ----
  console.log('--- nextReminderTick ---');
  const r: ReminderRule = { before_due_days: [7, 3, 1], after_due_days: [1, 3, 7] };
  // Helper to make a UTC date at midnight.
  const mkDate = (iso: string) => new Date(iso + 'T12:00:00Z');

  // Before due, 7 days out → fire before:7
  eq(
    nextReminderTick({ dueDate: '2026-05-01', now: mkDate('2026-04-24'), rule: r, sentTicks: [] }),
    'before:7',
    '7 days out → before:7'
  );
  // Before due, 6 days out, before:7 sent → no tick
  eq(
    nextReminderTick({
      dueDate: '2026-05-01',
      now: mkDate('2026-04-25'),
      rule: r,
      sentTicks: ['before:7'],
    }),
    null,
    '6 days out with before:7 sent → null'
  );
  // Before due, 3 days out → fire before:3
  eq(
    nextReminderTick({
      dueDate: '2026-05-01',
      now: mkDate('2026-04-28'),
      rule: r,
      sentTicks: ['before:7'],
    }),
    'before:3',
    '3 days out → before:3'
  );
  // Catch-up: never sent any, 5 days out → fire the largest crossed tick, before:7
  eq(
    nextReminderTick({ dueDate: '2026-05-01', now: mkDate('2026-04-26'), rule: r, sentTicks: [] }),
    'before:7',
    '5 days out with nothing sent → catch-up before:7'
  );
  // Due day → fire before:1 (if not sent)
  eq(
    nextReminderTick({ dueDate: '2026-05-01', now: mkDate('2026-05-01'), rule: r, sentTicks: [] }),
    'before:1',
    'due day → before:1'
  );
  // 1 day past due → fire after:1
  eq(
    nextReminderTick({
      dueDate: '2026-05-01',
      now: mkDate('2026-05-02'),
      rule: r,
      sentTicks: ['before:7', 'before:3', 'before:1'],
    }),
    'after:1',
    '1 day past → after:1'
  );
  // 5 days past, after:1 sent → fire after:3
  eq(
    nextReminderTick({
      dueDate: '2026-05-01',
      now: mkDate('2026-05-06'),
      rule: r,
      sentTicks: ['before:7', 'before:3', 'before:1', 'after:1'],
    }),
    'after:3',
    '5 days past, after:1 sent → after:3'
  );
  // Everything sent → null
  eq(
    nextReminderTick({
      dueDate: '2026-05-01',
      now: mkDate('2026-05-10'),
      rule: r,
      sentTicks: ['before:7', 'before:3', 'before:1', 'after:1', 'after:3', 'after:7'],
    }),
    null,
    'all sent → null'
  );
  console.log('  nextReminderTick OK');
  console.log();

  // ---- Integration: provisionContract persists rules ----
  console.log('--- provisionContract persists rules ---');
  const testClient = await findTestClient();
  const testTitle = `slice-10-test ${new Date().toISOString()}`;
  const testRuleP: PassthroughRule = {
    default_action: 'manual_review',
    categories: [
      { name: 'hosting', monthly_cap: 50, auto_bill_under_cap: true, flag_over_cap: true },
      { name: 'ads', monthly_cap: null, auto_bill_under_cap: true, flag_over_cap: false },
    ],
  };
  const testRuleR: ReminderRule = { before_due_days: [5, 1], after_due_days: [2, 10] };

  const provision = await provisionContract({
    client_id: testClient.id,
    title: testTitle,
    type: 'retainer',
    billing_cadence: 'monthly',
    billing_day: 9,
    recurring_amount: 500,
    passthrough_rule: testRuleP,
    reminder_rule: testRuleR,
    created_by: testClient.adminUserId,
  });

  const cleanup = {
    contractId: provision.contract_id,
    scheduledJobId: provision.scheduled_job_id,
  };

  try {
    // Mark contract active so downstream expense / billing tests
    // don't get rejected by status checks.
    await db.execute({
      sql: `UPDATE contracts SET status = 'active' WHERE id = ?`,
      args: [provision.contract_id],
    });

    const readP = await getContractPassthroughRule(provision.contract_id);
    const readR = await getContractReminderRule(provision.contract_id);
    assert(readP !== null, 'passthrough rule persisted');
    assert(readR !== null, 'reminder rule persisted');
    deepEq(readP!.categories, testRuleP.categories, 'passthrough categories round-trip');
    eq(readP!.default_action, 'manual_review', 'passthrough default round-trip');
    deepEq(readR!.before_due_days, [5, 1], 'reminder before round-trip');
    deepEq(readR!.after_due_days, [2, 10], 'reminder after round-trip');

    const contract = await getContract(provision.contract_id);
    assert(contract !== undefined, 'contract readable');
    console.log('  rules round-trip OK');
    console.log();

    // ---- Integration: classify-on-insert via live DB ----
    console.log('--- expense classification (live DB path) ---');

    // Insert a hosting charge under the cap → should classify auto_bill.
    // Use the contract-rules helpers + SQL directly (simulating what
    // the expense POST handler now does).
    async function insertExpense(category: string | null, amount: number) {
      const monthToDate = category
        ? await getMonthToDateInCategory(provision.contract_id, category)
        : 0;
      const result = classifyExpense({
        amount,
        category,
        monthToDateInCategory: monthToDate,
        rule: readP,
      });
      const id = nanoid();
      await db.execute({
        sql: `INSERT INTO pending_charges
              (id, contract_id, description, amount, source_type, category, classification, needs_approval)
              VALUES (?, ?, ?, ?, 'passthrough', ?, ?, ?)`,
        args: [
          id,
          provision.contract_id,
          `test ${category ?? 'none'} $${amount}`,
          amount,
          category,
          result.classification,
          result.needs_approval ? 1 : 0,
        ],
      });
      return { id, ...result, monthToDate };
    }

    const e1 = await insertExpense('hosting', 30); // under cap 50 → auto_bill
    eq(e1.classification, 'auto_bill', 'hosting 30 → auto_bill');

    // Second hosting charge pushes MTD to 60 (over cap 50) → needs_approval
    const e2 = await insertExpense('hosting', 30);
    eq(e2.classification, 'needs_approval', 'hosting +30 (MTD=60) → needs_approval');
    eq(e2.monthToDate, 30, 'MTD snapshot reflected first insert');

    // Uncategorized → default manual_review
    const e3 = await insertExpense(null, 75);
    eq(e3.classification, 'manual_review', 'uncategorized → manual_review');

    // Unlimited category → auto_bill at any amount
    const e4 = await insertExpense('ads', 9999);
    eq(e4.classification, 'auto_bill', 'ads 9999 → auto_bill (unlimited)');

    // Read back from DB, verify needs_approval bit.
    const rows = await db.execute({
      sql: `SELECT classification, category, needs_approval, amount
            FROM pending_charges WHERE contract_id = ? ORDER BY created_at`,
      args: [provision.contract_id],
    });
    eq(rows.rows.length, 4, '4 pending_charges rows');
    const row1 = rows.rows[1] as any[];
    eq(row1[0], 'needs_approval', 'row 1 classification');
    eq(Number(row1[2]), 1, 'row 1 needs_approval = 1');
    console.log('  classification persistence OK');
    console.log();

    // ---- Integration: planDueReminders ----
    console.log('--- planDueReminders live path ---');

    // Seed an invoice under the test contract with a synthetic due
    // date that forces a specific tick. sent status + amount > paid.
    const inv1Id = nanoid();
    const invoiceNumber = `SLICE10-${Date.now()}`;
    const dueDate = (() => {
      // 3 days from now (UTC) — contract rule is [5,1] so this should
      // fire before:5 because daysUntil=3 <= 5 and nothing sent yet.
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + 3);
      return d.toISOString().split('T')[0];
    })();
    await db.execute({
      sql: `INSERT INTO invoices
            (id, contract_id, client_id, invoice_number, status, issued_date, due_date,
             subtotal, tax, total, amount_paid, client_visible, created_by,
             reminder_ticks_sent_json)
            VALUES (?, ?, ?, ?, 'sent', date('now'), ?, 500, 0, 500, 0, 1, ?, '[]')`,
      args: [
        inv1Id,
        provision.contract_id,
        testClient.id,
        invoiceNumber,
        dueDate,
        testClient.adminUserId,
      ],
    });

    const plan = await planDueReminders();
    const mine = plan.find((p) => p.invoice.id === inv1Id);
    assert(mine !== undefined, 'test invoice in plan');
    eq(mine!.tick, 'before:5', 'tick is before:5');

    // markReminderTickSent + re-plan → should advance or drop it.
    await markReminderTickSent(inv1Id, 'before:5');
    const plan2 = await planDueReminders();
    const mine2 = plan2.find((p) => p.invoice.id === inv1Id);
    // After firing before:5, the next tick is before:1 only when
    // daysUntil <= 1. 3 days out → no further tick yet.
    eq(mine2, undefined, 'after marking before:5, no further tick at 3-day distance');

    // Cleanup the test invoice.
    await db.execute({ sql: 'DELETE FROM invoices WHERE id = ?', args: [inv1Id] });
    console.log('  planDueReminders OK');
    console.log();
  } finally {
    // Cleanup — always runs so failures never leave state behind.
    console.log('--- cleanup ---');
    await db.execute({
      sql: 'DELETE FROM pending_charges WHERE contract_id = ?',
      args: [cleanup.contractId],
    });
    await db.execute({
      sql: 'DELETE FROM invoices WHERE contract_id = ?',
      args: [cleanup.contractId],
    });
    await db.execute({
      sql: 'DELETE FROM data_source_bindings WHERE contract_id = ?',
      args: [cleanup.contractId],
    });
    if (cleanup.scheduledJobId) {
      await db.execute({
        sql: 'DELETE FROM scheduled_jobs WHERE id = ?',
        args: [cleanup.scheduledJobId],
      });
    }
    await db.execute({
      sql: 'DELETE FROM activity_log WHERE entity_type = ? AND entity_id = ?',
      args: ['contract', cleanup.contractId],
    });
    try {
      await deleteContract(cleanup.contractId);
    } catch (err) {
      // If deleteContract chokes on a status check, fall back to a
      // direct contract-row delete — the rest of the tree is already
      // cleaned up above.
      await db.execute({ sql: 'DELETE FROM contracts WHERE id = ?', args: [cleanup.contractId] });
    }

    const leftover = await db.execute({
      sql: 'SELECT COUNT(*) FROM contracts WHERE id = ?',
      args: [cleanup.contractId],
    });
    eq(Number(leftover.rows[0][0]), 0, 'contract row removed');
    console.log('  cleanup complete');
    console.log();
  }

  console.log('SLICE 10 TEST PASSED ✓');
}

main().catch((err) => {
  console.error();
  console.error('SLICE 10 TEST FAILED:', err);
  process.exit(1);
});
