// Slice 18g — CSV source attention admin-queue section tests.
//
// Six cases covering the three CSV health states plus the two
// silence paths and one integration check:
//
//   1. never_imported ubersuggest_position_tracking surfaces
//      (no imports row, last_seen_at=null)
//   2. stale ubersuggest_site_audit surfaces
//      (latest applied import was 90 days ago)
//   3. last_import_failed ubersuggest_keyword_research surfaces
//      (latest import row has status='failed' with a parse error)
//   4. healthy ubersuggest_position_tracking stays silent
//      (applied import 3 days ago)
//   5. disabled ubersuggest_site_audit stays silent
//      (enabled=0, even with unhealthy underlying state)
//   6. integration: loadAdminQueue() composes csv_source_attention
//      and exposes queue.counts.csv_source_attention
//
// Isolation: three tagged synthetic contracts under ZipKit so
// UNIQUE(contract_id, source) doesn't fight us. Each contract
// supplies the bindings needed for its cases. Imports rows are
// inserted directly and tracked by id for cleanup. The test
// filters the section's rows by the six test binding ids so
// real ZipKit state never contaminates the assertions.
//
// Run:
//   npx tsx scripts/phase1-test-slice18g-csv-source-attention.ts

import 'dotenv/config';
import { createClient } from '@libsql/client';
import { nanoid } from 'nanoid';
import { provisionContract, deleteContract } from '../src/lib/contracts';
import { loadAdminQueue } from '../src/lib/admin-queue';
import {
  loadCsvSourceAttentionSection,
  CSV_STALE_THRESHOLD_DAYS,
  CSV_SOURCE_KINDS,
  CSV_KIND_FORMATS,
} from '../src/lib/jobs/csv-source-health';

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
  sources: string[]
): Promise<{
  contract_id: string;
  binding_ids: Record<string, string>;
  scheduled_job_id: string | null;
}> {
  const p = await provisionContract({
    client_id: testClient.id,
    title: `slice-18g-${tag}-${label}`,
    type: 'retainer',
    service_type: 'web_management',
    data_sources: sources.map((s) => ({ source: s as any, enabled: true })),
    created_by: testClient.adminUserId,
  });
  await db.execute({
    sql: `UPDATE contracts SET status = 'active' WHERE id = ?`,
    args: [p.contract_id],
  });
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

async function setBindingState(
  bindingId: string,
  enabled: number,
  lastSeenAt: string | null
): Promise<void> {
  await db.execute({
    sql: `UPDATE data_source_bindings
          SET enabled = ?, last_seen_at = ?
          WHERE id = ?`,
    args: [enabled, lastSeenAt, bindingId],
  });
}

interface InsertImportArgs {
  clientId: string;
  uploadedBy: string;
  source: string; // CSV format name
  status: 'pending' | 'applied' | 'failed';
  startedAt: string;
  error?: string | null;
  slotIndex: number; // 1..9 — unique far-future period month per test import
}

async function insertImport(args: InsertImportArgs): Promise<string> {
  const id = nanoid();
  const periodId = nanoid();
  const slot = `2099-${String(args.slotIndex).padStart(2, '0')}`;
  await db.execute({
    sql: `INSERT INTO periods (id, client_id, period_type, period_start, period_end)
          VALUES (?, ?, 'month', ?, ?)`,
    args: [periodId, args.clientId, `${slot}-01`, `${slot}-28`],
  });
  await db.execute({
    sql: `INSERT INTO imports
          (id, client_id, period_id, source, original_name, content_hash, status, row_count, uploaded_by, started_at, error, finished_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    args: [
      id,
      args.clientId,
      periodId,
      args.source,
      `slice-18g-${args.source}-${nanoid(4)}.csv`,
      nanoid(16),
      args.status,
      args.uploadedBy,
      args.startedAt,
      args.error ?? null,
      args.status === 'applied' || args.status === 'failed' ? args.startedAt : null,
    ],
  });
  return id;
}

async function main() {
  console.log('=== Slice 18g test: CSV source attention queue section ===');
  console.log();

  // Unit sanity: constants are sane and the inverse mapping is
  // not accidentally empty.
  eq(CSV_STALE_THRESHOLD_DAYS, 45, 'CSV_STALE_THRESHOLD_DAYS = 45');
  eq(CSV_SOURCE_KINDS.length, 3, 'three CSV kinds in scope');
  eq(
    CSV_KIND_FORMATS.ubersuggest_position_tracking.length,
    1,
    'position_tracking maps to one format'
  );
  eq(
    CSV_KIND_FORMATS.ubersuggest_keyword_research.length,
    2,
    'keyword_research maps to two formats'
  );
  eq(
    CSV_KIND_FORMATS.ubersuggest_site_audit.length,
    5,
    'site_audit maps to five formats'
  );

  // The health rule is per (client_id, kind). We cannot use ZipKit
  // because it has real production CSV imports that cross-pollinate
  // every (ZipKit, kind) lookup. Two fully synthetic clients:
  //
  //   Client X: cases 1, 2, 3 (three different kinds on one contract)
  //   Client X: case 5 (disabled, separate contract)
  //   Client Y: case 4 (healthy, on position_tracking — isolated)
  //
  // We still need a real admin user for imports.uploaded_by (FK to
  // users), so findTestClient is used only for the admin id.
  const adminLookup = await findTestClient();
  const adminUserId = adminLookup.adminUserId;
  const tag = nanoid(6);

  const clientX_Id = nanoid();
  const clientY_Id = nanoid();
  await db.execute({
    sql: `INSERT INTO clients (id, name, slug, active) VALUES (?, ?, ?, 1)`,
    args: [clientX_Id, `Slice 18g Client X ${tag}`, `slice-18g-x-${tag}`],
  });
  await db.execute({
    sql: `INSERT INTO clients (id, name, slug, active) VALUES (?, ?, ?, 1)`,
    args: [clientY_Id, `Slice 18g Client Y ${tag}`, `slice-18g-y-${tag}`],
  });

  const A = await provisionTestContract(
    { id: clientX_Id, adminUserId },
    tag,
    'A',
    [
      'ubersuggest_position_tracking',
      'ubersuggest_site_audit',
      'ubersuggest_keyword_research',
    ]
  );
  const C = await provisionTestContract(
    { id: clientX_Id, adminUserId },
    tag,
    'C',
    ['ubersuggest_site_audit']
  );
  const D = await provisionTestContract(
    { id: clientY_Id, adminUserId },
    tag,
    'D',
    ['ubersuggest_position_tracking']
  );

  const bindingCase1 = A.binding_ids['ubersuggest_position_tracking'];
  const bindingCase2 = A.binding_ids['ubersuggest_site_audit'];
  const bindingCase3 = A.binding_ids['ubersuggest_keyword_research'];
  const bindingCase4 = D.binding_ids['ubersuggest_position_tracking'];
  const bindingCase5 = C.binding_ids['ubersuggest_site_audit'];

  assert(
    bindingCase1 && bindingCase2 && bindingCase3 && bindingCase4 && bindingCase5,
    'all five test binding ids resolved'
  );

  const allTestBindingIds = [
    bindingCase1,
    bindingCase2,
    bindingCase3,
    bindingCase4,
    bindingCase5,
  ];

  const insertedImportIds: string[] = [];
  const insertedPeriodClientIds: Array<{ periodStart: string; clientId: string }> = [];

  try {
    // ----- Case 1 setup: never_imported (no imports, no heartbeat) -----
    await setBindingState(bindingCase1, 1, null);

    // ----- Case 2 setup: stale (latest applied 90 days ago) -----
    await setBindingState(bindingCase2, 1, isoDaysAgo(90));
    insertedImportIds.push(
      await insertImport({
        clientId: clientX_Id,
        uploadedBy: adminUserId,
        source: 'issues_overview', // maps to ubersuggest_site_audit
        status: 'applied',
        startedAt: isoDaysAgo(90),
        slotIndex: 5,
      })
    );

    // ----- Case 3 setup: last_import_failed -----
    // Binding heartbeat is recent (healthy if alone), but the
    // latest import row says the last attempt failed. Failed
    // rule should win regardless of last_seen_at.
    await setBindingState(bindingCase3, 1, isoDaysAgo(5));
    insertedImportIds.push(
      await insertImport({
        clientId: clientX_Id,
        uploadedBy: adminUserId,
        source: 'keyword_research', // maps to ubersuggest_keyword_research
        status: 'failed',
        startedAt: isoDaysAgo(1),
        error: 'malformed header on row 3',
        slotIndex: 6,
      })
    );

    // ----- Case 4 setup: healthy applied on client Y -----
    // Recent applied import AND recent heartbeat, on a client
    // that's isolated so the (client_id, kind) query doesn't
    // cross-pollinate with case 1 on client X.
    await setBindingState(bindingCase4, 1, isoDaysAgo(3));
    insertedImportIds.push(
      await insertImport({
        clientId: clientY_Id,
        uploadedBy: adminUserId,
        source: 'position_tracking',
        status: 'applied',
        startedAt: isoDaysAgo(3),
        slotIndex: 7,
      })
    );

    // ----- Case 5 setup: disabled -----
    // Disabled binding with an unhealthy (never_imported-like)
    // underlying state. Should be silent because enabled=0.
    await setBindingState(bindingCase5, 0, null);

    // -------------------------------------------------------------
    // Load the section directly for precise assertions, then
    // cross-check the composed loadAdminQueue() output.
    // -------------------------------------------------------------
    const section = await loadCsvSourceAttentionSection();
    eq(section.key, 'csv_source_attention', 'section key');
    assert(Array.isArray(section.rows), 'rows array');

    const testRows = section.rows.filter((r) => allTestBindingIds.includes(r.id));

    // -------------------------------------------------------------
    // 18g.1 — never_imported ubersuggest_position_tracking surfaces
    // -------------------------------------------------------------
    console.log('--- 18g.1 never_imported ubersuggest_position_tracking surfaces ---');
    const r1 = testRows.find((r) => r.id === bindingCase1);
    assert(r1, 'case 1 row present');
    assert(
      /ubersuggest_position_tracking/i.test(r1!.what),
      `case 1 what names the kind: ${r1!.what}`
    );
    assert(
      /never|has never/i.test(r1!.what + ' ' + r1!.why),
      `case 1 reason mentions 'never': ${r1!.what} / ${r1!.why}`
    );
    eq(r1!.link, '/portal/admin/contracts', 'case 1 link');
    assert(/last import/i.test(r1!.meta ?? ''), `case 1 meta: ${r1!.meta}`);
    console.log('  OK');
    console.log();

    // -------------------------------------------------------------
    // 18g.2 — stale ubersuggest_site_audit surfaces
    // -------------------------------------------------------------
    console.log('--- 18g.2 stale ubersuggest_site_audit surfaces ---');
    const r2 = testRows.find((r) => r.id === bindingCase2);
    assert(r2, 'case 2 row present');
    assert(
      /ubersuggest_site_audit/i.test(r2!.what),
      `case 2 what names the kind: ${r2!.what}`
    );
    assert(/stale/i.test(r2!.what), `case 2 what mentions stale: ${r2!.what}`);
    const dayMatch = /(\d+)\s*days/.exec(r2!.why);
    assert(dayMatch, `case 2 why has day count: ${r2!.why}`);
    const dayCount = Number(dayMatch![1]);
    assert(
      dayCount >= CSV_STALE_THRESHOLD_DAYS,
      `case 2 day count ≥ ${CSV_STALE_THRESHOLD_DAYS}: got ${dayCount}`
    );
    console.log('  OK');
    console.log();

    // -------------------------------------------------------------
    // 18g.3 — last_import_failed surfaces with error tail
    // -------------------------------------------------------------
    console.log('--- 18g.3 last_import_failed ubersuggest_keyword_research surfaces ---');
    const r3 = testRows.find((r) => r.id === bindingCase3);
    assert(r3, 'case 3 row present');
    assert(
      /ubersuggest_keyword_research/i.test(r3!.what),
      `case 3 what names the kind: ${r3!.what}`
    );
    assert(/failed/i.test(r3!.what), `case 3 what mentions failed: ${r3!.what}`);
    assert(
      /malformed header on row 3/.test(r3!.why),
      `case 3 why preserves the original error substring: ${r3!.why}`
    );
    console.log('  OK');
    console.log();

    // -------------------------------------------------------------
    // 18g.4 — healthy applied stays silent
    // -------------------------------------------------------------
    console.log('--- 18g.4 healthy ubersuggest_position_tracking stays silent ---');
    const r4 = testRows.find((r) => r.id === bindingCase4);
    eq(r4, undefined, 'case 4 healthy binding has no row');
    console.log('  OK');
    console.log();

    // -------------------------------------------------------------
    // 18g.5 — disabled stays silent
    // -------------------------------------------------------------
    console.log('--- 18g.5 disabled ubersuggest_site_audit stays silent ---');
    const r5 = testRows.find((r) => r.id === bindingCase5);
    eq(r5, undefined, 'case 5 disabled binding has no row');
    console.log('  OK');
    console.log();

    // -------------------------------------------------------------
    // 18g.integration — loadAdminQueue composes the new section
    // alongside the existing google_sync_attention
    // -------------------------------------------------------------
    console.log('--- 18g.integration: loadAdminQueue exposes the new section ---');
    const queue = await loadAdminQueue();
    const composed = queue.sections.find((s) => s.key === 'csv_source_attention');
    assert(composed, 'csv_source_attention section present in loadAdminQueue');
    assert(
      queue.sections.find((s) => s.key === 'google_sync_attention'),
      'google_sync_attention section still present (additive, not replacement)'
    );
    const composedTestRows = composed!.rows.filter((r) =>
      allTestBindingIds.includes(r.id)
    );
    eq(
      composedTestRows.length,
      3,
      'exactly 3 of our 5 test bindings surface (cases 1-3)'
    );
    assert(
      typeof queue.counts.csv_source_attention === 'number',
      'queue.counts.csv_source_attention is set'
    );
    console.log('  OK');
    console.log();
  } finally {
    // --- Cleanup ---
    // 1. Inserted imports — delete by tracked id, and also their
    // dedicated synthetic periods so we don't leave 2099 phantom
    // periods on ZipKit.
    for (const id of insertedImportIds) {
      try {
        const pr = await db.execute({
          sql: 'SELECT period_id FROM imports WHERE id = ?',
          args: [id],
        });
        const periodId = pr.rows[0]?.[0];
        await db.execute({ sql: 'DELETE FROM imports WHERE id = ?', args: [id] });
        if (periodId) {
          await db.execute({ sql: 'DELETE FROM periods WHERE id = ?', args: [String(periodId)] });
        }
      } catch {}
    }
    // Belt-and-braces: nuke any imports whose original_name was
    // tagged by this test (handles a partial insert that might
    // have slipped past id tracking).
    await db.execute({
      sql: `DELETE FROM imports WHERE original_name LIKE 'slice-18g-%'`,
    });

    // 2. Per-contract cascade — bindings, activity, auto-seeded
    // scheduled_job, then contract (with milestone/project fallback).
    for (const ctx of [A, C, D]) {
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

    // 3. Delete the two synthetic clients. Belt-and-braces any
    // stragglers (imports, periods) first so client deletion
    // doesn't hit an FK failure, then delete the client rows.
    for (const cid of [clientX_Id, clientY_Id]) {
      try {
        await db.execute({
          sql: `DELETE FROM imports WHERE client_id = ?`,
          args: [cid],
        });
        await db.execute({
          sql: `DELETE FROM periods WHERE client_id = ?`,
          args: [cid],
        });
        await db.execute({
          sql: `DELETE FROM clients WHERE id = ?`,
          args: [cid],
        });
      } catch {}
    }
  }

  console.log('SLICE 18G TEST PASSED ✓');
}

main().catch((err) => {
  console.error();
  console.error('SLICE 18G TEST FAILED:', err);
  process.exit(1);
});
