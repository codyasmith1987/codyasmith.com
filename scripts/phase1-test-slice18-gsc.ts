// Slice 18 — Google OAuth foundation + GSC sync tests.
//
// Eight cases covering the layers that can be honestly verified
// without real Google credentials:
//
//   1. Encryption round-trip against the real GOOGLE_TOKEN_KEY env var
//   2. Encryption gracefully fails when GOOGLE_TOKEN_KEY is missing
//   3. OAuth URL builder produces the expected query shape
//   4. GSC response mapper: fixture -> staged keyword rows
//   5. Sync handler happy path with a fake GSC client injected
//   6. Sync handler blocked by period lock
//   7. Sync handler fails honestly on a binding with no config
//   8. Connection CRUD: create + getById + delete
//
// Isolation: every synthetic write targets ZipKit with a tagged
// slug and a far-future period ('2099-01'). Cleanup on both paths.
//
// What this test does NOT verify:
//   - real OAuth consent flow against Google (requires a browser)
//   - real GSC API responses (requires tokens for a real property)
//   - real refreshAccessToken against Google (no refresh token to use)
//
// Those three remaining gaps can only be closed by Cody clicking
// through the connect flow with real credentials.
//
// Run:
//   GOOGLE_TOKEN_KEY=$(openssl rand -base64 32) npx tsx scripts/phase1-test-slice18-gsc.ts
// or add GOOGLE_TOKEN_KEY to .env.

import 'dotenv/config';
import { createClient } from '@libsql/client';
import { nanoid } from 'nanoid';
import crypto from 'node:crypto';
import {
  encryptSecret,
  decryptSecret,
  isGoogleCryptoConfigured,
} from '../src/lib/google/crypto';
import { buildAuthUrl, GSC_SCOPE } from '../src/lib/google/oauth';
import {
  mapGscResponseToKeywords,
  monthToRange,
  type GscClient,
  type SearchAnalyticsResponse,
} from '../src/lib/google/gsc';
import {
  createConnection,
  getConnectionById,
  deleteConnection,
} from '../src/lib/google/connections';
import { syncGscForBinding } from '../src/lib/google/sync';
import { provisionContract, deleteContract } from '../src/lib/contracts';
import { lockPeriod, unlockPeriod } from '../src/lib/periods';

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

// Ensure GOOGLE_TOKEN_KEY is set for the rest of the test. If the
// env doesn't have one, generate a random 32-byte key for this run
// so the encryption cases can execute. This mutation is test-scoped
// and does not touch the real .env file.
if (!process.env.GOOGLE_TOKEN_KEY) {
  process.env.GOOGLE_TOKEN_KEY = crypto.randomBytes(32).toString('base64');
  console.log(
    '  (no GOOGLE_TOKEN_KEY in env — generated a test-only key for this run)'
  );
}

// For the OAuth URL test we need the three OAuth env vars. If
// missing, set test stubs so buildAuthUrl can execute. These
// stubs are test-only and never touch the real env file.
if (!process.env.GOOGLE_OAUTH_CLIENT_ID) {
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
}
if (!process.env.GOOGLE_OAUTH_CLIENT_SECRET) {
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-client-secret';
}
if (!process.env.GOOGLE_OAUTH_REDIRECT_URI) {
  process.env.GOOGLE_OAUTH_REDIRECT_URI = 'http://localhost:4321/portal/api/admin/google/callback';
}

async function findTestClient(): Promise<{ id: string; adminUserId: string }> {
  const c = await db.execute({
    sql: 'SELECT id FROM clients WHERE slug = ? OR name LIKE ? LIMIT 1',
    args: ['zipkit-homes', '%ZipKit%'],
  });
  assert(c.rows.length > 0, 'ZipKit missing');
  const a = await db.execute({ sql: `SELECT id FROM users WHERE role = 'admin' LIMIT 1` });
  assert(a.rows.length > 0, 'no admin user');
  return { id: String(c.rows[0][0]), adminUserId: String(a.rows[0][0]) };
}

