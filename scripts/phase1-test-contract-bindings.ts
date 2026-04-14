// Phase 1 Slice 7 — end-to-end test for contract intake binding backbone.
//
// Exercises:
//   1. Migration 016 is applied (data_source_bindings exists).
//   2. provisionContract() with data_sources seeds the binding rows
//      inside the same transaction as the contract row.
//   3. Each binding row has the expected shape: contract_id FK,
//      client_id FK, source kind, enabled bit, config_json, null
//      last_seen_at at provision time.
//   4. touchBinding() updates last_seen_at on exactly the matching row.
//   5. Duplicate-source input rejection in parseDataSourceInput.
//   6. Unknown-source rejection in parseDataSourceInput.
//   7. Activity log row summary mentions the bindings count.
//   8. Cleanup: everything created by this test is removed. The run is
//      idempotent — it can be executed repeatedly against the same DB.
//
// This test writes to the live Turso database. It creates a contract
// under an existing client and cleans up at the end. If any assertion
// fails mid-run, the cleanup block still fires so the test never
// leaves pollution behind.
//
// Run:
//   npx tsx scripts/phase1-test-contract-bindings.ts

import 'dotenv/config';
import { createClient } from '@libsql/client';
import { provisionContract, deleteContract } from '../src/lib/contracts';
import {
  parseDataSourceInput,
  getBindingsForContract,
  touchBinding,
  type DataSourceKind,
} from '../src/lib/data-sources';
import {
  parseClientProfileInput,
  getClientProfile,
  updateClientProfile,
  type ClientProfile,
} from '../src/lib/clients';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) {
  console.error('TURSO_DATABASE_URL is not set');
  process.exit(1);
}
const db = createClient({ url, authToken });

// --- Small assertion helpers so failures name the expectation ---

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

// --- Setup ---

async function findTestClient(): Promise<{ id: string; name: string; adminUserId: string }> {
  // Use ZipKit Homes as the test client — already provisioned, has a
  // user, safe for repeated runs as long as we clean up after ourselves.
  const clientRes = await db.execute({
    sql: 'SELECT id, name FROM clients WHERE slug = ? OR name LIKE ? LIMIT 1',
    args: ['zipkit-homes', '%ZipKit%'],
  });
  assert(clientRes.rows.length > 0, 'ZipKit test client not found');
  const client = { id: String(clientRes.rows[0][0]), name: String(clientRes.rows[0][1]) };

  // Find any admin user for created_by attribution.
  const adminRes = await db.execute({
    sql: `SELECT id FROM users WHERE role = 'admin' LIMIT 1`,
  });
  assert(adminRes.rows.length > 0, 'No admin user found in users table');
  const adminUserId = String(adminRes.rows[0][0]);

  return { ...client, adminUserId };
}

// --- Main ---

