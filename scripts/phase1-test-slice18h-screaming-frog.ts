// Slice 18h — Screaming Frog CSV ingestion end-to-end test.
//
// Seven blocks covering the detect/parse/ingest/heartbeat/health
// pipeline plus the admin-queue integration:
//
//   1. detectFormat recognizes the Screaming Frog CSV
//   2. parseScreamingFrogResponseCodesV2 groups by status bucket
//      and produces the exact StagedIssue[] the apply step needs
//   3. parser skips healthy 2xx rows (no noise row)
//   4. csvFormatToDataSourceKind returns 'screaming_frog_issues'
//   5. end-to-end ingestCSVViaSnapshots writes issue_snapshots rows
//      under source='screaming_frog_response_codes' and stamps the
//      screaming_frog_issues binding's last_seen_at
//   6. the narrator's broken-link query can read the ingested 4xx
//      row with the exact issue_name it looks for
//   7. loadCsvSourceAttentionSection now honestly classifies a
//      never-imported screaming_frog_issues binding on a synthetic
//      client — proving the admin queue also extended its truth
//
// Isolation: far-future period '2099-10' on ZipKit with preflight
// guard, plus ONE separate synthetic client for case 7. Cleanup
// via tracked ids + belt-and-braces deletes.
//
// Run:
//   npx tsx scripts/phase1-test-slice18h-screaming-frog.ts

import 'dotenv/config';
import { createClient } from '@libsql/client';
import { nanoid } from 'nanoid';

import { detectFormat } from '../src/lib/csv/detector';
import { parseScreamingFrogResponseCodesV2 } from '../src/lib/csv/parsers/screaming-frog-response-codes';
import { csvFormatToDataSourceKind } from '../src/lib/data-sources';
import { ingestCSVViaSnapshots } from '../src/lib/csv/ingest-v2';
import { loadCsvSourceAttentionSection } from '../src/lib/jobs/csv-source-health';
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

async function readLastSeen(contractId: string, source: string): Promise<string | null> {
  const r = await db.execute({
    sql: `SELECT last_seen_at FROM data_source_bindings WHERE contract_id = ? AND source = ?`,
    args: [contractId, source],
  });
  if (r.rows.length === 0) return null;
  return (r.rows[0][0] as string | null) ?? null;
}

// Minimal Screaming Frog "Response Codes: All" fixture. Column
// order matches a real export. Status codes chosen to exercise
// every bucket: 200 (healthy, silent), 301 (3xx medium), 404
// (4xx critical — lights up narrator), 500 (5xx critical),
// empty string (no-response medium).
const SF_FIXTURE = [
  'Address,Content Type,Status Code,Status,Indexability,Indexability Status',
  'https://zipkithomes.com/,text/html,200,OK,Indexable,',
  'https://zipkithomes.com/about,text/html,200,OK,Indexable,',
  'https://zipkithomes.com/old-page,text/html,301,Moved Permanently,Non-Indexable,Redirected',
  'https://zipkithomes.com/legacy,text/html,301,Moved Permanently,Non-Indexable,Redirected',
  'https://zipkithomes.com/broken-1,text/html,404,Not Found,Non-Indexable,Client Error',
  'https://zipkithomes.com/broken-2,text/html,404,Not Found,Non-Indexable,Client Error',
  'https://zipkithomes.com/broken-3,text/html,404,Not Found,Non-Indexable,Client Error',
  'https://zipkithomes.com/down,text/html,500,Internal Server Error,Non-Indexable,Server Error',
  'https://zipkithomes.com/timeout,text/html,,,Non-Indexable,',
].join('\n');

// HEALTHY-only fixture for case 18h.3
const SF_FIXTURE_HEALTHY_ONLY = [
  'Address,Content Type,Status Code,Status,Indexability,Indexability Status',
  'https://zipkithomes.com/,text/html,200,OK,Indexable,',
  'https://zipkithomes.com/about,text/html,200,OK,Indexable,',
  'https://zipkithomes.com/contact,text/html,200,OK,Indexable,',
].join('\n');

