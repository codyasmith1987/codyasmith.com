// Phase 1 follow-up — backfill the live ZipKit Homes contract into the
// new spine, and fix the KipKit/ZipKit typo on forward-propagating fields
// in the same transaction.
//
// Context:
//   - Client: ZipKit Homes (id oYLqVOgsutCEPNwb7hizm) — correct already.
//   - Contract: "KipKit Homes WM" (id NbbkoOfng4ehMcUp9kYOA) — mistyped.
//     This contract predates provisionContract, so it has no project row,
//     no scheduled generate_invoices job, and its title typo will
//     re-propagate into every future invoice line item via
//     generateInvoiceForContract.
//
// What this script does, in a single transaction:
//
//   1. Rename contracts.title from "KipKit Homes WM" to "ZipKit Homes WM".
//   2. Rewrite the existing invoice_items.description on INV-2026-0001 so
//      the one already-created line item reflects the corrected title.
//      (The invoice is still 'draft' so correcting it is safe.)
//   3. Update clients.primary_url = 'https://zipkithomes.com'.
//      Leave brand_accent and primary_contact_email NULL.
//      reading_level_target stays at the schema default of 7.
//   4. Insert a default project shell tied to the contract.
//   5. Enqueue exactly one pending generate_invoices scheduled_jobs row
//      for the next billing cycle (UTC), using nextBillingRunIso(9).
//   6. Write one activity_log entry with action='backfilled' documenting
//      the change.
//
// Historical activity_log rows that quote "KipKit Homes WM" are NOT
// rewritten. The typo was real at the time; history stays honest.
//
// Idempotency preflights — aborts with a clear error if any of these
// are already in the target state:
//   - contract not found / not active
//   - contract.title already equals the corrected title
//   - a project row already exists for the contract
//   - a pending or running generate_invoices job already references the
//     contract in its payload
//   - clients.primary_url is already non-null
//
// Run:
//   npx tsx scripts/phase1-backfill-zipkit.ts --dry-run
//   npx tsx scripts/phase1-backfill-zipkit.ts --apply

import 'dotenv/config';
import { createClient } from '@libsql/client';
import { nanoid } from 'nanoid';

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

// Pinned live ids — discovered during the identity drift audit.
const CLIENT_ID = 'oYLqVOgsutCEPNwb7hizm';  // ZipKit Homes
const CONTRACT_ID = 'NbbkoOfng4ehMcUp9kYOA'; // currently titled "KipKit Homes WM"
const OLD_TITLE = 'KipKit Homes WM';
const NEW_TITLE = 'ZipKit Homes WM';
const NEW_PRIMARY_URL = 'https://zipkithomes.com';

// Import nextBillingRunIso via dynamic import (Turso env fallback handles tsx).
const { nextBillingRunIso } = await import('../src/lib/contracts');

