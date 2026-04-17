// Slice 23 test: missing billing-contact health detector.
//
// Proves that active recurring contracts whose 3-layer
// resolveReminderRecipients fallback would return empty surface in
// the admin queue, and that contracts with any one of the three
// fallback layers populated stay silent.
//
// Eight assertion blocks:
//
//   1. active monthly contract, no contacts, no primary_contact_email,
//      no portal users → surfaces
//   2. active monthly contract + billing contact (receives_reminders=1)
//      → silent (layer 1 populated)
//   3. active monthly contract + primary_contact_email → silent
//      (layer 2 populated)
//   4. active monthly contract + portal user → silent (layer 3)
//   5. active one-time contract, bare → silent (cadence filter)
//   6. completed contract, bare → silent (status filter)
//   7. integration: loadAdminQueue exposes the new section,
//      counts.missing_billing_contact is set
//   8. integration: buildWorkSummary routes the section to actNow
//
// Isolation: six synthetic clients (A..F), one per scenario. Direct
// INSERT INTO clients avoids ZipKit cross-contamination since ZipKit
// already has portal users + primary_contact_email and would suppress
// every at-risk case. Each scenario's contract is provisioned via
// provisionContract, the auto-seeded generate_invoices job is
// deleted immediately so job state stays clean, and full teardown
// runs in try/finally.
//
// Run:
//   npx tsx scripts/phase1-test-slice23-billing-contact-health.ts

import 'dotenv/config';
import { createClient as createTursoClient } from '@libsql/client';
import { nanoid } from 'nanoid';
import { provisionContract, deleteContract } from '../src/lib/contracts';
import { createUser } from '../src/lib/auth';
import { loadAdminQueue } from '../src/lib/admin-queue';
import { loadMissingBillingContactSection } from '../src/lib/jobs/billing-contact-health';
import { buildWorkSummary } from '../src/lib/admin-work-summary';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) {
  console.error('TURSO_DATABASE_URL is not set');
  process.exit(1);
}
const db = createTursoClient({ url, authToken });

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
  const a = await db.execute({
    sql: `SELECT id FROM users WHERE role = 'admin' LIMIT 1`,
  });
  assert(a.rows.length > 0, 'no admin user present for created_by FK');
  return String(a.rows[0][0]);
}

async function provisionTestContract(params: {
  clientId: string;
  adminUserId: string;
  label: string;
  billing_cadence: 'monthly' | 'milestone' | 'one-time';
  status: 'active' | 'completed' | 'cancelled';
}): Promise<{ contract_id: string; scheduled_job_id: string | null }> {
  const p = await provisionContract({
    client_id: params.clientId,
    title: `slice-23-${params.label}`,
    type: params.billing_cadence === 'one-time' ? 'fixed' : 'retainer',
    billing_cadence: params.billing_cadence,
    billing_day: params.billing_cadence === 'monthly' ? 1 : undefined,
    recurring_amount: params.billing_cadence === 'monthly' ? 500 : undefined,
    payment_terms_days: 30,
    created_by: params.adminUserId,
  });
  // Force desired status — provisionContract defaults to draft.
  await db.execute({
    sql: `UPDATE contracts SET status = ? WHERE id = ?`,
    args: [params.status, p.contract_id],
  });
  // Delete the auto-seeded generate_invoices job so we don't pollute
  // scheduled_jobs with synthetic per-contract reminder chains.
  if (p.scheduled_job_id) {
    await db.execute({
      sql: 'DELETE FROM scheduled_jobs WHERE id = ?',
      args: [p.scheduled_job_id],
    });
  }
  return { contract_id: p.contract_id, scheduled_job_id: p.scheduled_job_id ?? null };
}

async function insertBillingContact(clientId: string, tag: string): Promise<string> {
  const id = nanoid();
  await db.execute({
    sql: `INSERT INTO contacts
          (id, client_id, name, email, roles_json, receives_invoices, receives_reminders)
          VALUES (?, ?, ?, ?, ?, 1, 1)`,
    args: [
      id,
      clientId,
      `Slice 23 Billing Contact ${tag}`,
      `slice23-contact-${tag}@example.test`,
      JSON.stringify(['billing']),
    ],
  });
  return id;
}

