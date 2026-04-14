// Phase 1 follow-up — delete the phantom INV-2026-0002.
//
// Origin: a leftover from the old non-transactional generateInvoiceForContract
// code path. The invoice row was INSERTed with null period, then the
// follow-up UPDATE that should have set billing_period_start/end and added
// line items never ran (either a race or a mid-sequence crash). Result:
// status='draft', total=0, null period, 0 line items, 0 payments.
//
// Without this cleanup, the new admin work queue would surface this row
// in "Drafts awaiting review" forever and start with a visible lie on
// its first render. Scope: exactly one row, with preflight assertions
// that prove it has no real content attached.
//
// Run:
//   npx tsx scripts/phase1-cleanup-inv-2026-0002.ts --dry-run
//   npx tsx scripts/phase1-cleanup-inv-2026-0002.ts --apply

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
const INVOICE_ID = 'YiKiJQB5p3dtouMgfQuds'; // the phantom, confirmed earlier

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY-RUN' : 'APPLY'}`);
  console.log();

  // Preflight: make sure this is actually the phantom and not something
  // real we'd be destroying.
  const invRes = await db.execute({
    sql: `SELECT id, contract_id, invoice_number, status, billing_period_start, billing_period_end,
                 subtotal, total, amount_paid, created_at
          FROM invoices WHERE id = ?`,
    args: [INVOICE_ID],
  });
  if (invRes.rows.length === 0) {
    console.log('Already gone. Nothing to do.');
    return;
  }
  const inv = invRes.rows[0];
  console.log('=== Preflight ===');
  console.log(`  id:                    ${inv[0]}`);
  console.log(`  invoice_number:        ${inv[2]}`);
  console.log(`  status:                ${inv[3]}`);
  console.log(`  billing_period_start:  ${inv[4] ?? 'NULL'}`);
  console.log(`  billing_period_end:    ${inv[5] ?? 'NULL'}`);
  console.log(`  subtotal / total:      ${inv[6]} / ${inv[7]}`);
  console.log(`  amount_paid:           ${inv[8]}`);
  console.log(`  created_at:            ${inv[9]}`);

  // Refuse to delete if any real content is attached.
  if (inv[3] !== 'draft') {
    console.error(`ABORT: invoice is ${inv[3]}, not draft. Will not touch non-draft invoices.`);
    process.exit(2);
  }
  if (inv[4] !== null || inv[5] !== null) {
    console.error(`ABORT: billing period is not NULL. This is not the phantom. Will not delete.`);
    process.exit(2);
  }
  if (Number(inv[7]) !== 0) {
    console.error(`ABORT: total=${inv[7]}, not 0. Will not delete a populated invoice.`);
    process.exit(2);
  }

  const items = await db.execute({
    sql: 'SELECT COUNT(*) FROM invoice_items WHERE invoice_id = ?',
    args: [INVOICE_ID],
  });
  const payments = await db.execute({
    sql: 'SELECT COUNT(*) FROM payments WHERE invoice_id = ?',
    args: [INVOICE_ID],
  });
  const charges = await db.execute({
    sql: 'SELECT COUNT(*) FROM pending_charges WHERE billed_invoice_id = ?',
    args: [INVOICE_ID],
  });
  console.log(`  invoice_items count:   ${items.rows[0][0]}`);
  console.log(`  payments count:        ${payments.rows[0][0]}`);
  console.log(`  bound pending_charges: ${charges.rows[0][0]}`);

  if (Number(items.rows[0][0]) !== 0) {
    console.error('ABORT: invoice has line items. Not a phantom.');
    process.exit(2);
  }
  if (Number(payments.rows[0][0]) !== 0) {
    console.error('ABORT: invoice has payments. Not a phantom.');
    process.exit(2);
  }
  if (Number(charges.rows[0][0]) !== 0) {
    console.error('ABORT: invoice has bound pending_charges. Not a phantom.');
    process.exit(2);
  }

  console.log();
  console.log('All preflight assertions passed. This invoice is empty and safe to delete.');
  console.log();
  console.log('=== Planned writes ===');
  console.log(`  DELETE FROM invoices WHERE id = '${INVOICE_ID}'`);
  console.log(`  INSERT INTO activity_log (action='reconciled', entity_type='invoice', entity_id='${INVOICE_ID}', summary='Phantom invoice INV-2026-0002 (null period, empty) cleaned up as admin-queue preflight')`);
  console.log();

  if (DRY_RUN) {
    console.log('Dry run complete. No rows written.');
    return;
  }

  // Apply in a transaction so activity_log + DELETE stay atomic.
  const tx = await db.transaction('write');
  try {
    await tx.execute({ sql: 'DELETE FROM invoices WHERE id = ?', args: [INVOICE_ID] });
    await tx.execute({
      sql: `INSERT INTO activity_log (id, action, entity_type, entity_id, summary)
            VALUES (hex(randomblob(12)), 'reconciled', 'invoice', ?,
                    'Phantom invoice INV-2026-0002 (null period, empty) cleaned up as admin-queue preflight')`,
      args: [INVOICE_ID],
    });
    await tx.commit();
    console.log('Commit OK.');
  } catch (err) {
    await tx.rollback();
    console.error('ROLLED BACK:', err);
    process.exit(3);
  }

  const after = await db.execute({
    sql: 'SELECT COUNT(*) FROM invoices WHERE id = ?',
    args: [INVOICE_ID],
  });
  console.log(`Post-apply row count for ${INVOICE_ID}: ${after.rows[0][0]}`);
}

main().catch((err) => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
