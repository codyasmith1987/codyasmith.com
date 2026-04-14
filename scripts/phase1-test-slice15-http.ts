// Slice 15 — browser-side verification via real HTTP round-trips.
//
// This test mints a real admin session against the running dev
// server, extracts the CSRF token from the actual rendered wizard
// HTML, and POSTs the three envelope shapes the wizard would emit
// under each UX path:
//
//   1. One-contract existing-client  — `contracts: [singleBlock]`
//   2. Multi-contract existing-client — `contracts: [b1, b2]`
//   3. New-client + multi-contract    — `new_client + contracts: [b1, b2]`
//
// The goal is to prove that the wizard's request envelope is
// correctly shaped AND that the server interprets it correctly AND
// that the CSRF + session middleware lets an authenticated admin
// through. This is the highest fidelity proof I can produce without
// a real browser click-through.
//
// Prerequisite: `npm run dev` must be running on port 4321.
//
// What this test DOES NOT cover:
//   - the wizard's visual layout / Tailwind classes
//   - "save & add another" click behavior (form reset, focus,
//     scroll) — pure DOM events
//   - review step rendering — HTML is constructed in JS via
//     innerHTML and requires a real DOM to observe
//   - partial-failure toast behavior — requires the fault-injection
//     hook which lives inside the library and cannot be reached from
//     the wizard UI without adding a test-only wizard flag. The
//     partial-failure case is already covered by
//     phase1-test-multi-contract-intake.ts.
//
// Run:
//   npx tsx scripts/phase1-test-slice15-http.ts

import 'dotenv/config';
import { createClient as createTurso } from '@libsql/client';
import { nanoid } from 'nanoid';
import { createSession } from '../src/lib/auth';
import { deleteContract } from '../src/lib/contracts';

const BASE_URL = 'http://localhost:4321';
const SESSION_COOKIE_NAME = 'portal_session';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) {
  console.error('TURSO_DATABASE_URL is not set');
  process.exit(1);
}
const db = createTurso({ url, authToken });

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

async function getAdminUserId(): Promise<string> {
  const r = await db.execute({ sql: `SELECT id FROM users WHERE role = 'admin' LIMIT 1` });
  assert(r.rows.length > 0, 'no admin user');
  return String(r.rows[0][0]);
}

// Creates a synthetic client row under a tagged slug. Returns the id.
async function createSyntheticClient(tag: string): Promise<string> {
  const id = nanoid();
  await db.execute({
    sql: `INSERT INTO clients (id, name, slug) VALUES (?, ?, ?)`,
    args: [id, `slice15-http-${tag}`, `slice15-http-${tag}`],
  });
  return id;
}

async function cleanupClient(clientId: string) {
  const contracts = await db.execute({
    sql: 'SELECT id FROM contracts WHERE client_id = ?',
    args: [clientId],
  });
  for (const row of contracts.rows) {
    const cid = String(row[0]);
    await db.execute({
      sql: 'DELETE FROM data_source_bindings WHERE contract_id = ?',
      args: [cid],
    });
    await db.execute({
      sql: 'DELETE FROM scheduled_jobs WHERE payload_json LIKE ?',
      args: [`%"contract_id":"${cid}"%`],
    });
    await db.execute({
      sql: 'DELETE FROM activity_log WHERE entity_type = ? AND entity_id = ?',
      args: ['contract', cid],
    });
    try {
      await deleteContract(cid);
    } catch {
      await db.execute({
        sql: `DELETE FROM milestones WHERE project_id IN (SELECT id FROM projects WHERE contract_id = ?)`,
        args: [cid],
      });
      await db.execute({
        sql: 'DELETE FROM projects WHERE contract_id = ?',
        args: [cid],
      });
      await db.execute({ sql: 'DELETE FROM contracts WHERE id = ?', args: [cid] });
    }
  }
  await db.execute({ sql: 'DELETE FROM contacts WHERE client_id = ?', args: [clientId] });
  await db.execute({ sql: 'DELETE FROM activity_log WHERE client_id = ?', args: [clientId] });
  await db.execute({ sql: 'DELETE FROM clients WHERE id = ?', args: [clientId] });
}

