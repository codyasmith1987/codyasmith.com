// Slice 18f — Google sync attention admin-queue section tests.
//
// Six cases covering the four health states plus the two negative
// cases (healthy doesn't surface, disabled doesn't surface):
//
//   1. misconfigured GSC binding surfaces (config_json NULL)
//   2. never-synced GA4 binding surfaces (config valid, no jobs, no last_seen_at)
//   3. stale binding surfaces (last_seen_at > 45 days ago, no active job)
//   4. failed-halted chain surfaces (done sync_gsc with failed: last_result, no pending)
//   5. healthy binding does NOT surface (pending sync_ga4 in far future)
//   6. disabled binding does NOT surface (enabled = 0)
//
// Isolation: one primary synthetic contract under ZipKit holds the
// four active bindings we need for cases 1-4. Cases 5-6 reuse the
// same contract but set different (source, enabled) combinations
// via fresh contract rows so UNIQUE(contract_id, source) never
// fights us. Every binding id is tracked so assertions filter to
// test rows only and cleanup can delete by id.
//
// Run:
//   npx tsx scripts/phase1-test-slice18f-google-sync-attention.ts

import 'dotenv/config';
import { createClient } from '@libsql/client';
import { nanoid } from 'nanoid';
import { loadAdminQueue } from '../src/lib/admin-queue';
import {
  loadGoogleSyncAttentionSection,
  GOOGLE_STALE_THRESHOLD_DAYS,
} from '../src/lib/jobs/google-sync-health';
import { provisionContract, deleteContract } from '../src/lib/contracts';

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

async function findTestClient(): Promise<{ id: string; adminUserId: string }> {
  const c = await db.execute({
    sql: 'SELECT id FROM clients WHERE slug = ? OR name LIKE ? LIMIT 1',
    args: ['zipkit-homes', '%ZipKit%'],
  });
  assert(c.rows.length > 0, 'ZipKit test client missing');
  const a = await db.execute({
    sql: `SELECT id FROM users WHERE role = 'admin' LIMIT 1`,
  });
  assert(a.rows.length > 0, 'No admin user');
  return { id: String(c.rows[0][0]), adminUserId: String(a.rows[0][0]) };
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString();
}

async function provisionTestContract(
  testClient: { id: string; adminUserId: string },
  tag: string,
  label: string,
  sources: Array<'gsc' | 'ga4'>
): Promise<{ contract_id: string; binding_ids: Record<string, string>; scheduled_job_id: string | null }> {
  const p = await provisionContract({
    client_id: testClient.id,
    title: `slice-18f-${tag}-${label}`,
    type: 'retainer',
    service_type: 'web_management',
    data_sources: sources.map((s) => ({ source: s, enabled: true })),
    created_by: testClient.adminUserId,
  });
  // Active state so the contract's bindings are "live" in the queue view.
  await db.execute({
    sql: `UPDATE contracts SET status = 'active' WHERE id = ?`,
    args: [p.contract_id],
  });
  // Pull binding ids back by source.
  const rows = await db.execute({
    sql: `SELECT id, source FROM data_source_bindings WHERE contract_id = ?`,
    args: [p.contract_id],
  });
  const byId: Record<string, string> = {};
  for (const r of rows.rows) {
    byId[String(r[1])] = String(r[0]);
  }
  return {
    contract_id: p.contract_id,
    binding_ids: byId,
    scheduled_job_id: p.scheduled_job_id ?? null,
  };
}

async function setBindingConfig(
  bindingId: string,
  configJson: string | null,
  enabled: number,
  lastSeenAt: string | null
): Promise<void> {
  await db.execute({
    sql: `UPDATE data_source_bindings
          SET config_json = ?, enabled = ?, last_seen_at = ?
          WHERE id = ?`,
    args: [configJson, enabled, lastSeenAt, bindingId],
  });
}

function validConfig(): string {
  return JSON.stringify({
    connection_id: 'fake-conn-' + nanoid(8),
    property: 'sc-domain:zipkithomes.com',
  });
}

