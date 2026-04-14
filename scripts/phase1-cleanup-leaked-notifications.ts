// Phase 1 slice-6 follow-up — delete the three leaked ZipKit notifications.
//
// Origin: test-pollution from the earlier billing/notification runs. Three
// invoice_sent notifications sit in the notifications table for
// kelsey@zipkithomes.com:
//
//   1) entity_id=dl-ge3QCkXsJETSSzswKK   body mentions INV-2026-0003 ($300)
//      invoice row no longer exists (dangling)
//   2) entity_id=eX5K1B5X1PlKPnKkdTeNr   body mentions INV-2026-0003 ($300)
//      invoice row no longer exists (dangling)
//   3) entity_id=-Nm1O_zg8cIlj4cF5EVzF   body mentions INV-2026-0001 ($500)
//      invoice row exists but status='draft' (admin work, never client-sent)
//
// The client-narrator filters all three out of slice 5 via the entity-join
// guard, so the dashboard is already truthful. But /portal/notifications
// would still render an "Invoice ready" toast the moment kelsey logs in,
// including for an invoice that literally does not exist. That's the lie
// this script removes.
//
// Scope: exactly the three notification IDs below, with preflight assertions
// that prove each row still matches its expected shape before any delete.
//
// Run:
//   npx tsx scripts/phase1-cleanup-leaked-notifications.ts --dry-run
//   npx tsx scripts/phase1-cleanup-leaked-notifications.ts --apply

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

const ZIPKIT_USER_EMAIL = 'kelsey@zipkithomes.com';

type Expected = {
  id: string;
  kind: 'dangling' | 'draft-invoice';
  entity_id: string;
  invoice_number_in_body: string;
};