async function getAdminId(): Promise<string> {
  const r = await db.execute("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  if (r.rows.length === 0) throw new Error('No admin user found');
  return r.rows[0][0] as string;
}

interface Row1<T = any> { [k: string]: T }
async function one(sql: string, args: any[] = []): Promise<Row1 | null> {
  const r = await db.execute({ sql, args });
  if (r.rows.length === 0) return null;
  const o: Row1 = {};
  r.columns.forEach((c, i) => (o[c] = r.rows[0][i]));
  return o;
}

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY-RUN' : 'APPLY'}`);
  console.log();

  // --- Preflight: verify the live state matches expectations ---
  console.log('=== Preflight ===');

  const client = await one('SELECT id, name, slug, primary_url FROM clients WHERE id = ?', [CLIENT_ID]);
  if (!client) { console.error('ABORT: client not found'); process.exit(2); }
  console.log(`  client:    ${client.name} (slug=${client.slug}, primary_url=${client.primary_url ?? 'NULL'})`);

  const contract = await one(
    'SELECT id, client_id, title, status, billing_cadence, billing_day, recurring_amount FROM contracts WHERE id = ?',
    [CONTRACT_ID]
  );
  if (!contract) { console.error('ABORT: contract not found'); process.exit(2); }
  if (contract.client_id !== CLIENT_ID) {
    console.error(`ABORT: contract client_id mismatch: ${contract.client_id} != ${CLIENT_ID}`);
    process.exit(2);
  }
  console.log(`  contract:  "${contract.title}" status=${contract.status} cadence=${contract.billing_cadence} day=${contract.billing_day} amount=${contract.recurring_amount}`);
  if (contract.status !== 'active') {
    console.error(`ABORT: contract status=${contract.status}, expected 'active'`);
    process.exit(2);
  }

  // Idempotency: is there already a project row?
  const project = await one('SELECT id FROM projects WHERE contract_id = ? LIMIT 1', [CONTRACT_ID]);
  if (project) {
    console.error(`ABORT: project row already exists for this contract (id=${project.id}). Backfill already ran.`);
    process.exit(3);
  }
  console.log('  project:   NONE (will create)');

  // Idempotency: existing pending/running scheduled_jobs for this contract?
  const existingJob = await db.execute({
    sql: `SELECT id FROM scheduled_jobs
          WHERE job_type = 'generate_invoices'
            AND status IN ('pending', 'running')
            AND payload_json LIKE ?
          LIMIT 1`,
    args: [`%"contract_id":"${CONTRACT_ID}"%`],
  });
  if (existingJob.rows.length > 0) {
    console.error(`ABORT: a generate_invoices scheduled_job already exists for this contract (id=${existingJob.rows[0][0]}). Backfill already ran.`);
    process.exit(3);
  }
  console.log('  scheduled_jobs: NONE for this contract (will enqueue one)');

  // Idempotency: client.primary_url must be null (preserve any user edit).
  if (client.primary_url !== null) {
    console.error(`ABORT: clients.primary_url already set to "${client.primary_url}". Will not overwrite.`);
    process.exit(3);
  }

  // Title sanity: don't rename if already corrected.
  const willRename = contract.title === OLD_TITLE;
  if (contract.title !== OLD_TITLE && contract.title !== NEW_TITLE) {
    console.error(`ABORT: unexpected contract.title "${contract.title}". Expected "${OLD_TITLE}" or "${NEW_TITLE}".`);
    process.exit(3);
  }
  console.log(`  rename:    ${willRename ? `YES ("${OLD_TITLE}" → "${NEW_TITLE}")` : 'NO (already corrected)'}`);

  // If renaming, also plan the invoice_items fix.
  const affectedItems = willRename
    ? (await db.execute({
        sql: `SELECT id, invoice_id, description FROM invoice_items WHERE description = ?`,
        args: [`${OLD_TITLE} (2026-04-09 to 2026-05-08)`],
      })).rows.map((r) => ({ id: r[0] as string, invoice_id: r[1] as string, description: r[2] as string }))
    : [];
  if (willRename) {
    console.log(`  invoice_items to rewrite: ${affectedItems.length}`);
    for (const it of affectedItems) console.log(`    - ${it.id} on invoice ${it.invoice_id}: "${it.description}"`);
  }

  // Resolve admin id for activity_log.
  const adminId = await getAdminId();
  console.log(`  admin:     ${adminId}`);

  // Compute the scheduled_for deterministically — UTC only.
  const scheduledFor = nextBillingRunIso(contract.billing_day as number);
  console.log(`  next billing run (UTC): ${scheduledFor}`);
  console.log();

  // --- Plan summary ---
  console.log('=== Planned writes ===');
  if (willRename) {
    console.log(`  1. UPDATE contracts SET title = '${NEW_TITLE}' WHERE id = '${CONTRACT_ID}'`);
    for (const it of affectedItems) {
      const newDesc = it.description.replace(OLD_TITLE, NEW_TITLE);
      console.log(`  2. UPDATE invoice_items SET description = '${newDesc}' WHERE id = '${it.id}'`);
    }
  } else {
    console.log('  1. (rename skipped)');
  }
  console.log(`  3. UPDATE clients SET primary_url = '${NEW_PRIMARY_URL}' WHERE id = '${CLIENT_ID}'`);
  console.log(`  4. INSERT INTO projects (contract_id=${CONTRACT_ID}, client_id=${CLIENT_ID}, title='${NEW_TITLE} — ongoing', status='in_progress', client_visible=1)`);
  console.log(`  5. INSERT INTO scheduled_jobs (job_type='generate_invoices', status='pending', scheduled_for='${scheduledFor}', payload_json={created_by,contract_id,note:'backfill'})`);
  console.log(`  6. INSERT INTO activity_log (action='backfilled', entity_type='contract', entity_id='${CONTRACT_ID}', summary='ZipKit contract backfilled into new spine (title fix + project shell + first billing job + client identity)')`);
  console.log();
  console.log(`  NOT touched: clients.brand_accent (NULL), clients.primary_contact_email (NULL), historical activity_log rows quoting old title, INV-2026-0002 phantom, leaked test notifications`);
  console.log();

  if (DRY_RUN) {
    console.log('Dry run complete. No rows written.');
    return;
  }

  // --- Apply ---
  console.log('Applying in transaction...');
  const tx = await db.transaction('write');
  try {
    if (willRename) {
      await tx.execute({
        sql: `UPDATE contracts SET title = ?, updated_at = datetime('now') WHERE id = ?`,
        args: [NEW_TITLE, CONTRACT_ID],
      });
      for (const it of affectedItems) {
        const newDesc = it.description.replace(OLD_TITLE, NEW_TITLE);
        await tx.execute({
          sql: `UPDATE invoice_items SET description = ? WHERE id = ?`,
          args: [newDesc, it.id],
        });
      }
    }

    await tx.execute({
      sql: `UPDATE clients SET primary_url = ? WHERE id = ?`,
      args: [NEW_PRIMARY_URL, CLIENT_ID],
    });

    const projectId = nanoid();
    await tx.execute({
      sql: `INSERT INTO projects
            (id, contract_id, client_id, title, description, status, sort_order, client_visible)
            VALUES (?, ?, ?, ?, ?, 'in_progress', 0, 1)`,
      args: [
        projectId,
        CONTRACT_ID,
        CLIENT_ID,
        `${NEW_TITLE} — ongoing`,
        'Project shell backfilled during Phase 1 spine backfill.',
      ],
    });

    const jobId = nanoid();
    await tx.execute({
      sql: `INSERT INTO scheduled_jobs
            (id, job_type, scheduled_for, status, payload_json)
            VALUES (?, 'generate_invoices', ?, 'pending', ?)`,
      args: [
        jobId,
        scheduledFor,
        JSON.stringify({ created_by: adminId, contract_id: CONTRACT_ID, note: 'backfill' }),
      ],
    });

    const activityId = nanoid();
    await tx.execute({
      sql: `INSERT INTO activity_log
            (id, client_id, user_id, action, entity_type, entity_id, summary)
            VALUES (?, ?, ?, 'backfilled', 'contract', ?, ?)`,
      args: [
        activityId,
        CLIENT_ID,
        adminId,
        CONTRACT_ID,
        `ZipKit contract backfilled into new spine (title fix${willRename ? '' : ' already applied'}, project shell, first billing job ${scheduledFor}, primary_url set)`,
      ],
    });

    await tx.commit();
    console.log('Commit OK.');
  } catch (err) {
    await tx.rollback();
    console.error('ROLLED BACK:', err);
    process.exit(4);
  }

  // Post-verify.
  console.log();
  console.log('=== Post-apply verification ===');
  const c2 = await one('SELECT title FROM contracts WHERE id = ?', [CONTRACT_ID]);
  const cl2 = await one('SELECT primary_url FROM clients WHERE id = ?', [CLIENT_ID]);
  const proj = await one('SELECT id, title FROM projects WHERE contract_id = ?', [CONTRACT_ID]);
  const job = (
    await db.execute({
      sql: "SELECT id, scheduled_for, status FROM scheduled_jobs WHERE payload_json LIKE ? AND status = 'pending'",
      args: [`%"contract_id":"${CONTRACT_ID}"%`],
    })
  ).rows.map((r) => ({ id: r[0], scheduled_for: r[1], status: r[2] }));
  const act = await one(
    "SELECT id, summary FROM activity_log WHERE entity_id = ? AND action = 'backfilled'",
    [CONTRACT_ID]
  );

  console.log(`  contracts.title:        ${c2?.title}`);
  console.log(`  clients.primary_url:    ${cl2?.primary_url}`);
  console.log(`  projects row:           ${proj ? proj.id + ' / ' + proj.title : 'MISSING'}`);
  console.log(`  scheduled_jobs pending: ${job.length === 1 ? job[0].id + ' @ ' + job[0].scheduled_for : 'WRONG COUNT: ' + job.length}`);
  console.log(`  activity_log entry:     ${act ? 'present' : 'MISSING'}`);

  const clean = c2?.title === NEW_TITLE && cl2?.primary_url === NEW_PRIMARY_URL && proj && job.length === 1 && act;
  if (!clean) {
    console.error('VERIFICATION FAILED');
    process.exit(5);
  }
  console.log();
  console.log('Backfill complete. Live contract is now on the new spine.');
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