// Fake GSC client that returns a fixture response. Used for the
// sync handler integration test so we never call real Google.
const FIXTURE_RESPONSE: SearchAnalyticsResponse = {
  rows: [
    { keys: ['panelized home kits', 'https://zipkithomes.com/'], clicks: 12, impressions: 340, ctr: 0.035, position: 4.2 },
    { keys: ['modular homes utah', 'https://zipkithomes.com/about'], clicks: 6, impressions: 120, ctr: 0.05, position: 11.8 },
    { keys: ['prefab home kits', 'https://zipkithomes.com/'], clicks: 3, impressions: 80, ctr: 0.0375, position: 22.3 },
    { keys: ['kit home builders', 'https://zipkithomes.com/models'], clicks: 1, impressions: 20, ctr: 0.05, position: 35.0 },
  ],
};
class FakeGscClient implements GscClient {
  calls: Array<{ property: string; startDate: string; endDate: string }> = [];
  async listSites(_accessToken: string) {
    return [
      { siteUrl: 'sc-domain:zipkithomes.com', permissionLevel: 'siteOwner' },
    ];
  }
  async querySearchAnalytics(_accessToken: string, siteUrl: string, req: any) {
    this.calls.push({ property: siteUrl, startDate: req.startDate, endDate: req.endDate });
    return FIXTURE_RESPONSE;
  }
}