const EXPECTED: Expected[] = [
  {
    id: '50dGJ6iK3MjQqRcklszNG',
    kind: 'dangling',
    entity_id: 'dl-ge3QCkXsJETSSzswKK',
    invoice_number_in_body: 'INV-2026-0003',
  },
  {
    id: 'w6ypSjVTpo4YJniWxeQxO',
    kind: 'dangling',
    entity_id: 'eX5K1B5X1PlKPnKkdTeNr',
    invoice_number_in_body: 'INV-2026-0003',
  },
  {
    id: 'mtc6KOtplN2B-EBJ5T9Se',
    kind: 'draft-invoice',
    entity_id: '-Nm1O_zg8cIlj4cF5EVzF',
    invoice_number_in_body: 'INV-2026-0001',
  },
];

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY-RUN' : 'APPLY'}`);
  console.log();

  // Resolve the ZipKit user.
  const userRes = await db.execute({
    sql: 'SELECT id, email, client_id FROM users WHERE email = ?',
    args: [ZIPKIT_USER_EMAIL],
  });
  if (userRes.rows.length !== 1) {
    console.error(`ABORT: expected exactly one user with email ${ZIPKIT_USER_EMAIL}, found ${userRes.rows.length}`);
    process.exit(2);
  }
  const zipkitUserId = userRes.rows[0][0] as string;
  const zipkitClientId = userRes.rows[0][2] as string;
  console.log(`ZipKit user: ${ZIPKIT_USER_EMAIL}`);
  console.log(`  user_id:   ${zipkitUserId}`);
  console.log(`  client_id: ${zipkitClientId}`);
  console.log();

  console.log('=== Preflight ===');
  let okCount = 0;
  for (const e of EXPECTED) {
    const r = await db.execute({
      sql: `SELECT id, user_id, type, title, body, entity_type, entity_id, read
            FROM notifications WHERE id = ?`,
      args: [e.id],
    });
    if (r.rows.length === 0) {
      console.log(`  ${e.id}: already absent — will skip`);
      continue;
    }
    const n = r.rows[0];
    const id = n[0];
    const user_id = n[1];
    const type = n[2];
    const title = n[3];
    const body = n[4];
    const entity_type = n[5];
    const entity_id = n[6];
    const read = n[7];

    console.log(`  ${id}`);
    console.log(`    user_id=${user_id}`);
    console.log(`    type=${type}  title="${title}"`);
    console.log(`    body="${body}"`);
    console.log(`    entity=${entity_type}:${entity_id}  read=${read}`);

    // Assertions that refuse to touch anything whose shape has drifted.
    if (user_id !== zipkitUserId) {
      console.error(`    ABORT: user_id ${user_id} != ZipKit user ${zipkitUserId}`);
      process.exit(2);
    }
    if (type !== 'invoice_sent') {
      console.error(`    ABORT: type is '${type}', expected 'invoice_sent'`);
      process.exit(2);
    }
    if (entity_type !== 'invoice') {
      console.error(`    ABORT: entity_type is '${entity_type}', expected 'invoice'`);
      process.exit(2);
    }
    if (entity_id !== e.entity_id) {
      console.error(`    ABORT: entity_id drift: expected ${e.entity_id}, got ${entity_id}`);
      process.exit(2);
    }
    if (Number(read) !== 0) {
      console.error(`    ABORT: notification is already read (read=${read}). Refusing to delete read history.`);
      process.exit(2);
    }
    if (typeof body !== 'string' || !body.includes(e.invoice_number_in_body)) {
      console.error(`    ABORT: body does not contain expected invoice number ${e.invoice_number_in_body}`);
      process.exit(2);
    }

    // Kind-specific assertion.
    const invRes = await db.execute({
      sql: 'SELECT id, invoice_number, status, client_id FROM invoices WHERE id = ?',
      args: [entity_id as string],
    });

    if (e.kind === 'dangling') {
      if (invRes.rows.length !== 0) {
        console.error(`    ABORT: expected dangling entity_id, but invoice row exists: ${JSON.stringify(invRes.rows[0])}`);
        process.exit(2);
      }
      console.log(`    kind=dangling (verified: no invoice row)`);
    } else if (e.kind === 'draft-invoice') {
      if (invRes.rows.length !== 1) {
        console.error(`    ABORT: expected draft invoice row to exist, found ${invRes.rows.length}`);
        process.exit(2);
      }
      const invRow = invRes.rows[0];
      const invNum = invRow[1];
      const invStatus = invRow[2];
      const invClientId = invRow[3];
      if (invStatus !== 'draft') {
        console.error(`    ABORT: expected invoice status 'draft', got '${invStatus}'. Refusing to delete notification for sent invoice.`);
        process.exit(2);
      }
      if (invClientId !== zipkitClientId) {
        console.error(`    ABORT: invoice client_id ${invClientId} != ZipKit client_id ${zipkitClientId}`);
        process.exit(2);
      }
      if (invNum !== e.invoice_number_in_body) {
        console.error(`    ABORT: invoice_number ${invNum} != expected ${e.invoice_number_in_body}`);
        process.exit(2);
      }
      console.log(`    kind=draft-invoice (verified: ${invNum} status=draft)`);
    }

    okCount += 1;
    console.log();
  }

  if (okCount === 0) {
    console.log('Nothing to delete. All three notifications are already absent.');
    return;
  }

  console.log(`All preflight assertions passed for ${okCount} notification(s).`);
  console.log();
  console.log('=== Planned writes ===');
  for (const e of EXPECTED) {
    console.log(`  DELETE FROM notifications WHERE id = '${e.id}'`);
  }
  console.log(`  INSERT INTO activity_log (${okCount}x, one per deletion)`);
  console.log();

  if (DRY_RUN) {
    console.log('Dry run complete. No rows written.');
    return;
  }

  // Apply in a transaction so every delete + matching activity_log row
  // stays atomic.
  const tx = await db.transaction('write');
  try {
    for (const e of EXPECTED) {
      const r = await tx.execute({
        sql: `SELECT id FROM notifications WHERE id = ?`,
        args: [e.id],
      });
      if (r.rows.length === 0) continue;

      await tx.execute({
        sql: 'DELETE FROM notifications WHERE id = ?',
        args: [e.id],
      });
      const summary =
        e.kind === 'dangling'
          ? `Leaked test notification ${e.id} (body referenced ${e.invoice_number_in_body}, entity_id ${e.entity_id} had no invoice row) cleaned up`
          : `Leaked test notification ${e.id} (body referenced draft invoice ${e.invoice_number_in_body}) cleaned up`;
      await tx.execute({
        sql: `INSERT INTO activity_log (id, action, entity_type, entity_id, summary)
              VALUES (hex(randomblob(12)), 'reconciled', 'notification', ?, ?)`,
        args: [e.id, summary],
      });
    }
    await tx.commit();
    console.log('Commit OK.');
  } catch (err) {
    await tx.rollback();
    console.error('ROLLED BACK:', err);
    process.exit(3);
  }

  // Post-apply verification.
  const after = await db.execute({
    sql: `SELECT COUNT(*) FROM notifications WHERE id IN (?, ?, ?)`,
    args: [EXPECTED[0].id, EXPECTED[1].id, EXPECTED[2].id],
  });
  console.log(`Post-apply row count for the three IDs: ${after.rows[0][0]}`);

  const remaining = await db.execute({
    sql: `SELECT COUNT(*) FROM notifications n
          JOIN users u ON u.id = n.user_id
          WHERE u.client_id = ?`,
    args: [zipkitClientId],
  });
  console.log(`Remaining notifications for ZipKit user: ${remaining.rows[0][0]}`);
}

main().catch((err) => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
