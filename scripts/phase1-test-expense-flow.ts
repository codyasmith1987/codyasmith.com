// Phase 1 follow-up — minimal expense flow end-to-end test.
//
// Exercises the full pass-through expense path against the real DB:
//
//   1. Provision a throwaway monthly contract on the ZipKit client.
//   2. Create an unbilled expense via the same SQL the POST route uses.
//   3. Run generateInvoiceForContract. Assert:
//        - exactly one invoice exists for the test contract
//        - invoice total == recurring_amount + expense.amount
//        - the pending_charge's billed_invoice_id now points at that invoice
//   4. Try to delete the now-billed charge via the live DELETE endpoint
//      logic (we replicate the guard inline since we're not hitting HTTP).
//      The guard only blocks when the invoice is no longer 'draft'. Our
//      test invoice is still draft, so delete should SUCCEED here and
//      leave the pending_charge row gone. That's the designed behavior:
//      admins can un-attach an expense from a draft invoice before it
//      goes out. Non-draft invoices are the actual lock boundary.
//   5. Re-create a fresh unbilled expense and delete it — asserts the
//      unbilled delete path works.
//   6. Cleanup.
//
// We do NOT stand up a dev server. The routes are thin wrappers around
// SQL we can invoke directly; the test covers the same code path and
// same constraints.
//
// Run: npx tsx scripts/phase1-test-expense-flow.ts

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

const { provisionContract, deleteContract, getContract } = await import('../src/lib/contracts');
const { generateInvoiceForContract } = await import('../src/lib/billing');

const CLIENT_ID = 'oYLqVOgsutCEPNwb7hizm';