// Parse the CSRF token out of the rendered wizard page. The Portal
// layout injects it as <meta name="csrf-token" content="...">.
function extractCsrfToken(html: string): string | null {
  const m = html.match(/<meta\s+name="csrf-token"\s+content="([^"]*)"/);
  return m ? m[1] : null;
}

// Scans the rendered wizard HTML for the Slice 15 UI elements. If
// the wizard file got rewritten but missed one of these hooks the
// static scan catches it before any POST runs.
//
// NOTE: category rows and contact rows are created at runtime by
// JS factories (triggered by "+ add category" / "+ add contact"
// buttons). The initial HTML only contains the empty host divs and
// the add buttons — the `data-wiz-category-row` / `data-wiz-contact-row`
// dataset attributes appear only after a click. The scan probes for
// the static host elements, not the dynamic children.
function verifyWizardElements(html: string): string[] {
  const issues: string[] = [];
  const required = [
    { needle: 'id="wiz-save-add-another"', label: '"save & add another" button' },
    { needle: 'id="wiz-staged-blocks"', label: 'staged blocks list container' },
    { needle: 'id="wiz-add-category"', label: '"+ add category" button' },
    { needle: 'id="wiz-passthrough-categories"', label: 'passthrough categories host div' },
    { needle: 'id="wiz-add-contact"', label: '"+ add contact" button' },
    { needle: 'id="wiz-contacts-host"', label: 'contacts host div' },
    { needle: 'data-wiz-source', label: 'data source checkboxes' },
    { needle: 'data-wiz-module', label: 'module checklist' },
    { needle: 'id="wiz-title"', label: 'contract title input' },
    { needle: 'id="wiz-submit"', label: 'submit button' },
    { needle: 'id="wiz-review"', label: 'review host' },
    { needle: 'data-step-label="5"', label: '6-step stepper (step index 5 = review)' },
  ];
  for (const r of required) {
    if (!html.includes(r.needle)) issues.push(`missing ${r.label} (${r.needle})`);
  }
  return issues;
}