async function main() {
  console.log('=== Slice 18f test: Google sync attention queue section ===');
  console.log();

  // Unit-level sanity: threshold constant is public and reasonable.
  eq(GOOGLE_STALE_THRESHOLD_DAYS, 45, 'GOOGLE_STALE_THRESHOLD_DAYS = 45');

  const testClient = await findTestClient();
  const tag = nanoid(6);

  // Provision three synthetic contracts. Each contract can carry one
  // (gsc, ga4) pair at most due to UNIQUE(contract_id, source).
  //
  //   contractA (gsc, ga4) — holds bindings for cases 1 (gsc) and 2 (ga4)
  //   contractB (gsc, ga4) — holds bindings for cases 3 (gsc) and 4 (ga4, or reuse)
  //   contractC (gsc, ga4) — holds bindings for cases 5 (ga4) and 6 (gsc)
  //
  // This gives us six independent bindings without fighting the unique
  // constraint. Each case picks one binding from the layout above.
  const A = await provisionTestContract(testClient, tag, 'A', ['gsc', 'ga4']);
  const B = await provisionTestContract(testClient, tag, 'B', ['gsc', 'ga4']);
  const C = await provisionTestContract(testClient, tag, 'C', ['gsc', 'ga4']);

  const bindingCase1 = A.binding_ids['gsc']; // misconfigured gsc
  const bindingCase2 = A.binding_ids['ga4']; // never-synced ga4
  const bindingCase3 = B.binding_ids['gsc']; // stale gsc
  const bindingCase4 = B.binding_ids['ga4']; // failed-halted ga4
  const bindingCase5 = C.binding_ids['ga4']; // healthy ga4 (has pending job)
  const bindingCase6 = C.binding_ids['gsc']; // disabled gsc (misconfigured but not surfaced)

  assert(bindingCase1 && bindingCase2 && bindingCase3 && bindingCase4 && bindingCase5 && bindingCase6,
    'all six test binding ids resolved');

  const allTestBindingIds = [
    bindingCase1, bindingCase2, bindingCase3, bindingCase4, bindingCase5, bindingCase6,
  ];

  // Test-owned scheduled_jobs ids we insert directly so cleanup can
  // delete them even if the payload_json LIKE sweep misses one.
  const extraJobIds: string[] = [];

  try {
    // ----- Case 1 setup: misconfigured gsc -----
    await setBindingConfig(bindingCase1, null, 1, null);

    // ----- Case 2 setup: never-synced ga4 (config valid, no jobs) -----
    await setBindingConfig(bindingCase2, validConfig(), 1, null);

    // ----- Case 3 setup: stale gsc (config valid, last_seen_at 90 days ago, no active job) -----
    await setBindingConfig(bindingCase3, validConfig(), 1, isoDaysAgo(90));

    // ----- Case 4 setup: failed-halted ga4 -----
    // Config valid, last_seen_at 10 days ago (within freshness window on
    // its own — it's the failure-shape job history that should win).
    await setBindingConfig(bindingCase4, validConfig(), 1, isoDaysAgo(10));
    // Insert one done sync_ga4 row with a failure-shape last_result.
    const failedJobId = nanoid();
    extraJobIds.push(failedJobId);
    await db.execute({
      sql: `INSERT INTO scheduled_jobs
            (id, job_type, scheduled_for, lease_until, status, last_run_at, last_result, payload_json)
            VALUES (?, 'sync_ga4', ?, NULL, 'done', ?, ?, ?)`,
      args: [
        failedJobId,
        isoDaysAgo(9),
        isoDaysAgo(9),
        `sync_ga4 binding=${bindingCase4} month=2099-01 failed: period 2099-01-01 is locked since 2026-04-15 01:00:00`,
        JSON.stringify({
          binding_id: bindingCase4,
          month: '2099-01',
          created_by: 'test',
        }),
      ],
    });

    // ----- Case 5 setup: healthy ga4 -----
    // Config valid, last_seen_at 5 days ago (within freshness), AND a
    // pending sync_ga4 job in the far future. This binding should NOT
    // surface because the chain is alive.
    await setBindingConfig(bindingCase5, validConfig(), 1, isoDaysAgo(5));
    const healthyJobId = nanoid();
    extraJobIds.push(healthyJobId);
    await db.execute({
      sql: `INSERT INTO scheduled_jobs
            (id, job_type, scheduled_for, lease_until, status, last_run_at, last_result, payload_json)
            VALUES (?, 'sync_ga4', ?, NULL, 'pending', NULL, NULL, ?)`,
      args: [
        healthyJobId,
        '2099-07-02T08:00:00.000Z',
        JSON.stringify({
          binding_id: bindingCase5,
          month: '2099-06',
          created_by: 'test',
        }),
      ],
    });

    // ----- Case 6 setup: disabled gsc (enabled = 0) -----
    // Same shape as case 1 (config NULL) but with enabled=0. The filter
    // enabled=1 in loadGoogleSyncAttentionSection should exclude it.
    await setBindingConfig(bindingCase6, null, 0, null);

    // -------------------------------------------------------------
    // Call loadGoogleSyncAttentionSection directly for precise
    // assertions, then cross-check that loadAdminQueue() composes it.
    // -------------------------------------------------------------
    const section = await loadGoogleSyncAttentionSection();
    assert(section.key === 'google_sync_attention', 'section key');
    assert(typeof section.count === 'number', 'section count is number');
    assert(Array.isArray(section.rows), 'section rows array');

    // Filter only to our test binding ids so real ZipKit bindings (if
    // any) don't pollute the assertions.
    const testRows = section.rows.filter((r) => allTestBindingIds.includes(r.id));

    // -------------------------------------------------------------
    // 18f.1 — misconfigured gsc surfaces
    // -------------------------------------------------------------
    console.log('--- 18f.1 misconfigured gsc surfaces ---');
    const r1 = testRows.find((r) => r.id === bindingCase1);
    assert(r1, 'case 1 row present in section');
    assert(/gsc/i.test(r1!.what), `case 1 what mentions gsc: ${r1!.what}`);
    assert(
      /not configured|needs config|no connection/i.test(r1!.what + ' ' + r1!.why),
      `case 1 reason mentions configuration: ${r1!.what} / ${r1!.why}`
    );
    eq(r1!.link, '/portal/admin/google', 'case 1 link');
    assert(/last sync/i.test(r1!.meta ?? ''), `case 1 meta: ${r1!.meta}`);
    console.log('  OK');
    console.log();

    // -------------------------------------------------------------
    // 18f.2 — never-synced ga4 surfaces
    // -------------------------------------------------------------
    console.log('--- 18f.2 never-synced ga4 surfaces ---');
    const r2 = testRows.find((r) => r.id === bindingCase2);
    assert(r2, 'case 2 row present');
    assert(/ga4/i.test(r2!.what), `case 2 what mentions ga4: ${r2!.what}`);
    assert(
      /never synced/i.test(r2!.what + ' ' + r2!.why),
      `case 2 reason mentions never synced: ${r2!.what}`
    );
    eq(r2!.link, '/portal/admin/google', 'case 2 link');
    console.log('  OK');
    console.log();

    // -------------------------------------------------------------
    // 18f.3 — stale gsc surfaces
    // -------------------------------------------------------------
    console.log('--- 18f.3 stale gsc surfaces ---');
    const r3 = testRows.find((r) => r.id === bindingCase3);
    assert(r3, 'case 3 row present');
    assert(/gsc/i.test(r3!.what), `case 3 what mentions gsc`);
    assert(/stale/i.test(r3!.what), `case 3 what mentions stale: ${r3!.what}`);
    // The why line should quote the day count which must be ≥ 45.
    const m = /(\d+)\s*days/.exec(r3!.why);
    assert(m, `case 3 why has day count: ${r3!.why}`);
    const dayCount = Number(m![1]);
    assert(
      dayCount >= GOOGLE_STALE_THRESHOLD_DAYS,
      `case 3 day count ≥ ${GOOGLE_STALE_THRESHOLD_DAYS}: got ${dayCount}`
    );
    console.log('  OK');
    console.log();

    // -------------------------------------------------------------
    // 18f.4 — failed-halted ga4 surfaces
    // -------------------------------------------------------------
    console.log('--- 18f.4 failed-halted ga4 surfaces ---');
    const r4 = testRows.find((r) => r.id === bindingCase4);
    assert(r4, 'case 4 row present');
    assert(/ga4/i.test(r4!.what), `case 4 what mentions ga4`);
    assert(/halted/i.test(r4!.what), `case 4 what mentions halted: ${r4!.what}`);
    assert(
      /failed:/i.test(r4!.why),
      `case 4 why echoes failure tail: ${r4!.why}`
    );
    assert(
      /locked/i.test(r4!.why),
      `case 4 why preserves the original error substring: ${r4!.why}`
    );
    console.log('  OK');
    console.log();

    // -------------------------------------------------------------
    // 18f.5 — healthy ga4 does NOT surface
    // -------------------------------------------------------------
    console.log('--- 18f.5 healthy ga4 is silent ---');
    const r5 = testRows.find((r) => r.id === bindingCase5);
    eq(r5, undefined, 'case 5 healthy binding has no row');
    console.log('  OK');
    console.log();

    // -------------------------------------------------------------
    // 18f.6 — disabled gsc does NOT surface
    // -------------------------------------------------------------
    console.log('--- 18f.6 disabled gsc is silent ---');
    const r6 = testRows.find((r) => r.id === bindingCase6);
    eq(r6, undefined, 'case 6 disabled binding has no row');
    console.log('  OK');
    console.log();

    // -------------------------------------------------------------
    // Integration: loadAdminQueue composes our section
    // -------------------------------------------------------------
    console.log('--- 18f.integration: loadAdminQueue exposes the section ---');
    const queue = await loadAdminQueue();
    const composed = queue.sections.find((s) => s.key === 'google_sync_attention');
    assert(composed, 'google_sync_attention section present in loadAdminQueue');
    // The same test bindings should appear in the composed section.
    const composedTestRows = composed!.rows.filter((r) =>
      allTestBindingIds.includes(r.id)
    );
    eq(composedTestRows.length, 4, 'exactly 4 of our 6 test bindings surface (1-4)');
    // counts map includes the new section key.
    assert(
      typeof queue.counts.google_sync_attention === 'number',
      'queue.counts.google_sync_attention is set'
    );
    console.log('  OK');
    console.log();
  } finally {
    // --- Cleanup ---
    // 1. Delete scheduled_jobs rows we tracked directly.
    for (const id of extraJobIds) {
      try {
        await db.execute({ sql: 'DELETE FROM scheduled_jobs WHERE id = ?', args: [id] });
      } catch {}
    }
    // 2. Belt-and-braces: wipe any sync_gsc/sync_ga4 scheduled_jobs
    // rows keyed to any of our test bindings, in case one slipped
    // through (e.g. a runner happened to re-enqueue during the test).
    for (const bid of allTestBindingIds) {
      if (!bid) continue;
      await db.execute({
        sql: `DELETE FROM scheduled_jobs
              WHERE (job_type = 'sync_gsc' OR job_type = 'sync_ga4')
                AND payload_json LIKE ?`,
        args: [`%"binding_id":"${bid}"%`],
      });
    }
    // 3. Delete per-contract state — bindings, activity_log,
    // billing scheduled_job (if provisionContract seeded one),
    // then the contract itself via deleteContract with the
    // milestone/project cascade fallback.
    for (const ctx of [A, B, C]) {
      await db.execute({
        sql: 'DELETE FROM data_source_bindings WHERE contract_id = ?',
        args: [ctx.contract_id],
      });
      if (ctx.scheduled_job_id) {
        await db.execute({
          sql: 'DELETE FROM scheduled_jobs WHERE id = ?',
          args: [ctx.scheduled_job_id],
        });
      }
      await db.execute({
        sql: 'DELETE FROM activity_log WHERE entity_type = ? AND entity_id = ?',
        args: ['contract', ctx.contract_id],
      });
      try {
        await deleteContract(ctx.contract_id);
      } catch {
        await db.execute({
          sql: `DELETE FROM milestones WHERE project_id IN (SELECT id FROM projects WHERE contract_id = ?)`,
          args: [ctx.contract_id],
        });
        await db.execute({ sql: 'DELETE FROM projects WHERE contract_id = ?', args: [ctx.contract_id] });
        await db.execute({ sql: 'DELETE FROM contracts WHERE id = ?', args: [ctx.contract_id] });
      }
    }
  }

  console.log('SLICE 18F TEST PASSED ✓');
}

main().catch((err) => {
  console.error();
  console.error('SLICE 18F TEST FAILED:', err);
  process.exit(1);
});