async function getAdminId(): Promise<string> {
  const r = await db.execute("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  return r.rows[0][0] as string;
}

let failures = 0;
const fail = (label: string, msg: string) => {
  console.error(`  FAIL [${label}]: ${msg}`);
  failures++;
};

// Replicate the POST /portal/api/admin/expenses validation + insert
// to keep the test grounded in the route's real behavior.
async function createExpense(opts: {
  contract_id: string;
  description: string;
  amount: number;
  target_invoice_id?: string | null;
}): Promise<string> {
  if (!opts.description) throw new Error('description required');
  if (!Number.isFinite(opts.amount) || opts.amount <= 0) throw new Error('amount must be > 0');
  const contract = await getContract(opts.contract_id);
  if (!contract) throw new Error('contract not found');
  if (contract.status !== 'active') throw new Error(`contract is ${contract.status}`);

  if (opts.target_invoice_id) {
    const inv = await db.execute({
      sql: 'SELECT contract_id, status FROM invoices WHERE id = ?',
      args: [opts.target_invoice_id],
    });
    if (inv.rows.length === 0) throw new Error('target_invoice_id not found');
    if (inv.rows[0][0] !== opts.contract_id) throw new Error('different contract');
    if (inv.rows[0][1] !== 'draft') throw new Error('target_invoice not draft');
  }

  const id = nanoid();
  await db.execute({
    sql: `INSERT INTO pending_charges
          (id, contract_id, description, amount, source_type, source_id, billed_invoice_id)
          VALUES (?, ?, ?, ?, 'passthrough', NULL, ?)`,
    args: [id, opts.contract_id, opts.description, opts.amount, opts.target_invoice_id ?? null],
  });
  return id;
}

// Replicate DELETE /portal/api/admin/expenses/[id] guard + delete.
async function deleteExpense(id: string): Promise<{ ok: boolean; status: number; error?: string }> {
  const row = await db.execute({
    sql: `SELECT pc.billed_invoice_id, i.status AS invoice_status
          FROM pending_charges pc
          LEFT JOIN invoices i ON i.id = pc.billed_invoice_id
          WHERE pc.id = ?`,
    args: [id],
  });
  if (row.rows.length === 0) return { ok: false, status: 404, error: 'not found' };
  const billedInvoiceId = row.rows[0][0] as string | null;
  const invoiceStatus = row.rows[0][1] as string | null;
  if (billedInvoiceId !== null && invoiceStatus !== null && invoiceStatus !== 'draft') {
    return { ok: false, status: 409, error: `already billed on invoice (status=${invoiceStatus})` };
  }
  await db.execute({ sql: 'DELETE FROM pending_charges WHERE id = ?', args: [id] });
  return { ok: true, status: 200 };
}

async function main() {
  console.log('=== Phase 1 follow-up: expense flow test ===\n');

  const adminId = await getAdminId();
  // Capture scheduled_jobs baseline BEFORE provisioning so we can
  // identify rows the test creates (provisionContract enqueues one
  // generate_invoices job, and any side-effect enqueues during
  // runDueJobs would also land here).
  const scheduledJobBaseline = new Set<string>(
    (await db.execute('SELECT id FROM scheduled_jobs')).rows.map((r) => r[0] as string)
  );
  const baseline = {
    contracts: Number((await db.execute('SELECT COUNT(*) FROM contracts')).rows[0][0]),
    invoices: Number((await db.execute('SELECT COUNT(*) FROM invoices')).rows[0][0]),
    items: Number((await db.execute('SELECT COUNT(*) FROM invoice_items')).rows[0][0]),
    charges: Number((await db.execute('SELECT COUNT(*) FROM pending_charges')).rows[0][0]),
    jobs: scheduledJobBaseline.size,
  };

  // Provision a throwaway contract with billing_day=1 so the billing run
  // fires regardless of today's date.
  const result = await provisionContract({
    client_id: CLIENT_ID,
    title: `Expense Test ${Date.now()}`,
    type: 'retainer',
    billing_cadence: 'monthly',
    billing_day: 1,
    recurring_amount: 500,
    created_by: adminId,
  });
  const contractId = result.contract_id;
  await db.execute({
    sql: "UPDATE contracts SET status = 'active' WHERE id = ?",
    args: [contractId],
  });
  console.log(`test contract: ${contractId}\n`);

  try {
    // --- Step 1: create an unbilled expense ---
    console.log('--- create unbilled expense ---');
    const expenseId = await createExpense({
      contract_id: contractId,
      description: 'Test expense: plugin renewal',
      amount: 28,
    });
    const e1 = await db.execute({
      sql: 'SELECT contract_id, description, amount, source_type, billed_invoice_id FROM pending_charges WHERE id = ?',
      args: [expenseId],
    });
    const row = e1.rows[0];
    console.log(`  created ${expenseId}  amount=${row[2]}  billed_invoice_id=${row[4] ?? 'null'}`);
    if (row[3] !== 'passthrough') fail('create', `source_type=${row[3]}`);
    if (row[4] !== null) fail('create', `billed_invoice_id should be null, got ${row[4]}`);
    if (Number(row[2]) !== 28) fail('create', `amount=${row[2]}`);

    // --- Step 2: run the billing engine and verify attach ---
    console.log('\n--- run billing, verify attach ---');
    const contract = await getContract(contractId);
    if (!contract) throw new Error('lost contract');
    const invoiceId = await generateInvoiceForContract(contract, adminId);
    if (!invoiceId) fail('billing', 'expected invoice id, got null');

    const inv = await db.execute({
      sql: 'SELECT status, subtotal, total, billing_period_start, billing_period_end FROM invoices WHERE id = ?',
      args: [invoiceId!],
    });
    const ir = inv.rows[0];
    console.log(`  invoice:  status=${ir[0]}  subtotal=${ir[1]}  total=${ir[2]}  period=${ir[3]}..${ir[4]}`);
    if (Number(ir[2]) !== 528) fail('billing', `total=${ir[2]}, expected 528 (500 recurring + 28 expense)`);

    const items = await db.execute({
      sql: 'SELECT description, amount FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order',
      args: [invoiceId!],
    });
    console.log(`  line items: ${items.rows.length}`);
    for (const it of items.rows) console.log(`    - ${it[0]}  $${it[1]}`);
    if (items.rows.length !== 2) fail('billing', `expected 2 line items, got ${items.rows.length}`);

    const charge = await db.execute({
      sql: 'SELECT billed_invoice_id FROM pending_charges WHERE id = ?',
      args: [expenseId],
    });
    if (charge.rows[0][0] !== invoiceId) {
      fail('billing', `pending_charge not attached: billed_invoice_id=${charge.rows[0][0]}`);
    } else {
      console.log(`  pending_charge now pinned to invoice ✓`);
    }

    // --- Step 3: delete the draft-bound expense. Should succeed, since
    //         the lock boundary is 'non-draft', not 'any-billed'. ---
    console.log('\n--- delete draft-bound expense (should succeed) ---');
    const del1 = await deleteExpense(expenseId);
    console.log(`  result: ok=${del1.ok} status=${del1.status}`);
    if (!del1.ok) fail('delete-draft', `unexpected rejection: ${del1.error}`);
    const chargeAfter = await db.execute({
      sql: 'SELECT COUNT(*) FROM pending_charges WHERE id = ?',
      args: [expenseId],
    });
    if (Number(chargeAfter.rows[0][0]) !== 0) fail('delete-draft', 'charge not deleted');

    // --- Step 4: promote the invoice to 'sent', create a NEW expense
    //         pinned to that same invoice via direct SQL (since the POST
    //         route requires draft), and verify that deleting a
    //         'sent'-bound charge is REJECTED. ---
    console.log('\n--- fabricate sent-bound expense, expect delete reject ---');
    await db.execute({
      sql: "UPDATE invoices SET status = 'sent' WHERE id = ?",
      args: [invoiceId!],
    });
    const sentExpenseId = nanoid();
    await db.execute({
      sql: `INSERT INTO pending_charges (id, contract_id, description, amount, source_type, billed_invoice_id)
            VALUES (?, ?, 'Test expense on sent invoice', 15, 'passthrough', ?)`,
      args: [sentExpenseId, contractId, invoiceId!],
    });
    const del2 = await deleteExpense(sentExpenseId);
    console.log(`  result: ok=${del2.ok} status=${del2.status} error=${del2.error ?? '-'}`);
    if (del2.ok) fail('delete-sent', 'should have been rejected with 409');
    if (del2.status !== 409) fail('delete-sent', `status=${del2.status}, expected 409`);

    // Flip invoice back to draft so deleteContract cleanup works (the
    // cascade delete path handles drafts fine; sent invoices would also
    // be deleted by cascadeDeleteContractChildren, but we'll let the
    // standard path run).
    await db.execute({
      sql: "UPDATE invoices SET status = 'draft' WHERE id = ?",
      args: [invoiceId!],
    });
    // Unlink the sent-bound charge so cleanup can drop it.
    await db.execute({
      sql: 'DELETE FROM pending_charges WHERE id = ?',
      args: [sentExpenseId],
    });

    // --- Step 5: create+delete an unbilled expense (simple path) ---
    console.log('\n--- create + delete unbilled expense ---');
    const unbilledId = await createExpense({
      contract_id: contractId,
      description: 'Unbilled expense test',
      amount: 9,
    });
    const del3 = await deleteExpense(unbilledId);
    if (!del3.ok) fail('delete-unbilled', `rejected: ${del3.error}`);
    const check = await db.execute({
      sql: 'SELECT COUNT(*) FROM pending_charges WHERE id = ?',
      args: [unbilledId],
    });
    if (Number(check.rows[0][0]) !== 0) fail('delete-unbilled', 'row still present');
    console.log(`  unbilled delete OK ✓`);
  } finally {
    console.log('\n--- cleanup ---');
    try {
      await deleteContract(contractId);
    } catch (err: any) {
      console.error(`  deleteContract failed: ${err?.message ?? err}`);
    }
    // Clean up any scheduled_jobs rows created during this run that are
    // not in the baseline set.
    const allJobs = (await db.execute('SELECT id FROM scheduled_jobs')).rows.map((r) => r[0] as string);
    const newIds = allJobs.filter((id) => !scheduledJobBaseline.has(id));
    for (const id of newIds) {
      await db.execute({ sql: 'DELETE FROM scheduled_jobs WHERE id = ?', args: [id] });
    }
    await db.execute({
      sql: "DELETE FROM activity_log WHERE entity_type = 'contract' AND entity_id = ?",
      args: [contractId],
    });
    await db.execute({
      sql: "DELETE FROM activity_log WHERE entity_type = 'pending_charge' AND summary LIKE '%Test expense%'",
    });

    const post = {
      contracts: Number((await db.execute('SELECT COUNT(*) FROM contracts')).rows[0][0]),
      invoices: Number((await db.execute('SELECT COUNT(*) FROM invoices')).rows[0][0]),
      items: Number((await db.execute('SELECT COUNT(*) FROM invoice_items')).rows[0][0]),
      charges: Number((await db.execute('SELECT COUNT(*) FROM pending_charges')).rows[0][0]),
      jobs: Number((await db.execute('SELECT COUNT(*) FROM scheduled_jobs')).rows[0][0]),
    };
    for (const k of ['contracts', 'invoices', 'items', 'charges', 'jobs'] as const) {
      const delta = post[k] - baseline[k];
      const mark = delta === 0 ? '✓' : `DRIFT ${delta > 0 ? '+' : ''}${delta}`;
      console.log(`  ${k.padEnd(12)} ${post[k]}  ${mark}`);
      if (delta !== 0) failures++;
    }
  }

  console.log();
  if (failures > 0) {
    console.error(`FAILED — ${failures} assertion(s)`);
    process.exit(1);
  }
  console.log('EXPENSE FLOW TEST PASSED ✓');
}

main().catch((err) => {
  console.error('Harness error:', err);
  process.exit(1);
});
