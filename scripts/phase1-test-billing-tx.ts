// Phase 1 follow-up — force-failure test for generateInvoiceForContract.
//
// The earlier implementation was a sequence of separate writes (INSERT
// invoice → UPDATE period → INSERT line items → UPDATE pending_charges).
// A crash between any two of them could leave an orphan invoice row
// with null period, or line items disconnected from a marked-billed
// pending charge. INV-2026-0002 in prod is exactly that kind of artifact.
//
// This test proves the rewrite is atomic:
//
//   A. Happy path: invoice + line items + marked charges all persist.
//   B. Fault injected after step N: rolls back cleanly. No invoice row,
//      no line items, no charge-status changes.
//
// Uses a synthetic contract on the real ZipKit client. Cleans up after
// itself via deleteContract (which cascades invoices, items, payments,
// pending_charges).
//
// Run: npx tsx scripts/phase1-test-billing-tx.ts

import 'dotenv/config';
import { createClient } from '@libsql/client';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) {
  console.error('TURSO_DATABASE_URL is not set');
  process.exit(1);
}
const db = createClient({ url, authToken });

const { provisionContract, deleteContract, getContract } = await import('../src/lib/contracts');
const { generateInvoiceForContract, __setBillingTxFaultAfter, createPendingCharge } = await import(
  '../src/lib/billing'
);

const CLIENT_ID = 'oYLqVOgsutCEPNwb7hizm';