async function setClientPrimaryEmail(clientId: string, email: string): Promise<void> {
  await db.execute({
    sql: `UPDATE clients SET primary_contact_email = ? WHERE id = ?`,
    args: [email, clientId],
  });
}

async function cleanupContract(
  contractId: string,
  scheduledJobId: string | null
): Promise<void> {
  if (scheduledJobId) {
    await db.execute({
      sql: 'DELETE FROM scheduled_jobs WHERE id = ?',
      args: [scheduledJobId],
    });
  }
  // Any other jobs seeded under this contract_id (idempotent sweeps,
  // reminder sweeps, etc) — clear by payload_json pattern.
  await db.execute({
    sql: `DELETE FROM scheduled_jobs WHERE payload_json LIKE ?`,
    args: [`%"contract_id":"${contractId}"%`],
  });
  await db.execute({
    sql: 'DELETE FROM activity_log WHERE entity_type = ? AND entity_id = ?',
    args: ['contract', contractId],
  });
  try {
    await deleteContract(contractId);
  } catch {
    await db.execute({
      sql: `DELETE FROM milestones WHERE project_id IN (SELECT id FROM projects WHERE contract_id = ?)`,
      args: [contractId],
    });
    await db.execute({ sql: 'DELETE FROM projects WHERE contract_id = ?', args: [contractId] });
    await db.execute({ sql: 'DELETE FROM contracts WHERE id = ?', args: [contractId] });
  }
}