async function main() {
  console.log('=== Slice 15 HTTP verification ===');
  console.log();

  // Preflight — server must be up.
  try {
    const ping = await fetch(`${BASE_URL}/portal/login`);
    assert(ping.status === 200 || ping.status === 302, 'dev server not responding at :4321');
    console.log(`  dev server responding (${ping.status} on /portal/login)`);
  } catch (err) {
    console.error('ABORT: dev server not responding. Is `npm run dev` running?');
    throw err;
  }

  // Mint an admin session.
  const adminUserId = await getAdminUserId();
  const sessionToken = await createSession(adminUserId);
  const cookieHeader = `${SESSION_COOKIE_NAME}=${sessionToken}`;
  console.log(`  session minted for admin user ${adminUserId.slice(0, 10)}...`);

  // GET the wizard page to (a) verify the session works and the
  // module gate doesn't block admins, (b) pull the live CSRF token,
  // (c) statically scan the HTML for required Slice 15 UI hooks.
  const wizardRes = await fetch(`${BASE_URL}/portal/admin/contracts`, {
    headers: { Cookie: cookieHeader },
  });
  eq(wizardRes.status, 200, 'wizard GET status');
  const wizardHtml = await wizardRes.text();

  const issues = verifyWizardElements(wizardHtml);
  if (issues.length > 0) {
    console.error('ABORT: wizard HTML missing required Slice 15 elements:');
    for (const i of issues) console.error('  - ' + i);
    throw new Error('wizard HTML incomplete');
  }
  console.log('  wizard HTML has all Slice 15 UI hooks');

  const csrfToken = extractCsrfToken(wizardHtml);
  assert(csrfToken && csrfToken.length > 0, 'CSRF token present in wizard page');
  console.log(`  CSRF token extracted (${csrfToken!.length} chars)`);
  console.log();

  // ------------ Test 1: one-contract existing-client envelope ------------
  console.log('--- test 1: one-contract envelope ---');
  const client1Id = await createSyntheticClient(`t1-${nanoid(5)}`);
  try {
    const envelope1 = {
      client_id: client1Id,
      data_sources: [{ source: 'gsc', enabled: true }],
      contracts: [
        {
          title: 'slice15-http-t1-single',
          type: 'retainer',
          service_type: 'web_management',
          billing_cadence: 'monthly',
          billing_day: 15,
          recurring_amount: 400,
        },
      ],
    };
    const r1 = await fetch(`${BASE_URL}/portal/api/admin/contracts/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader,
        'X-CSRF-Token': csrfToken!,
      },
      body: JSON.stringify(envelope1),
    });
    eq(r1.status, 201, 't1 status');
    const data1 = await r1.json();
    eq(data1.success_count, 1, 't1 success_count');
    eq(data1.failure_count, 0, 't1 failure_count');
    eq(data1.contracts.length, 1, 't1 contracts length');
    const block1 = data1.contracts[0];
    eq(block1.success, true, 't1 block success');
    eq(block1.milestone_ids.length, 4, 't1 4 web_management milestones');
    eq(block1.binding_ids.length, 1, 't1 1 gsc binding');
    console.log(`  OK — contract ${block1.contract_id.slice(0, 10)}... with ${block1.milestone_ids.length} milestones`);
  } finally {
    await cleanupClient(client1Id);
  }
  console.log();

  // ------------ Test 2: multi-contract existing-client envelope ------------
  console.log('--- test 2: multi-contract envelope ---');
  const client2Id = await createSyntheticClient(`t2-${nanoid(5)}`);
  try {
    const envelope2 = {
      client_id: client2Id,
      data_sources: [
        { source: 'gsc', enabled: true },
        { source: 'ubersuggest_position_tracking', enabled: true },
      ],
      contracts: [
        {
          title: 'slice15-http-t2-retainer',
          type: 'retainer',
          service_type: 'web_management',
          billing_cadence: 'monthly',
          billing_day: 1,
          recurring_amount: 900,
        },
        {
          title: 'slice15-http-t2-project',
          type: 'fixed',
          service_type: 'consulting',
          total_value: 6000,
        },
      ],
    };
    const r2 = await fetch(`${BASE_URL}/portal/api/admin/contracts/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader,
        'X-CSRF-Token': csrfToken!,
      },
      body: JSON.stringify(envelope2),
    });
    eq(r2.status, 201, 't2 status');
    const data2 = await r2.json();
    eq(data2.success_count, 2, 't2 success_count');
    eq(data2.failure_count, 0, 't2 failure_count');

    const [blk1, blk2] = data2.contracts;
    eq(blk1.success, true, 't2 b1 success');
    eq(blk2.success, true, 't2 b2 success');
    eq(blk1.binding_ids.length, 2, 't2 b1 2 bindings');
    eq(blk2.binding_ids.length, 2, 't2 b2 2 bindings');
    eq(blk1.milestone_ids.length, 4, 't2 b1 web_management milestones');
    eq(blk2.milestone_ids.length, 4, 't2 b2 consulting milestones');
    console.log(`  OK — 2 contracts, 2 bindings each, milestones per service_type`);
  } finally {
    await cleanupClient(client2Id);
  }
  console.log();

  // ------------ Test 3: new-client envelope ------------
  // The POST handler's new_client.slug validator only accepts
  // lowercase letters, numbers, and hyphens. Nanoid's default
  // alphabet includes uppercase, so we force a lowercase base-36
  // tag here to satisfy the validator.
  console.log('--- test 3: new-client + multi-contract envelope ---');
  const tag3 = Math.random().toString(36).slice(2, 8);
  const slug3 = `slice15-http-t3-${tag3}`;
  let createdClientId: string | null = null;
  try {
    const envelope3 = {
      new_client: { name: `slice15 http ${tag3}`, slug: slug3 },
      client_profile: {
        primary_url: 'https://http-test.example.com',
        primary_contact_email: 'owner@http-test.example',
        brand_accent: '#22c55e',
        reading_level_target: 7,
      },
      contacts: [
        {
          name: 'HTTP Billing',
          email: `billing-${tag3}@test.example`,
          roles: ['billing'],
          receives_invoices: true,
          receives_reminders: true,
        },
        {
          name: 'HTTP Tech',
          email: `tech-${tag3}@test.example`,
          roles: ['technical', 'approval'],
        },
      ],
      data_sources: [{ source: 'screaming_frog_issues', enabled: false }],
      contracts: [
        {
          title: 'slice15-http-t3-retainer',
          type: 'retainer',
          service_type: 'hybrid',
          billing_cadence: 'monthly',
          billing_day: 9,
          recurring_amount: 600,
          modules: ['dashboard', 'rankings', 'files'],
        },
        {
          title: 'slice15-http-t3-audit',
          type: 'fixed',
          service_type: 'consulting',
          total_value: 2500,
        },
      ],
    };

    const r3 = await fetch(`${BASE_URL}/portal/api/admin/contracts/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader,
        'X-CSRF-Token': csrfToken!,
      },
      body: JSON.stringify(envelope3),
    });
    if (r3.status !== 201) {
      const errText = await r3.text();
      console.error(`  t3 status ${r3.status} body: ${errText}`);
    }
    eq(r3.status, 201, 't3 status');
    const data3 = await r3.json();
    eq(data3.client_created, true, 't3 client_created');
    createdClientId = data3.client_id;
    eq(data3.success_count, 2, 't3 success_count');
    eq(data3.failure_count, 0, 't3 failure_count');
    eq(data3.contact_ids.length, 2, 't3 2 contact ids');
    eq(
      data3.client_profile_fields_updated.length,
      4,
      't3 all 4 profile fields written'
    );

    // Verify DB state for the new client
    const profile = await db.execute({
      sql: 'SELECT primary_url, brand_accent FROM clients WHERE id = ?',
      args: [data3.client_id],
    });
    eq(
      String(profile.rows[0][0]),
      'https://http-test.example.com',
      't3 primary_url persisted'
    );
    eq(String(profile.rows[0][1]), '#22c55e', 't3 brand_accent persisted');

    const contacts = await db.execute({
      sql: 'SELECT COUNT(*) FROM contacts WHERE client_id = ?',
      args: [data3.client_id],
    });
    eq(Number(contacts.rows[0][0]), 2, 't3 contacts seeded once');

    const ccount = await db.execute({
      sql: 'SELECT COUNT(*) FROM contracts WHERE client_id = ?',
      args: [data3.client_id],
    });
    eq(Number(ccount.rows[0][0]), 2, 't3 2 contract rows');

    const bindingCount = await db.execute({
      sql: `SELECT COUNT(*) FROM data_source_bindings
            WHERE contract_id IN (SELECT id FROM contracts WHERE client_id = ?)`,
      args: [data3.client_id],
    });
    eq(Number(bindingCount.rows[0][0]), 2, 't3 1 binding per contract x 2 contracts');

    console.log(
      `  OK — new client ${slug3}, profile ${data3.client_profile_fields_updated.length}/4 fields, 2 contacts, 2 contracts, ${bindingCount.rows[0][0]} bindings`
    );
  } finally {
    if (createdClientId) await cleanupClient(createdClientId);
  }
  console.log();

  // ------------ Test 4: CSRF enforcement still works ------------
  console.log('--- test 4: CSRF enforcement ---');
  const clientCsrfId = await createSyntheticClient(`csrf-${nanoid(5)}`);
  try {
    const envelope4 = {
      client_id: clientCsrfId,
      contracts: [{ title: 'slice15-http-csrf-fail', type: 'fixed' }],
    };
    // Omit the CSRF header — must get 403 from the middleware.
    const r4 = await fetch(`${BASE_URL}/portal/api/admin/contracts/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader,
      },
      body: JSON.stringify(envelope4),
    });
    eq(r4.status, 403, 't4 no-CSRF status 403');
    const body4 = await r4.json();
    assert(/CSRF/i.test(body4.error), 't4 error mentions CSRF');
    console.log('  OK — request without CSRF token rejected');
  } finally {
    await cleanupClient(clientCsrfId);
  }
  console.log();

  // Cleanup the test session we minted.
  await db.execute({
    sql: 'DELETE FROM sessions WHERE user_id = ? AND expires_at > datetime(\'now\', \'+25 days\')',
    args: [adminUserId],
  });
  console.log('  test session revoked');
  console.log();

  console.log('SLICE 15 HTTP VERIFICATION PASSED ✓');
}

main().catch((err) => {
  console.error();
  console.error('SLICE 15 HTTP VERIFICATION FAILED:', err);
  process.exit(1);
});