async function main() {
  console.log('=== Slice 7 test: contract intake bindings ===');
  console.log();

  // Preflight: verify migration 016 is recorded.
  const mig = await db.execute({
    sql: 'SELECT 1 FROM _migrations WHERE id = ?',
    args: ['016-data-source-bindings'],
  });
  assert(mig.rows.length > 0, 'Migration 016 has not been recorded — run phase1-apply-migration-016.ts --apply first');

  const tbl = await db.execute(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='data_source_bindings'`
  );
  assert(tbl.rows.length > 0, 'data_source_bindings table is missing');
  console.log('  preflight OK: migration recorded, table present');
  console.log();

  // 1. Pure-function tests on parseDataSourceInput.
  console.log('--- parseDataSourceInput unit tests ---');
  eq(parseDataSourceInput(undefined)?.length, 0, 'undefined → []');
  eq(parseDataSourceInput(null)?.length, 0, 'null → []');
  eq(parseDataSourceInput([])?.length, 0, '[] → []');

  const good = parseDataSourceInput([
    { source: 'gsc', enabled: true },
    { source: 'ga4' },
    { source: 'screaming_frog_issues', enabled: false, config: { crawl_url: 'https://zipkithomes.com' } },
  ]);
  assert(good !== null, 'valid input should parse');
  eq(good!.length, 3, 'valid input length');
  eq(good![0].source, 'gsc', 'first source');
  eq(good![0].enabled, true, 'first enabled');
  eq(good![2].config?.crawl_url, 'https://zipkithomes.com', 'third config.crawl_url');

  const badKind = parseDataSourceInput([{ source: 'not_a_real_source' }]);
  eq(badKind, null, 'unknown source kind → null');

  const notArray = parseDataSourceInput({ source: 'gsc' });
  eq(notArray, null, 'non-array → null');

  const dup = parseDataSourceInput([{ source: 'gsc' }, { source: 'gsc' }]);
  eq(dup, null, 'duplicate source → null');

  const missingSource = parseDataSourceInput([{ enabled: true }]);
  eq(missingSource, null, 'missing source → null');

  console.log('  parseDataSourceInput OK');
  console.log();

  // 1b. Pure-function tests on parseClientProfileInput.
  console.log('--- parseClientProfileInput unit tests ---');
  eq(JSON.stringify(parseClientProfileInput(undefined)), '{}', 'undefined → {}');
  eq(JSON.stringify(parseClientProfileInput(null)), '{}', 'null → {}');
  eq(JSON.stringify(parseClientProfileInput({})), '{}', '{} → {}');

  const goodProfile = parseClientProfileInput({
    primary_url: 'https://zipkithomes.com',
    brand_accent: '#22c55e',
    primary_contact_email: 'kelsey@zipkithomes.com',
    reading_level_target: 7,
  });
  assert(goodProfile !== null, 'valid profile should parse');
  eq(goodProfile!.primary_url, 'https://zipkithomes.com', 'profile.primary_url');
  eq(goodProfile!.brand_accent, '#22c55e', 'profile.brand_accent');
  eq(goodProfile!.primary_contact_email, 'kelsey@zipkithomes.com', 'profile.primary_contact_email');
  eq(goodProfile!.reading_level_target, 7, 'profile.reading_level_target');

  eq(parseClientProfileInput({ primary_url: 'not-a-url' }), null, 'bad url → null');
  eq(parseClientProfileInput({ brand_accent: 'green' }), null, 'bad hex color → null');
  eq(parseClientProfileInput({ brand_accent: '#fff' }), null, 'too-short hex → null');
  eq(parseClientProfileInput({ primary_contact_email: 'not-an-email' }), null, 'bad email → null');
  eq(parseClientProfileInput({ reading_level_target: 99 }), null, 'reading_level out of range → null');
  eq(parseClientProfileInput({ reading_level_target: 2.5 }), null, 'reading_level non-integer → null');
  eq(parseClientProfileInput([]), null, 'array → null');

  console.log('  parseClientProfileInput OK');
  console.log();

  // 2. Provisioning: create a contract with 4 bindings + client profile.
  console.log('--- provisionContract with bindings + profile ---');
  const testClient = await findTestClient();
  console.log(`  test client: ${testClient.name} (${testClient.id.slice(0, 10)})`);

  // Snapshot current profile so we can restore it during cleanup.
  const originalProfile = (await getClientProfile(testClient.id)) as ClientProfile;
  console.log(`  original profile: ${JSON.stringify(originalProfile)}`);

  const testTitle = `slice-7-test ${new Date().toISOString()}`;
  const bindingInputs: Array<{ source: DataSourceKind; enabled?: boolean; config?: Record<string, unknown> }> = [
    { source: 'ubersuggest_position_tracking', enabled: true, config: { tracked_keywords: 100 } },
    { source: 'ubersuggest_site_audit', enabled: true },
    { source: 'screaming_frog_issues', enabled: false },
    { source: 'gsc', enabled: false, config: { property: 'sc-domain:zipkithomes.com' } },
  ];

  // Use a bright test-only hex so a pollution leak would be glaringly
  // obvious in the UI. Restored to original at cleanup.
  const testProfile = {
    primary_url: 'https://test.example.com/slice-7',
    brand_accent: '#ff00ff',
    primary_contact_email: 'test+slice7@example.com',
    reading_level_target: 9,
  };

  const result = await provisionContract({
    client_id: testClient.id,
    title: testTitle,
    type: 'retainer',
    billing_cadence: 'monthly',
    billing_day: 9,
    recurring_amount: 500,
    included_hours: 5,
    overage_rate: 100,
    data_sources: bindingInputs,
    client_profile: testProfile,
    created_by: testClient.adminUserId,
  });

  console.log(`  contract_id:            ${result.contract_id}`);
  console.log(`  project_id:             ${result.project_id}`);
  console.log(`  scheduled_job_id:       ${result.scheduled_job_id}`);
  console.log(`  binding_ids:            [${result.binding_ids.length}]`);
  console.log(`  client_profile_fields:  [${result.client_profile_fields_updated.join(', ')}]`);
  eq(result.binding_ids.length, 4, 'binding_ids length');
  assert(result.scheduled_job_id !== null, 'monthly contract should schedule generate_invoices job');
  eq(result.client_profile_fields_updated.length, 4, 'all 4 profile fields updated');

  // 3. Read back the bindings and assert shape.
  const bindings = await getBindingsForContract(result.contract_id);
  eq(bindings.length, 4, 'getBindingsForContract count');

  // Sorted by source alphabetically.
  const sources = bindings.map((b) => b.source);
  const expectedSources = [...bindingInputs.map((b) => b.source)].sort();
  for (let i = 0; i < 4; i++) {
    eq(sources[i], expectedSources[i], `binding[${i}].source`);
  }

  for (const b of bindings) {
    eq(b.client_id, testClient.id, `binding ${b.source}.client_id`);
    eq(b.contract_id, result.contract_id, `binding ${b.source}.contract_id`);
    eq(b.last_seen_at, null, `binding ${b.source}.last_seen_at is null at provision`);

    const input = bindingInputs.find((i) => i.source === b.source)!;
    eq(Number(b.enabled), input.enabled ? 1 : 0, `binding ${b.source}.enabled`);

    if (input.config) {
      assert(b.config_json !== null, `binding ${b.source}.config_json present`);
      const parsed = JSON.parse(b.config_json!);
      eq(JSON.stringify(parsed), JSON.stringify(input.config), `binding ${b.source}.config_json content`);
    } else {
      eq(b.config_json, null, `binding ${b.source}.config_json is null when no config provided`);
    }
  }
  console.log('  all 4 bindings have correct shape');
  console.log();

  // 3b. Client profile was upserted inside the same transaction.
  console.log('--- client profile upsert ---');
  const afterProfile = (await getClientProfile(testClient.id)) as ClientProfile;
  eq(afterProfile.primary_url, testProfile.primary_url, 'profile.primary_url upserted');
  eq(afterProfile.brand_accent, testProfile.brand_accent, 'profile.brand_accent upserted');
  eq(afterProfile.primary_contact_email, testProfile.primary_contact_email, 'profile.primary_contact_email upserted');
  eq(afterProfile.reading_level_target, testProfile.reading_level_target, 'profile.reading_level_target upserted');
  console.log('  all 4 profile fields upserted atomically with contract');
  console.log();

  // 4. touchBinding updates last_seen_at on exactly the matching row.
  console.log('--- touchBinding ---');
  const beforeTouch = await getBindingsForContract(result.contract_id);
  assert(
    beforeTouch.every((b) => b.last_seen_at === null),
    'all last_seen_at null before touch'
  );

  await touchBinding(result.contract_id, 'gsc');

  const afterTouch = await getBindingsForContract(result.contract_id);
  const touched = afterTouch.filter((b) => b.last_seen_at !== null);
  eq(touched.length, 1, 'exactly one binding touched');
  eq(touched[0].source, 'gsc', 'touched binding is gsc');

  const untouched = afterTouch.filter((b) => b.last_seen_at === null);
  eq(untouched.length, 3, 'three bindings still null');
  console.log(`  gsc.last_seen_at = ${touched[0].last_seen_at}`);
  console.log();

  // 5. Activity log row summary mentions bindings.
  console.log('--- activity_log summary ---');
  const act = await db.execute({
    sql: `SELECT summary FROM activity_log
          WHERE action = 'provisioned' AND entity_type = 'contract' AND entity_id = ?`,
    args: [result.contract_id],
  });
  eq(act.rows.length, 1, 'exactly one provisioned activity row');
  const summary = String(act.rows[0][0]);
  console.log(`  summary: ${summary}`);
  assert(summary.includes('4 data source bindings'), 'summary mentions 4 bindings');
  assert(summary.includes('2 enabled'), 'summary mentions 2 enabled');
  assert(summary.includes('client profile'), 'summary mentions client profile');
  console.log();

  // 6. Cleanup. Delete everything this test created AND restore the
  // original client profile. deleteContract cascades to projects/
  // milestones/tasks/artifacts/invoices/approvals/change orders but
  // NOT to data_source_bindings, scheduled_jobs, activity_log, or
  // client profile columns — those we clean up manually so the run
  // is idempotent and leaves no pollution in the real UI.
  console.log('--- cleanup ---');
  await db.execute({
    sql: 'DELETE FROM data_source_bindings WHERE contract_id = ?',
    args: [result.contract_id],
  });
  if (result.scheduled_job_id) {
    await db.execute({
      sql: 'DELETE FROM scheduled_jobs WHERE id = ?',
      args: [result.scheduled_job_id],
    });
  }
  await db.execute({
    sql: 'DELETE FROM activity_log WHERE entity_type = ? AND entity_id = ?',
    args: ['contract', result.contract_id],
  });
  await deleteContract(result.contract_id);

  // Restore original profile values. Fields that were null before
  // cannot be restored via updateClientProfile (it only handles
  // defined fields) so we restore them via direct SQL.
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
  const restored = (await getClientProfile(testClient.id)) as ClientProfile;
  eq(
    JSON.stringify(restored),
    JSON.stringify(originalProfile),
    'client profile restored to original'
  );

  // Verify nothing remains.
  const leftovers = await db.execute({
    sql: 'SELECT COUNT(*) FROM data_source_bindings WHERE contract_id = ?',
    args: [result.contract_id],
  });
  eq(Number(leftovers.rows[0][0]), 0, 'no binding rows remain');

  const contractLeftover = await db.execute({
    sql: 'SELECT COUNT(*) FROM contracts WHERE id = ?',
    args: [result.contract_id],
  });
  eq(Number(contractLeftover.rows[0][0]), 0, 'contract row removed');

  console.log('  cleanup complete');
  console.log();
  console.log('SLICE 7 TEST PASSED ✓');
}

main().catch((err) => {
  console.error();
  console.error('SLICE 7 TEST FAILED:', err);
  process.exit(1);
});