async function main() {
  console.log('=== Slice 23 test: missing billing-contact health ===\n');

  const adminUserId = await findAdminUserId();
  const tag = nanoid(6);

  // Six synthetic clients, one per scenario. Direct INSERT because
  // ZipKit already has portal users + primary_contact_email and
  // would mask every at-risk case.
  const clientIds: Record<string, string> = {
    A: nanoid(),
    B: nanoid(),
    C: nanoid(),
    D: nanoid(),
    E: nanoid(),
    F: nanoid(),
  };
  for (const [label, id] of Object.entries(clientIds)) {
    await db.execute({
      sql: `INSERT INTO clients (id, name, slug, active) VALUES (?, ?, ?, 1)`,
      args: [id, `Slice 23 Client ${label} ${tag}`, `slice-23-${label.toLowerCase()}-${tag}`],
    });
  }

  const tracked: {
    contracts: Array<{ id: string; jobId: string | null }>;
    contactIds: string[];
    userIds: string[];
  } = {
    contracts: [],
    contactIds: [],
    userIds: [],
  };

  try {
    // ----- Case A: active monthly, bare → surfaces -----
    const A = await provisionTestContract({
      clientId: clientIds.A,
      adminUserId,
      label: `A-${tag}`,
      billing_cadence: 'monthly',
      status: 'active',
    });
    tracked.contracts.push({ id: A.contract_id, jobId: A.scheduled_job_id });

    // ----- Case B: active monthly + billing contact → silent -----
    const B = await provisionTestContract({
      clientId: clientIds.B,
      adminUserId,
      label: `B-${tag}`,
      billing_cadence: 'monthly',
      status: 'active',
    });
    tracked.contracts.push({ id: B.contract_id, jobId: B.scheduled_job_id });
    tracked.contactIds.push(await insertBillingContact(clientIds.B, tag));

    // ----- Case C: active monthly + primary_contact_email → silent -----
    const C = await provisionTestContract({
      clientId: clientIds.C,
      adminUserId,
      label: `C-${tag}`,
      billing_cadence: 'monthly',
      status: 'active',
    });
    tracked.contracts.push({ id: C.contract_id, jobId: C.scheduled_job_id });
    await setClientPrimaryEmail(clientIds.C, `slice23-primary-${tag}@example.test`);

    // ----- Case D: active monthly + portal user → silent -----
    const D = await provisionTestContract({
      clientId: clientIds.D,
      adminUserId,
      label: `D-${tag}`,
      billing_cadence: 'monthly',
      status: 'active',
    });
    tracked.contracts.push({ id: D.contract_id, jobId: D.scheduled_job_id });
    tracked.userIds.push(
      await createUser(
        `slice23-portal-${tag}@example.test`,
        `Slice 23 Portal User ${tag}`,
        'client',
        clientIds.D
      )
    );

    // ----- Case E: active one-time, bare → silent (cadence filter) -----
    const E = await provisionTestContract({
      clientId: clientIds.E,
      adminUserId,
      label: `E-${tag}`,
      billing_cadence: 'one-time',
      status: 'active',
    });
    tracked.contracts.push({ id: E.contract_id, jobId: E.scheduled_job_id });

    // ----- Case F: completed monthly, bare → silent (status filter) -----
    const F = await provisionTestContract({
      clientId: clientIds.F,
      adminUserId,
      label: `F-${tag}`,
      billing_cadence: 'monthly',
      status: 'completed',
    });
    tracked.contracts.push({ id: F.contract_id, jobId: F.scheduled_job_id });

    const allTestContractIds = tracked.contracts.map((c) => c.id);

    // Load the section directly for precise assertions.
    const section = await loadMissingBillingContactSection();
    eq(section.key, 'missing_billing_contact', 'section key');
    eq(section.label, 'Contracts with no reminder route', 'section label');
    assert(Array.isArray(section.rows), 'rows array');

    const testRows = section.rows.filter((r) => allTestContractIds.includes(r.id));

    // -------------------------------------------------------------
    // 23.1 — bare active monthly surfaces
    // -------------------------------------------------------------
    console.log('--- 23.1 bare active monthly surfaces ---');
    const rA = testRows.find((r) => r.id === A.contract_id);
    assert(rA, 'case A row present');
    assert(/monthly/i.test(rA!.what), `case A what names the cadence: ${rA!.what}`);
    assert(
      /no reminder route/i.test(rA!.what) || /no .+ route/i.test(rA!.what),
      `case A what mentions the missing route: ${rA!.what}`
    );
    assert(
      /no billing contact/i.test(rA!.why),
      `case A why mentions missing billing contact: ${rA!.why}`
    );
    assert(
      /no primary contact email/i.test(rA!.why),
      `case A why mentions missing primary contact email: ${rA!.why}`
    );
    assert(
      /no portal user/i.test(rA!.why),
      `case A why mentions missing portal user: ${rA!.why}`
    );
    eq(rA!.link, '/portal/admin/contracts', 'case A link');
    assert(
      /Slice 23 Client A/.test(rA!.where),
      `case A where names client: ${rA!.where}`
    );
    console.log('  OK\n');

    // -------------------------------------------------------------
    // 23.2 — active monthly + billing contact stays silent
    // -------------------------------------------------------------
    console.log('--- 23.2 billing contact present → silent ---');
    const rB = testRows.find((r) => r.id === B.contract_id);
    eq(rB, undefined, 'case B billing contact suppresses row');
    console.log('  OK\n');

    // -------------------------------------------------------------
    // 23.3 — primary_contact_email populated → silent
    // -------------------------------------------------------------
    console.log('--- 23.3 primary_contact_email present → silent ---');
    const rC = testRows.find((r) => r.id === C.contract_id);
    eq(rC, undefined, 'case C primary_contact_email suppresses row');
    console.log('  OK\n');

    // -------------------------------------------------------------
    // 23.4 — portal user populated → silent
    // -------------------------------------------------------------
    console.log('--- 23.4 portal user present → silent ---');
    const rD = testRows.find((r) => r.id === D.contract_id);
    eq(rD, undefined, 'case D portal user suppresses row');
    console.log('  OK\n');

    // -------------------------------------------------------------
    // 23.5 — one-time contract silent by cadence filter
    // -------------------------------------------------------------
    console.log('--- 23.5 one-time cadence → silent ---');
    const rE = testRows.find((r) => r.id === E.contract_id);
    eq(rE, undefined, 'case E one-time contract excluded by cadence filter');
    console.log('  OK\n');

    // -------------------------------------------------------------
    // 23.6 — completed contract silent by status filter
    // -------------------------------------------------------------
    console.log('--- 23.6 completed status → silent ---');
    const rF = testRows.find((r) => r.id === F.contract_id);
    eq(rF, undefined, 'case F completed contract excluded by status filter');
    console.log('  OK\n');

    // -------------------------------------------------------------
    // 23.7 — integration: loadAdminQueue composes the section
    // -------------------------------------------------------------
    console.log('--- 23.7 loadAdminQueue exposes missing_billing_contact ---');
    const queue = await loadAdminQueue();
    const composed = queue.sections.find((s) => s.key === 'missing_billing_contact');
    assert(composed, 'missing_billing_contact present in loadAdminQueue');
    assert(
      typeof queue.counts.missing_billing_contact === 'number',
      'queue.counts.missing_billing_contact is set'
    );
    const composedTestRows = composed!.rows.filter((r) =>
      allTestContractIds.includes(r.id)
    );
    eq(
      composedTestRows.length,
      1,
      'exactly one of our six test contracts surfaces (case A)'
    );
    eq(composedTestRows[0]!.id, A.contract_id, 'composed row is case A');
    // Existing sections still present — additive, not replacement.
    assert(
      queue.sections.find((s) => s.key === 'google_sync_attention'),
      'google_sync_attention still present'
    );
    assert(
      queue.sections.find((s) => s.key === 'csv_source_attention'),
      'csv_source_attention still present'
    );
    console.log('  OK\n');

    // -------------------------------------------------------------
    // 23.8 — integration: buildWorkSummary routes to actNow
    // -------------------------------------------------------------
    console.log('--- 23.8 buildWorkSummary routes missing_billing_contact to actNow ---');
    const summary = buildWorkSummary(queue);
    const inActNow = summary.actNow.find(
      (i) => i.anchor === '#missing_billing_contact'
    );
    assert(inActNow, 'missing_billing_contact item present in actNow bucket');
    eq(inActNow!.label, 'contracts with no reminder route', 'actNow item label');
    assert(inActNow!.count >= 1, `actNow count includes at least case A: got ${inActNow!.count}`);
    // Not in waiting or upcoming
    assert(
      !summary.waiting.find((i) => i.anchor === '#missing_billing_contact'),
      'missing_billing_contact not in waiting bucket'
    );
    assert(
      !summary.upcoming.find((i) => i.anchor === '#missing_billing_contact'),
      'missing_billing_contact not in upcoming bucket'
    );
    console.log('  OK\n');
  } finally {
    // --- Cleanup ---
    // 1. Contracts (+ their projects, milestones, bindings, jobs, activity)
    for (const c of tracked.contracts) {
      try {
        await cleanupContract(c.id, c.jobId);
      } catch {}
    }
    // 2. Contacts
    for (const id of tracked.contactIds) {
      try {
        await db.execute({ sql: 'DELETE FROM contacts WHERE id = ?', args: [id] });
      } catch {}
    }
    // 3. Portal users (+ any sessions/magic links that might reference them)
    for (const id of tracked.userIds) {
      try {
        await db.execute({ sql: 'DELETE FROM sessions WHERE user_id = ?', args: [id] });
      } catch {}
      try {
        await db.execute({ sql: 'DELETE FROM magic_links WHERE user_id = ?', args: [id] });
      } catch {}
      try {
        await db.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [id] });
      } catch {}
    }
    // 4. Synthetic clients (belt-and-braces any stragglers first)
    for (const id of Object.values(clientIds)) {
      try {
        await db.execute({ sql: 'DELETE FROM contacts WHERE client_id = ?', args: [id] });
        await db.execute({ sql: 'DELETE FROM users WHERE client_id = ?', args: [id] });
        await db.execute({ sql: 'DELETE FROM periods WHERE client_id = ?', args: [id] });
        await db.execute({ sql: 'DELETE FROM clients WHERE id = ?', args: [id] });
      } catch {}
    }
  }

  console.log('SLICE 23 TEST PASSED ✓');
}

main().catch((err) => {
  console.error();
  console.error('SLICE 23 TEST FAILED:', err);
  process.exit(1);
});