async function main() {
  console.log('=== Slice 18h test: Screaming Frog CSV ingest end-to-end ===');
  console.log();

  // -------------------------------------------------------------
  // 18h.1 — detector recognizes the format
  // -------------------------------------------------------------
  console.log('--- 18h.1 detector recognizes Screaming Frog response-codes CSV ---');
  const det = detectFormat(SF_FIXTURE, 'response_codes_all.csv');
  eq(det.format, 'screaming_frog_response_codes', 'detected format');
  assert(det.headers.includes('address'), 'headers include address');
  assert(det.headers.includes('status code'), 'headers include status code');
  console.log('  OK');
  console.log();

  // -------------------------------------------------------------
  // 18h.2 — parser groups by bucket correctly
  // -------------------------------------------------------------
  console.log('--- 18h.2 parser groups by status bucket ---');
  const parsed = parseScreamingFrogResponseCodesV2(SF_FIXTURE);
  assert(parsed.issues, 'parser produced issues');
  const issues = parsed.issues!;
  // 4 buckets expected: 4xx(3), 5xx(1), 3xx(2), none(1). No 2xx row.
  eq(issues.length, 4, 'four non-2xx buckets');

  const byName: Record<string, (typeof issues)[number]> = {};
  for (const i of issues) byName[i.issue_name] = i;

  assert(
    byName['Response Codes: Internal Client Error (4xx)'],
    '4xx bucket exists (exact narrator-matching name)'
  );
  eq(
    byName['Response Codes: Internal Client Error (4xx)'].affected_urls,
    3,
    '4xx count = 3'
  );
  eq(
    byName['Response Codes: Internal Client Error (4xx)'].priority,
    'critical',
    '4xx priority = critical'
  );

  assert(byName['Response Codes: Server Error (5xx)'], '5xx bucket exists');
  eq(byName['Response Codes: Server Error (5xx)'].affected_urls, 1, '5xx count = 1');
  eq(byName['Response Codes: Server Error (5xx)'].priority, 'critical', '5xx priority');

  assert(byName['Response Codes: Redirection (3xx)'], '3xx bucket exists');
  eq(byName['Response Codes: Redirection (3xx)'].affected_urls, 2, '3xx count = 2');
  eq(byName['Response Codes: Redirection (3xx)'].priority, 'medium', '3xx priority');

  assert(
    byName['Response Codes: Blocked or Unknown (no response)'],
    'no-response bucket exists'
  );
  eq(
    byName['Response Codes: Blocked or Unknown (no response)'].affected_urls,
    1,
    'no-response count = 1'
  );

  // No 2xx row anywhere
  assert(
    !issues.some((i) => /2xx|success/i.test(i.issue_name)),
    'no healthy 2xx row emitted'
  );

  // pct_of_total shape check — 9 total rows → 4xx = 3/9 ≈ 33.3
  const fourxxPct = byName['Response Codes: Internal Client Error (4xx)'].pct_of_total;
  assert(
    fourxxPct !== null && Math.abs(fourxxPct - 33.3) < 0.5,
    `4xx pct_of_total ≈ 33.3 (got ${fourxxPct})`
  );
  console.log('  OK');
  console.log();

  // -------------------------------------------------------------
  // 18h.3 — parser skips healthy 2xx-only fixture
  // -------------------------------------------------------------
  console.log('--- 18h.3 parser skips healthy-only fixture ---');
  const healthy = parseScreamingFrogResponseCodesV2(SF_FIXTURE_HEALTHY_ONLY);
  eq(healthy.issues?.length ?? 0, 0, 'zero issues from 2xx-only input');
  console.log('  OK');
  console.log();

  // -------------------------------------------------------------
  // 18h.4 — csvFormatToDataSourceKind maps correctly
  // -------------------------------------------------------------
  console.log('--- 18h.4 csvFormatToDataSourceKind ---');
  eq(
    csvFormatToDataSourceKind('screaming_frog_response_codes'),
    'screaming_frog_issues',
    'new format maps to screaming_frog_issues'
  );
  console.log('  OK');
  console.log();

  // -------------------------------------------------------------
  // 18h.5 — end-to-end ingest writes rows and stamps heartbeat
  // -------------------------------------------------------------
  console.log('--- 18h.5 ingestCSVViaSnapshots end-to-end ---');
  const testClient = await findTestClient();

  // Preflight: no leftover 2099-10 data on ZipKit for screaming_frog_response_codes.
  const preflight = await db.execute({
    sql: `SELECT COUNT(*) FROM periods WHERE client_id = ? AND period_start = '2099-10-01'`,
    args: [testClient.id],
  });
  assert(
    Number(preflight.rows[0][0]) === 0,
    'preflight: no pre-existing 2099-10 period for ZipKit'
  );

  // Provision a synthetic contract with BOTH a screaming_frog_issues
  // binding AND a ubersuggest_position_tracking binding so we can
  // assert the source filter: only the SF binding's heartbeat gets
  // stamped, not the PT binding's.
  const provision = await provisionContract({
    client_id: testClient.id,
    title: `slice-18h-test-${nanoid(6)}`,
    type: 'retainer',
    service_type: 'web_management',
    data_sources: [
      { source: 'screaming_frog_issues', enabled: true },
      { source: 'ubersuggest_position_tracking', enabled: true },
    ],
    created_by: testClient.adminUserId,
  });
  await db.execute({
    sql: `UPDATE contracts SET status = 'active' WHERE id = ?`,
    args: [provision.contract_id],
  });

  // Null both heartbeats so we can observe which one gets stamped.
  await db.execute({
    sql: `UPDATE data_source_bindings SET last_seen_at = NULL WHERE contract_id = ?`,
    args: [provision.contract_id],
  });

  let createdPeriodId: string | null = null;
  let createdImportId: string | null = null;
  let syntheticClientId: string | null = null;
  let syntheticContractId: string | null = null;
  let syntheticScheduledJobId: string | null = null;

  try {
    // Salt the fixture so re-running the test produces a fresh
    // content_hash (avoids the noop branch on repeated runs).
    const salted = SF_FIXTURE.replace(
      'https://zipkithomes.com/,',
      `https://zipkithomes.com/?r=${nanoid(6)},`
    );

    const result = await ingestCSVViaSnapshots(
      salted,
      testClient.id,
      '2099-10',
      'response_codes_all.csv',
      testClient.adminUserId
    );
    eq(result.status, 'applied', 'ingest applied');
    eq(result.format, 'screaming_frog_response_codes', 'ingest format');
    assert(result.rowCount === 4, `issue count = 4 (got ${result.rowCount})`);

    createdPeriodId = result.periodId;
    createdImportId = result.importId;

    // Assert issue_snapshots rows landed under the new source.
    const snaps = await db.execute({
      sql: `SELECT issue_name, priority, affected_urls, pct_of_total
            FROM issue_snapshots
            WHERE client_id = ? AND period_id = ? AND source = 'screaming_frog_response_codes'
            ORDER BY issue_name`,
      args: [testClient.id, createdPeriodId],
    });
    eq(snaps.rows.length, 4, 'four issue_snapshots rows inserted');

    const fourxx = snaps.rows.find(
      (r) => String(r[0]) === 'Response Codes: Internal Client Error (4xx)'
    );
    assert(fourxx, '4xx row present in DB');
    eq(Number(fourxx![2]), 3, '4xx affected_urls = 3 in DB');
    eq(String(fourxx![1]), 'critical', '4xx priority in DB');

    // Source filter proof — SF binding stamped, PT binding still null.
    const sfStamp = await readLastSeen(provision.contract_id, 'screaming_frog_issues');
    assert(sfStamp !== null, 'screaming_frog_issues binding heartbeat stamped');
    const stampTs = new Date(sfStamp! + (sfStamp!.includes('Z') ? '' : 'Z')).getTime();
    const skew = Math.abs(Date.now() - stampTs);
    assert(
      skew < 5 * 60 * 1000,
      `stamp within 5 min of now (skew=${skew}ms, raw=${sfStamp})`
    );

    const ptStamp = await readLastSeen(provision.contract_id, 'ubersuggest_position_tracking');
    eq(
      ptStamp,
      null,
      'ubersuggest_position_tracking binding still null (source filter honored)'
    );
    console.log('  OK');
    console.log();

    // ----------------------------------------------------------
    // 18h.6 — narrator's query reads the 4xx row with the exact
    // name and priority it needs for the broken-link sentence.
    // ----------------------------------------------------------
    console.log('--- 18h.6 narrator query sees the 4xx row ---');
    const narratorQuery = await db.execute({
      sql: `SELECT issue_name, priority, affected_urls, pct_of_total
            FROM issue_snapshots
            WHERE client_id = ? AND period_id = ?
              AND issue_name = 'Response Codes: Internal Client Error (4xx)'
            ORDER BY
              CASE LOWER(COALESCE(priority, ''))
                WHEN 'critical' THEN 0
                WHEN 'high' THEN 1
                WHEN 'medium' THEN 2
                WHEN 'low' THEN 3
                ELSE 4
              END,
              COALESCE(affected_urls, 0) DESC`,
      args: [testClient.id, createdPeriodId],
    });
    assert(narratorQuery.rows.length >= 1, 'narrator query finds the 4xx row');
    const nr = narratorQuery.rows[0];
    eq(String(nr[0]), 'Response Codes: Internal Client Error (4xx)', 'narrator sees exact name');
    eq(String(nr[1]), 'critical', 'narrator sees critical priority');
    eq(Number(nr[2]), 3, 'narrator sees affected_urls = 3');
    console.log('  OK');
    console.log();

    // ----------------------------------------------------------
    // 18h.7 — csv_source_attention now handles screaming_frog_issues
    // on a fresh synthetic client so ZipKit's real state doesn't
    // pollute the section filter.
    // ----------------------------------------------------------
    console.log('--- 18h.7 csv_source_attention classifies screaming_frog_issues ---');
    syntheticClientId = nanoid();
    await db.execute({
      sql: `INSERT INTO clients (id, name, slug, active) VALUES (?, ?, ?, 1)`,
      args: [
        syntheticClientId,
        `Slice 18h Second Client ${nanoid(4)}`,
        `slice-18h-second-${nanoid(6)}`,
      ],
    });

    const syntheticProvision = await provisionContract({
      client_id: syntheticClientId,
      title: `slice-18h-second-${nanoid(6)}`,
      type: 'retainer',
      service_type: 'web_management',
      data_sources: [{ source: 'screaming_frog_issues', enabled: true }],
      created_by: testClient.adminUserId,
    });
    syntheticContractId = syntheticProvision.contract_id;
    syntheticScheduledJobId = syntheticProvision.scheduled_job_id ?? null;
    await db.execute({
      sql: `UPDATE contracts SET status = 'active' WHERE id = ?`,
      args: [syntheticContractId],
    });
    const sfBindingId = syntheticProvision.binding_ids[0];
    assert(sfBindingId, 'synthetic SF binding id returned');

    const section = await loadCsvSourceAttentionSection();
    const sfRow = section.rows.find((r) => r.id === sfBindingId);
    assert(sfRow, 'SF binding surfaces in csv_source_attention');
    assert(
      /screaming_frog_issues/i.test(sfRow!.what),
      `what names the kind: ${sfRow!.what}`
    );
    assert(
      /never/i.test(sfRow!.what + ' ' + sfRow!.why),
      `never-imported phrasing: ${sfRow!.what} / ${sfRow!.why}`
    );
    eq(sfRow!.link, '/portal/admin/contracts', 'row link');
    console.log('  OK');
    console.log();
  } finally {
    // --- Cleanup ---
    // 1. Drop issue_snapshots + imports + period for the 2099-10 slot.
    if (createdPeriodId) {
      await db.execute({
        sql: `DELETE FROM issue_snapshots WHERE period_id = ?`,
        args: [createdPeriodId],
      });
      await db.execute({
        sql: `DELETE FROM imports WHERE period_id = ?`,
        args: [createdPeriodId],
      });
      await db.execute({
        sql: `DELETE FROM periods WHERE id = ?`,
        args: [createdPeriodId],
      });
    } else if (createdImportId) {
      await db.execute({
        sql: `DELETE FROM imports WHERE id = ?`,
        args: [createdImportId],
      });
    }

    // 2. Primary ZipKit contract teardown.
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
      await db.execute({
        sql: 'DELETE FROM projects WHERE contract_id = ?',
        args: [provision.contract_id],
      });
      await db.execute({
        sql: 'DELETE FROM contracts WHERE id = ?',
        args: [provision.contract_id],
      });
    }

    // 3. Synthetic second client teardown.
    if (syntheticContractId) {
      await db.execute({
        sql: 'DELETE FROM data_source_bindings WHERE contract_id = ?',
        args: [syntheticContractId],
      });
      if (syntheticScheduledJobId) {
        await db.execute({
          sql: 'DELETE FROM scheduled_jobs WHERE id = ?',
          args: [syntheticScheduledJobId],
        });
      }
      await db.execute({
        sql: 'DELETE FROM activity_log WHERE entity_type = ? AND entity_id = ?',
        args: ['contract', syntheticContractId],
      });
      try {
        await deleteContract(syntheticContractId);
      } catch {
        await db.execute({
          sql: `DELETE FROM milestones WHERE project_id IN (SELECT id FROM projects WHERE contract_id = ?)`,
          args: [syntheticContractId],
        });
        await db.execute({
          sql: 'DELETE FROM projects WHERE contract_id = ?',
          args: [syntheticContractId],
        });
        await db.execute({
          sql: 'DELETE FROM contracts WHERE id = ?',
          args: [syntheticContractId],
        });
      }
    }
    if (syntheticClientId) {
      try {
        await db.execute({
          sql: `DELETE FROM imports WHERE client_id = ?`,
          args: [syntheticClientId],
        });
        await db.execute({
          sql: `DELETE FROM periods WHERE client_id = ?`,
          args: [syntheticClientId],
        });
        await db.execute({
          sql: `DELETE FROM clients WHERE id = ?`,
          args: [syntheticClientId],
        });
      } catch {}
    }
  }

  console.log('SLICE 18H TEST PASSED ✓');
}

main().catch((err) => {
  console.error();
  console.error('SLICE 18H TEST FAILED:', err);
  process.exit(1);
});
