// Phase 1 Slice 12 — contacts / roles tests.
//
// Layers:
//   1. parseContactsInput pure validation
//   2. provisionContract seeds contacts inside the transaction
//   3. getContactsForClient + getContactsByRole readers
//   4. resolveReminderRecipients three-layer fallback:
//        a. contacts with receives_reminders + billing/primary role
//        b. clients.primary_contact_email
//        c. legacy user list
//
// Isolation: each integration block creates a fresh synthetic contract
// under ZipKit. Contacts are keyed to ZipKit's client_id — the
// UNIQUE(client_id, email) constraint means two tests running
// concurrently with the same synthetic email would collide. All
// emails this test writes include a nanoid suffix to guarantee
// uniqueness. Cleanup deletes every row this test created and
// snapshots the ZipKit client profile's primary_contact_email so the
// narrator-path fallback test doesn't leak a value.
//
// Run:
//   npx tsx scripts/phase1-test-contacts.ts

import 'dotenv/config';
import { createClient } from '@libsql/client';
import { nanoid } from 'nanoid';
import { provisionContract, deleteContract } from '../src/lib/contracts';
import {
  parseContactsInput,
  getContactsForClient,
  getContactsByRole,
  resolveReminderRecipients,
  getClientProfile,
  type Contact,
} from '../src/lib/clients';

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
  console.log('=== Slice 12 test: contacts / roles ===');
  console.log();

  // Preflight.
  const mig = await db.execute({
    sql: `SELECT 1 FROM _migrations WHERE id = ?`,
    args: ['018-contacts'],
  });
  assert(mig.rows.length > 0, 'Migration 018 not applied');

  // ---- parseContactsInput ----
  console.log('--- parseContactsInput ---');
  eq(parseContactsInput(undefined)?.length, 0, 'undefined → []');
  eq(parseContactsInput(null)?.length, 0, 'null → []');
  eq(parseContactsInput([])?.length, 0, '[] → []');
  eq(parseContactsInput('x'), null, 'string → null');
  eq(parseContactsInput({ email: 'x' }), null, 'object → null');

  // Happy path with 3 contacts, multiple roles each, receives flags
  // varying, mixed case emails normalized.
  const good = parseContactsInput([
    {
      name: 'Billing Bob',
      email: 'BOB@example.com',
      roles: ['billing'],
      receives_invoices: true,
      receives_reminders: true,
    },
    {
      name: 'Tech Tina',
      email: 'tina@example.com',
      roles: ['technical', 'approval'],
    },
    {
      name: 'Primary Pat',
      email: 'pat@example.com',
      roles: ['primary', 'approval'],
      receives_reminders: true,
    },
  ]);
  assert(good !== null, 'valid → parses');
  eq(good!.length, 3, '3 contacts');
  eq(good![0].email, 'bob@example.com', 'email lowercased');
  eq(good![0].receives_invoices, true, 'receives_invoices true');
  eq(good![0].receives_reminders, true, 'receives_reminders true');
  deepEq(good![1].roles, ['technical', 'approval'], 'multi-role');
  eq(good![2].receives_invoices, false, 'receives_invoices defaults false');

  eq(parseContactsInput([{ name: 'x', email: 'bad', roles: ['billing'] }]), null, 'bad email → null');
  eq(parseContactsInput([{ name: 'x', email: 'a@b.c', roles: [] }]), null, 'empty roles → null');
  eq(
    parseContactsInput([{ name: 'x', email: 'a@b.c', roles: ['not_a_role'] }]),
    null,
    'unknown role → null'
  );
  eq(parseContactsInput([{ name: '', email: 'a@b.c', roles: ['billing'] }]), null, 'empty name → null');
  eq(
    parseContactsInput([
      { name: 'a', email: 'same@x.y', roles: ['billing'] },
      { name: 'b', email: 'same@x.y', roles: ['technical'] },
    ]),
    null,
    'duplicate email → null'
  );
  console.log('  parseContactsInput OK');
  console.log();

  // ---- Integration: provisionContract seeds contacts ----
  console.log('--- provisionContract seeds contacts ---');
  const testClient = await findTestClient();
  // Snapshot the existing profile so we don't stomp it.
  const originalProfile = await getClientProfile(testClient.id);
  const runTag = nanoid(8);

  const contactsIn = [
    {
      name: 'Billing Bob ' + runTag,
      email: `bob+${runTag}@example.com`,
      roles: ['billing' as const],
      receives_invoices: true,
      receives_reminders: true,
    },
    {
      name: 'Tech Tina ' + runTag,
      email: `tina+${runTag}@example.com`,
      roles: ['technical' as const, 'approval' as const],
    },
    {
      name: 'Primary Pat ' + runTag,
      email: `pat+${runTag}@example.com`,
      roles: ['primary' as const, 'approval' as const],
      receives_reminders: true,
    },
  ];

  const result = await provisionContract({
    client_id: testClient.id,
    title: `slice-12-test ${new Date().toISOString()}`,
    type: 'retainer',
    contacts: contactsIn,
    created_by: testClient.adminUserId,
  });

  const cleanup = {
    contractId: result.contract_id,
    scheduledJobId: result.scheduled_job_id,
    contactIds: result.contact_ids,
  };

  try {
    eq(result.contact_ids.length, 3, '3 contact_ids returned');

    const all = await getContactsForClient(testClient.id);
    const tagged = all.filter((c) => c.email.includes(runTag));
    eq(tagged.length, 3, '3 tagged contacts readable');

    const bob = tagged.find((c) => c.email.startsWith('bob+'))!;
    eq(bob.receives_invoices, true, 'bob.receives_invoices');
    eq(bob.receives_reminders, true, 'bob.receives_reminders');
    deepEq(bob.roles, ['billing'], 'bob roles');

    const tina = tagged.find((c) => c.email.startsWith('tina+'))!;
    deepEq(tina.roles, ['technical', 'approval'], 'tina roles');
    eq(tina.receives_reminders, false, 'tina.receives_reminders default');

    const pat = tagged.find((c) => c.email.startsWith('pat+'))!;
    deepEq(pat.roles, ['primary', 'approval'], 'pat roles');
    eq(pat.receives_reminders, true, 'pat.receives_reminders');

    // getContactsByRole
    const billingContacts = await getContactsByRole(testClient.id, 'billing');
    const taggedBilling = billingContacts.filter((c) => c.email.includes(runTag));
    eq(taggedBilling.length, 1, 'getContactsByRole billing → 1');
    eq(taggedBilling[0].email, bob.email, 'billing → bob');

    const approvalContacts = await getContactsByRole(testClient.id, 'approval');
    const taggedApproval = approvalContacts.filter((c) => c.email.includes(runTag));
    eq(taggedApproval.length, 2, 'getContactsByRole approval → 2');

    console.log('  seed + read OK');
    console.log();

    // ---- resolveReminderRecipients ----
    console.log('--- resolveReminderRecipients ---');

    // Layer 1: contacts with billing/primary role AND receives_reminders
    // Both bob (billing + receives) and pat (primary + receives) match.
    const r1 = await resolveReminderRecipients(
      testClient.id,
      [{ email: 'fallback@user.com', name: 'fallback' }],
      'profile@fallback.com'
    );
    // Filter to just my test contacts — other rows on this client
    // may exist from concurrent runs or pre-existing state.
    const r1Tagged = r1.filter((e) => e.email.includes(runTag));
    eq(r1Tagged.length, 2, 'layer 1: 2 tagged billing/primary recipients');
    const r1Emails = new Set(r1Tagged.map((e) => e.email));
    assert(r1Emails.has(bob.email), 'layer 1 includes bob');
    assert(r1Emails.has(pat.email), 'layer 1 includes pat');
    assert(!r1Emails.has(tina.email), 'layer 1 excludes tina (no billing/primary role)');
    console.log('  layer 1 (contacts) OK');

    // Layer 2: fallback to primary_contact_email when no contacts match.
    // Simulate by using a different client id that has zero matching
    // contacts. Create a bare-bones temp client to verify cleanly.
    const tempClientId = nanoid();
    const tempSlug = `slice12-tmp-${runTag}`;
    await db.execute({
      sql: `INSERT INTO clients (id, name, slug, primary_contact_email) VALUES (?, ?, ?, ?)`,
      args: [tempClientId, `tmp-${runTag}`, tempSlug, 'profile@tmp.example'],
    });
    try {
      const r2 = await resolveReminderRecipients(
        tempClientId,
        [{ email: 'fallback@user.com', name: 'fallback' }],
        'profile@tmp.example'
      );
      eq(r2.length, 1, 'layer 2: one recipient');
      eq(r2[0].email, 'profile@tmp.example', 'layer 2: profile email');

      // Layer 3: neither contacts nor profile → fallback user list.
      const r3 = await resolveReminderRecipients(
        tempClientId,
        [{ email: 'fallback@user.com', name: 'fallback' }],
        null
      );
      eq(r3.length, 1, 'layer 3: one recipient');
      eq(r3[0].email, 'fallback@user.com', 'layer 3: user fallback');

      // Layer 4 (edge): everything empty → returns empty
      const r4 = await resolveReminderRecipients(tempClientId, [], null);
      eq(r4.length, 0, 'all empty → []');
      console.log('  layer 2/3 (profile + user fallback) OK');
    } finally {
      await db.execute({ sql: 'DELETE FROM clients WHERE id = ?', args: [tempClientId] });
    }
    console.log();

    // Activity log summary mentions contact count.
    const act = await db.execute({
      sql: `SELECT summary FROM activity_log
            WHERE entity_type = 'contract' AND entity_id = ?`,
      args: [cleanup.contractId],
    });
    const summary = String(act.rows[0][0]);
    assert(summary.includes('3 contacts'), 'activity log summary mentions 3 contacts');
    console.log('  activity log OK');
    console.log();
  } finally {
    // Cleanup — explicit contact delete because no cascade from
    // deleteContract to contacts (contacts hang off client, not
    // contract, so provision-scoped cleanup is manual).
    for (const cid of cleanup.contactIds) {
      await db.execute({ sql: 'DELETE FROM contacts WHERE id = ?', args: [cid] });
    }
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
    } catch {
      await db.execute({ sql: 'DELETE FROM contracts WHERE id = ?', args: [cleanup.contractId] });
    }

    // Belt-and-suspenders: restore the ZipKit profile in case anything
    // above touched it (shouldn't, but this test manipulates client-
    // level state and a paranoid restore has zero cost).
    if (originalProfile) {
      await db.execute({
        sql: `UPDATE clients
              SET primary_url = ?,
                  brand_accent = ?,
                  primary_contact_email = ?,
                  reading_level_target = ?
              WHERE id = ?`,
        args: [
          originalProfile.primary_url,
          originalProfile.brand_accent,
          originalProfile.primary_contact_email,
          originalProfile.reading_level_target,
          testClient.id,
        ],
      });
    }

    // Hard verify: no tagged contacts remain.
    const remaining = await db.execute({
      sql: `SELECT COUNT(*) FROM contacts WHERE client_id = ? AND email LIKE ?`,
      args: [testClient.id, `%+${runTag}@%`],
    });
    eq(Number(remaining.rows[0][0]), 0, 'no tagged contacts remain');

    console.log('  cleanup complete');
    console.log();
  }

  console.log('SLICE 12 TEST PASSED ✓');
}

main().catch((err) => {
  console.error();
  console.error('SLICE 12 TEST FAILED:', err);
  process.exit(1);
});