async function getAdminId(): Promise<string> {
  const r = await db.execute("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  return r.rows[0][0] as string;
}

async function countForContract(contractId: string) {
  const inv = Number(
    (await db.execute({ sql: 'SELECT COUNT(*) FROM invoices WHERE contract_id = ?', args: [contractId] })).rows[0][0]
  );
  const items = Number(
    (
      await db.execute({
        sql: `SELECT COUNT(*) FROM invoice_items WHERE invoice_id IN
              (SELECT id FROM invoices WHERE contract_id = ?)`,
        args: [contractId],
      })
    ).rows[0][0]
  );
  const pending = Number(
    (
      await db.execute({
        sql: `SELECT COUNT(*) FROM pending_charges WHERE contract_id = ? AND billed_invoice_id IS NOT NULL`,
        args: [contractId],
      })
    ).rows[0][0]
  );
  const pendingUnbilled = Number(
    (
      await db.execute({
        sql: `SELECT COUNT(*) FROM pending_charges WHERE contract_id = ? AND billed_invoice_id IS NULL`,
        args: [contractId],
      })
    ).rows[0][0]
  );
  return { inv, items, pending, pendingUnbilled };
}

let failures = 0;
const fail = (label: string, msg: string) => {
  console.error(`  FAIL [${label}]: ${msg}`);
  failures++;
};

async function setupContract(label: string): Promise<{ id: string; }> {
  const adminId = await getAdminId();
  // Provision with billing_day=1 and recurring_amount=500. billing_day=1
  // means now.getUTCDate() >= 1 is always true, so generateInvoiceForContract
  // will proceed regardless of what day we run the test.
  const result = await provisionContract({
    client_id: CLIENT_ID,
    title: `TX Test ${label} ${Date.now()}`,
    type: 'retainer',
    billing_cadence: 'monthly',
    billing_day: 1,
    recurring_amount: 500,
    created_by: adminId,
  });

  // Flip status to 'active' — provisionContract leaves it 'draft' by default
  // (ContractStatus default in schema), and generateInvoiceForContract
  // short-circuits on non-active.
  await db.execute({
    sql: "UPDATE contracts SET status = 'active' WHERE id = ?",
    args: [result.contract_id],
  });
  return { id: result.contract_id };
}

async function testHappyPath() {
  console.log('--- test A: happy path ---');
  const adminId = await getAdminId();
  const { id: contractId } = await setupContract('A');

  try {
    // Seed a pass-through charge so we exercise the charge-attach branch.
    await createPendingCharge({
      contract_id: contractId,
      description: 'Test passthrough: hosting',
      amount: 28,
      source_type: 'passthrough',
    });

    const before = await countForContract(contractId);
    const contract = await getContract(contractId);
    if (!contract) return fail('A', 'contract not found');

    __setBillingTxFaultAfter(null);
    const invoiceId = await generateInvoiceForContract(contract, adminId);
    if (!invoiceId) return fail('A', 'expected an invoice id, got null');

    const after = await countForContract(contractId);
    console.log(`  before: ${JSON.stringify(before)}`);
    console.log(`  after:  ${JSON.stringify(after)}`);

    if (after.inv !== before.inv + 1) fail('A', `invoices delta=${after.inv - before.inv}, expected 1`);
    if (after.items !== before.items + 2) fail('A', `items delta=${after.items - before.items}, expected 2`);
    if (after.pending !== 1) fail('A', `expected 1 billed charge, got ${after.pending}`);
    if (after.pendingUnbilled !== 0) fail('A', `expected 0 unbilled, got ${after.pendingUnbilled}`);

    // Verify the persisted invoice has period populated.
    const inv = await db.execute({
      sql: 'SELECT billing_period_start, billing_period_end, status, total, subtotal FROM invoices WHERE id = ?',
      args: [invoiceId],
    });
    const r = inv.rows[0];
    if (!r[0] || !r[1]) fail('A', `period_start/end NULL: ${r[0]}, ${r[1]}`);
    if (r[2] !== 'draft') fail('A', `status=${r[2]}`);
    if (Number(r[3]) !== 528) fail('A', `total=${r[3]}, expected 528 (500+28)`);
    if (Number(r[4]) !== 528) fail('A', `subtotal=${r[4]}, expected 528`);
    console.log(`  invoice persisted: ${inv.rows[0][0]}..${inv.rows[0][1]}  total=${inv.rows[0][3]}  ✓`);
  } finally {
    await deleteContract(contractId);
  }
}

async function testFaultAfter(faultAfter: number) {
  console.log(`\n--- test B: fault injected after staged write #${faultAfter} ---`);
  const adminId = await getAdminId();
  const { id: contractId } = await setupContract(`B${faultAfter}`);

  try {
    await createPendingCharge({
      contract_id: contractId,
      description: 'Test passthrough B',
      amount: 42,
      source_type: 'passthrough',
    });

    const before = await countForContract(contractId);
    const contract = await getContract(contractId);
    if (!contract) return fail('B', 'contract not found');

    __setBillingTxFaultAfter(faultAfter);
    let threw = false;
    try {
      await generateInvoiceForContract(contract, adminId);
    } catch (err: any) {
      if (!/__TEST_FAULT_AFTER_/.test(String(err?.message ?? err))) {
        fail('B', `unexpected error: ${err?.message ?? err}`);
      }
      threw = true;
    } finally {
      __setBillingTxFaultAfter(null);
    }
    if (!threw) fail('B', 'expected throw, got silent success');

    const after = await countForContract(contractId);
    console.log(`  before: ${JSON.stringify(before)}`);
    console.log(`  after:  ${JSON.stringify(after)}`);

    if (after.inv !== before.inv) fail('B', `invoice rows persisted on rollback: delta=${after.inv - before.inv}`);
    if (after.items !== before.items) fail('B', `items persisted: delta=${after.items - before.items}`);
    if (after.pending !== 0) fail('B', `charges marked billed despite rollback: ${after.pending}`);
    if (after.pendingUnbilled !== 1) fail('B', `unbilled charge count wrong: ${after.pendingUnbilled}`);
    console.log(`  rollback clean — no orphan state ✓`);
  } finally {
    await deleteContract(contractId);
  }
}

async function main() {
  console.log('=== Phase 1 follow-up: transactional billing test ===\n');

  const baseline = {
    invoices: Number((await db.execute('SELECT COUNT(*) FROM invoices')).rows[0][0]),
    items: Number((await db.execute('SELECT COUNT(*) FROM invoice_items')).rows[0][0]),
    charges: Number((await db.execute('SELECT COUNT(*) FROM pending_charges')).rows[0][0]),
    contracts: Number((await db.execute('SELECT COUNT(*) FROM contracts')).rows[0][0]),
  };

  try {
    await testHappyPath();
    await testFaultAfter(1); // fault right after invoice INSERT
    await testFaultAfter(2); // fault after recurring line item
    await testFaultAfter(3); // fault after first charge INSERT (before mark-billed)
  } finally {
    console.log('\n--- baseline vs post ---');
    const post = {
      invoices: Number((await db.execute('SELECT COUNT(*) FROM invoices')).rows[0][0]),
      items: Number((await db.execute('SELECT COUNT(*) FROM invoice_items')).rows[0][0]),
      charges: Number((await db.execute('SELECT COUNT(*) FROM pending_charges')).rows[0][0]),
      contracts: Number((await db.execute('SELECT COUNT(*) FROM contracts')).rows[0][0]),
    };
    for (const k of ['invoices', 'items', 'charges', 'contracts'] as const) {
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
  console.log('TRANSACTIONAL BILLING TEST PASSED ✓');
}

main().catch((err) => {
  console.error('Harness error:', err);
  process.exit(1);
});