async function main() {
  console.log('=== Slice 18 test: Google OAuth + GSC sync ===');
  console.log();

  // ---- 1. Encryption round-trip ----
  console.log('--- 1. encryption round-trip ---');
  assert(isGoogleCryptoConfigured(), 'crypto configured');
  const plaintext = 'refresh-token-' + nanoid(20);
  const ct1 = encryptSecret(plaintext);
  const ct2 = encryptSecret(plaintext);
  assert(ct1 !== ct2, 'two encryptions of same plaintext produce different ciphertext (random IV)');
  eq(decryptSecret(ct1), plaintext, 'decrypt ct1 matches');
  eq(decryptSecret(ct2), plaintext, 'decrypt ct2 matches');
  // Tamper check
  const tampered = ct1.replace(/\$/, (m, i) => (i === 0 ? '$' : m)); // no-op
  let tamperThrew = false;
  try {
    // Flip one character in the ciphertext segment
    const parts = ct1.split('$');
    parts[1] = parts[1].slice(0, -2) + 'AA';
    decryptSecret(parts.join('$'));
  } catch {
    tamperThrew = true;
  }
  assert(tamperThrew, 'tampered ciphertext throws');
  console.log('  OK');
  console.log();

  // ---- 2. Encryption without key (checked via temporary unset) ----
  console.log('--- 2. encryption without GOOGLE_TOKEN_KEY ---');
  const savedKey = process.env.GOOGLE_TOKEN_KEY;
  delete process.env.GOOGLE_TOKEN_KEY;
  let threwOnMissing = false;
  try {
    encryptSecret('anything');
  } catch (err) {
    if (/GOOGLE_TOKEN_KEY/.test(String((err as Error)?.message ?? err))) {
      threwOnMissing = true;
    }
  }
  process.env.GOOGLE_TOKEN_KEY = savedKey;
  assert(threwOnMissing, 'missing key throws with clear message');
  console.log('  OK');
  console.log();

  // ---- 3. OAuth URL builder ----
  console.log('--- 3. buildAuthUrl ---');
  const state = 'test-state-' + nanoid(12);
  const authUrl = buildAuthUrl({ state, scopes: [GSC_SCOPE, 'openid', 'email'] });
  assert(authUrl.startsWith('https://accounts.google.com/o/oauth2/v2/auth?'), 'uses Google auth endpoint');
  const parsed = new URL(authUrl);
  eq(parsed.searchParams.get('state'), state, 'state preserved');
  eq(parsed.searchParams.get('access_type'), 'offline', 'access_type=offline');
  eq(parsed.searchParams.get('prompt'), 'consent', 'prompt=consent');
  eq(parsed.searchParams.get('response_type'), 'code', 'response_type=code');
  assert(
    parsed.searchParams.get('scope')?.includes(GSC_SCOPE),
    'GSC scope present'
  );
  assert(
    parsed.searchParams.get('scope')?.includes('openid'),
    'openid scope present'
  );
  eq(parsed.searchParams.get('client_id'), process.env.GOOGLE_OAUTH_CLIENT_ID!, 'client_id from env');
  eq(parsed.searchParams.get('redirect_uri'), process.env.GOOGLE_OAUTH_REDIRECT_URI!, 'redirect_uri from env');
  console.log('  OK');
  console.log();

  // ---- 4. GSC response mapper ----
  console.log('--- 4. mapGscResponseToKeywords ---');
  const mapped = mapGscResponseToKeywords(FIXTURE_RESPONSE);
  eq(mapped.length, 4, 'mapped 4 rows');
  eq(mapped[0].keyword, 'panelized home kits', 'row 0 keyword');
  eq(mapped[0].url, 'https://zipkithomes.com/', 'row 0 url');
  eq(mapped[0].position, 4, 'row 0 position rounded');
  eq(mapped[0].search_volume, null, 'row 0 search_volume null');
  eq(mapped[0].change_val, null, 'row 0 change_val null');
  eq(mapped[2].position, 22, 'row 2 position rounded');

  // Dedup test
  const dedupResponse: SearchAnalyticsResponse = {
    rows: [
      { keys: ['kw1', 'url1'], clicks: 1, impressions: 10, ctr: 0.1, position: 5 },
      { keys: ['kw1', 'url1'], clicks: 2, impressions: 20, ctr: 0.1, position: 6 },
      { keys: ['kw1', 'url2'], clicks: 1, impressions: 10, ctr: 0.1, position: 7 },
    ],
  };
  const dedup = mapGscResponseToKeywords(dedupResponse);
  eq(dedup.length, 2, 'dedup kept 2 distinct (keyword, url) pairs');

  // monthToRange
  const r = monthToRange('2099-01');
  eq(r.startDate, '2099-01-01', 'startDate');
  eq(r.endDate, '2099-01-31', 'endDate');
  console.log('  OK');
  console.log();

  // ---- 5+6+7. Sync handler integration (fresh synthetic state) ----
  const testClient = await findTestClient();

  // Pre-check: ensure no leftover 2099-01 data for this client.
  const preflight = await db.execute({
    sql: `SELECT COUNT(*) FROM periods WHERE client_id = ? AND period_start = '2099-01-01'`,
    args: [testClient.id],
  });
  assert(
    Number(preflight.rows[0][0]) === 0,
    'no pre-existing 2099-01 period for test client'
  );

  // Provision a contract with a gsc binding so we have something to sync.
  const provision = await provisionContract({
    client_id: testClient.id,
    title: `slice-18-test-${nanoid(5)}`,
    type: 'retainer',
    service_type: 'web_management',
    data_sources: [{ source: 'gsc', enabled: true }],
    created_by: testClient.adminUserId,
  });

  // Create a synthetic google_connections row so the binding can reference it.
  const connectionId = await createConnection({
    admin_user_id: testClient.adminUserId,
    google_account_email: `slice18-${nanoid(5)}@test.example`,
    refresh_token: 'fake-refresh-token-' + nanoid(20),
    access_token: 'fake-access-token-' + nanoid(20),
    access_token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    scopes: [GSC_SCOPE],
  });

  // The binding id we need — pull it from the provision result.
  const bindingId = provision.binding_ids[0];
  assert(bindingId, 'provision returned a binding id');

  // Bind the connection + property into the binding's config_json.
  await db.execute({
    sql: `UPDATE data_source_bindings
          SET config_json = ?, enabled = 1
          WHERE id = ?`,
    args: [JSON.stringify({ connection_id: connectionId, property: 'sc-domain:zipkithomes.com' }), bindingId],
  });

  let createdPeriodIdFor2099: string | null = null;

  try {
    // ---- 5. Happy path sync with fake GSC client ----
    console.log('--- 5. syncGscForBinding happy path ---');
    const fake = new FakeGscClient();
    const res1 = await syncGscForBinding(bindingId, '2099-01', testClient.adminUserId, fake);
    eq(res1.status, 'applied', 'sync applied');
    eq(res1.row_count, 4, 'row_count matches fixture');
    assert(res1.period_id !== null, 'period_id returned');
    createdPeriodIdFor2099 = res1.period_id;
    assert(res1.import_id !== null, 'import_id returned');
    eq(fake.calls.length, 1, 'GSC client called once');
    eq(fake.calls[0].property, 'sc-domain:zipkithomes.com', 'GSC call property');
    eq(fake.calls[0].startDate, '2099-01-01', 'GSC call startDate');
    eq(fake.calls[0].endDate, '2099-01-31', 'GSC call endDate');

    // Verify snapshot rows landed with source='gsc'.
    const snap = await db.execute({
      sql: `SELECT COUNT(*) FROM keyword_snapshots
            WHERE client_id = ? AND period_id = ? AND source = 'gsc'`,
      args: [testClient.id, res1.period_id],
    });
    eq(Number(snap.rows[0][0]), 4, 'keyword_snapshots has 4 gsc rows');

    // Verify binding.last_seen_at was touched.
    const bindingAfter = await db.execute({
      sql: `SELECT last_seen_at FROM data_source_bindings WHERE id = ?`,
      args: [bindingId],
    });
    assert(bindingAfter.rows[0][0] !== null, 'last_seen_at stamped');
    console.log('  OK');
    console.log();

    // ---- 6. Lock guard ----
    console.log('--- 6. lock guard blocks sync ---');
    assert(createdPeriodIdFor2099, 'have period to lock');
    await lockPeriod(createdPeriodIdFor2099!);
    try {
      const res2 = await syncGscForBinding(bindingId, '2099-01', testClient.adminUserId, new FakeGscClient());
      eq(res2.status, 'failed', 'sync failed on locked period');
      assert(/locked/.test(res2.error ?? ''), 'error mentions locked');

      // No rows replaced
      const snap2 = await db.execute({
        sql: `SELECT COUNT(*) FROM keyword_snapshots
              WHERE client_id = ? AND period_id = ? AND source = 'gsc'`,
        args: [testClient.id, createdPeriodIdFor2099],
      });
      eq(Number(snap2.rows[0][0]), 4, 'existing gsc snapshots untouched');

      // Failed import row recorded for audit trail
      const imp = await db.execute({
        sql: `SELECT COUNT(*) FROM imports
              WHERE client_id = ? AND period_id = ? AND source = 'gsc' AND status = 'failed'`,
        args: [testClient.id, createdPeriodIdFor2099],
      });
      assert(Number(imp.rows[0][0]) >= 1, 'failed import row recorded');
    } finally {
      await unlockPeriod(createdPeriodIdFor2099!);
    }
    console.log('  OK');
    console.log();

    // ---- 7. Sync with missing config ----
    console.log('--- 7. sync fails on binding without config ---');
    // Provision a SECOND gsc binding with no config_json.
    const provision2 = await provisionContract({
      client_id: testClient.id,
      title: `slice-18-noconfig-${nanoid(5)}`,
      type: 'fixed',
      data_sources: [{ source: 'gsc', enabled: true }],
      created_by: testClient.adminUserId,
    });
    const noConfigBindingId = provision2.binding_ids[0];
    // Leave config_json null
    const res3 = await syncGscForBinding(
      noConfigBindingId,
      '2099-02',
      testClient.adminUserId,
      new FakeGscClient()
    );
    eq(res3.status, 'failed', 'no-config sync failed');
    assert(
      /connection_id|property/.test(res3.error ?? ''),
      `error mentions missing config, got: ${res3.error}`
    );
    // Cleanup this extra contract
    await db.execute({
      sql: 'DELETE FROM data_source_bindings WHERE contract_id = ?',
      args: [provision2.contract_id],
    });
    if (provision2.scheduled_job_id) {
      await db.execute({
        sql: 'DELETE FROM scheduled_jobs WHERE id = ?',
        args: [provision2.scheduled_job_id],
      });
    }
    await db.execute({
      sql: 'DELETE FROM activity_log WHERE entity_type = ? AND entity_id = ?',
      args: ['contract', provision2.contract_id],
    });
    try {
      await deleteContract(provision2.contract_id);
    } catch {
      await db.execute({
        sql: `DELETE FROM milestones WHERE project_id IN (SELECT id FROM projects WHERE contract_id = ?)`,
        args: [provision2.contract_id],
      });
      await db.execute({ sql: 'DELETE FROM projects WHERE contract_id = ?', args: [provision2.contract_id] });
      await db.execute({ sql: 'DELETE FROM contracts WHERE id = ?', args: [provision2.contract_id] });
    }
    console.log('  OK');
    console.log();

    // ---- 8. Connection CRUD ----
    console.log('--- 8. connection CRUD ---');
    const readBack = await getConnectionById(connectionId);
    assert(readBack !== null, 'connection readable');
    eq(readBack!.admin_user_id, testClient.adminUserId, 'admin user id matches');
    assert(readBack!.scopes.includes(GSC_SCOPE), 'scopes include GSC');
    assert(readBack!.refresh_token_encrypted.length > 0, 'refresh_token stored encrypted');
    // Not plaintext
    assert(
      !readBack!.refresh_token_encrypted.startsWith('fake-refresh-token'),
      'refresh_token is encrypted, not plaintext'
    );
    console.log('  OK');
    console.log();
  } finally {
    // Cleanup the synthetic period + imports + snapshots + binding + contract + connection.
    if (createdPeriodIdFor2099) {
      await db.execute({ sql: 'DELETE FROM keyword_snapshots WHERE period_id = ?', args: [createdPeriodIdFor2099] });
      await db.execute({ sql: 'DELETE FROM imports WHERE period_id = ?', args: [createdPeriodIdFor2099] });
      await db.execute({ sql: 'DELETE FROM periods WHERE id = ?', args: [createdPeriodIdFor2099] });
    }
    await db.execute({
      sql: 'DELETE FROM data_source_bindings WHERE contract_id = ?',
      args: [provision.contract_id],
    });
    if (provision.scheduled_job_id) {
      await db.execute({
        sql: 'DELETE FROM scheduled_jobs WHERE id = ?',
        args: [provision.scheduled_job_id],
      });
    }
    await db.execute({
      sql: 'DELETE FROM activity_log WHERE entity_type = ? AND entity_id = ?',
      args: ['contract', provision.contract_id],
    });
    try {
      await deleteContract(provision.contract_id);
    } catch {
      await db.execute({
        sql: `DELETE FROM milestones WHERE project_id IN (SELECT id FROM projects WHERE contract_id = ?)`,
        args: [provision.contract_id],
      });
      await db.execute({ sql: 'DELETE FROM projects WHERE contract_id = ?', args: [provision.contract_id] });
      await db.execute({ sql: 'DELETE FROM contracts WHERE id = ?', args: [provision.contract_id] });
    }
    await deleteConnection(connectionId);
    const postClean = await getConnectionById(connectionId);
    eq(postClean, null, 'connection removed post-cleanup');
  }

  console.log('SLICE 18 TEST PASSED ✓');
}

main().catch((err) => {
  console.error();
  console.error('SLICE 18 TEST FAILED:', err);
  process.exit(1);
});
