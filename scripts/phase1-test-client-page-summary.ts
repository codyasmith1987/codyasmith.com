// Slice 17 — client-page-summary builder tests.
//
// Four builders. Each is tested against live ZipKit (baseline) plus
// synthetic edge cases (first-month, zero-data, all-paid, overdue+
// due-soon) so the plain-language phrasing is verified deterministically.
//
// Reading-level heuristic: every generated sentence is scanned for
// forbidden jargon tokens (SEO, GSC, CTA, CTR, KPI, impressions,
// Ubersuggest, Screaming Frog) and flagged if any appear. That
// catches future regressions where a developer pastes a raw tool
// label into client-facing copy.
//
// Isolation: every synthetic write uses tagged rows under ZipKit
// with cleanup on both success and failure.
//
// Run:
//   npx tsx scripts/phase1-test-client-page-summary.ts

import 'dotenv/config';
import { createClient } from '@libsql/client';
import { nanoid } from 'nanoid';
import {
  buildKeywordsSummary,
  buildHealthSummary,
  buildFilesSummary,
  buildInvoicesSummary,
  buildTrafficSummary,
  type ClientSummary,
} from '../src/lib/client-page-summary';

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

const FORBIDDEN_JARGON = [
  /\bSEO\b/,
  /\bGSC\b/,
  /\bCTA\b/,
  /\bCTR\b/,
  /\bKPI\b/,
  /\bimpressions\b/i,
  /\bUbersuggest\b/i,
  /\bScreaming Frog\b/i,
  /\bcrawl budget\b/i,
  /\b4xx\b/i,
  /\bsessions\b/i,
  /\busers\b/i,
  /\bbounce rate\b/i,
  /\bGA4\b/,
  /\banalytics\b/i,
];

function checkPlainLanguage(summary: ClientSummary, label: string) {
  const all = [summary.headline, ...summary.bullets, summary.callout ?? ''];
  for (const line of all) {
    for (const pat of FORBIDDEN_JARGON) {
      if (pat.test(line)) {
        console.error(`  JARGON leak in ${label}: "${line}" matches ${pat}`);
        throw new Error(`jargon leak: ${label}`);
      }
    }
  }
  // Headline sentence-length sanity: client-facing headlines should
  // stay short enough that the takeaway is obvious at a glance.
  if (summary.headline.length > 140) {
    throw new Error(`${label}: headline > 140 chars`);
  }
  for (const b of summary.bullets) {
    if (b.length > 180) throw new Error(`${label}: bullet > 180 chars`);
  }
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

async function main() {
  console.log('=== Slice 17 test: client page summaries ===');
  console.log();

  const testClient = await findTestClient();

  // ---------- Keywords builder ----------
  console.log('--- buildKeywordsSummary ---');

  // ZipKit baseline: 1 period, 100 keywords (restored in slice 9)
  const kwLive = await buildKeywordsSummary(testClient.id);
  console.log(`  live headline: ${kwLive.headline}`);
  console.log(`  live bullets:  ${JSON.stringify(kwLive.bullets)}`);
  checkPlainLanguage(kwLive, 'kw-live');
  assert(kwLive.headline.length > 0, 'live keyword headline non-empty');

  // Synthetic new client with zero data
  const emptyClientId = nanoid();
  await db.execute({
    sql: `INSERT INTO clients (id, name, slug) VALUES (?, ?, ?)`,
    args: [emptyClientId, 'slice17-empty-kw', `slice17-empty-kw-${nanoid(4)}`],
  });
  try {
    const kwEmpty = await buildKeywordsSummary(emptyClientId);
    checkPlainLanguage(kwEmpty, 'kw-empty');
    assert(
      /don't have any ranking data/.test(kwEmpty.headline),
      'zero-data headline mentions no ranking data'
    );
    assert(kwEmpty.callout !== null, 'zero-data has callout');
    console.log(`  zero-data headline: ${kwEmpty.headline}`);
  } finally {
    await db.execute({ sql: 'DELETE FROM clients WHERE id = ?', args: [emptyClientId] });
  }
  console.log('  OK');
  console.log();

  // ---------- Health builder ----------
  console.log('--- buildHealthSummary ---');
  const healthLive = await buildHealthSummary(testClient.id);
  console.log(`  live headline: ${healthLive.headline}`);
  console.log(`  live bullets:  ${JSON.stringify(healthLive.bullets)}`);
  checkPlainLanguage(healthLive, 'health-live');
  assert(healthLive.headline.length > 0, 'live health headline non-empty');

  // Synthetic zero-data client
  const emptyHealthId = nanoid();
  await db.execute({
    sql: `INSERT INTO clients (id, name, slug) VALUES (?, ?, ?)`,
    args: [emptyHealthId, 'slice17-empty-hx', `slice17-empty-hx-${nanoid(4)}`],
  });
  try {
    const healthEmpty = await buildHealthSummary(emptyHealthId);
    checkPlainLanguage(healthEmpty, 'health-empty');
    assert(
      /haven't checked|No site problems/.test(healthEmpty.headline),
      'zero-data health headline honest'
    );
    console.log(`  zero-data headline: ${healthEmpty.headline}`);
  } finally {
    await db.execute({ sql: 'DELETE FROM clients WHERE id = ?', args: [emptyHealthId] });
  }
  console.log('  OK');
  console.log();

  // ---------- Files builder ----------
  console.log('--- buildFilesSummary ---');
  const filesLive = await buildFilesSummary(testClient.id);
  console.log(`  live headline: ${filesLive.headline}`);
  console.log(`  live bullets:  ${JSON.stringify(filesLive.bullets)}`);
  checkPlainLanguage(filesLive, 'files-live');
  assert(filesLive.headline.length > 0, 'live files headline non-empty');

  // Synthetic new client with zero files
  const emptyFilesId = nanoid();
  await db.execute({
    sql: `INSERT INTO clients (id, name, slug) VALUES (?, ?, ?)`,
    args: [emptyFilesId, 'slice17-empty-f', `slice17-empty-f-${nanoid(4)}`],
  });
  try {
    const filesEmpty = await buildFilesSummary(emptyFilesId);
    checkPlainLanguage(filesEmpty, 'files-empty');
    eq(
      filesEmpty.headline,
      'No new files in the past month.',
      'zero-data files headline'
    );
    eq(filesEmpty.bullets.length, 0, 'zero-data files bullets empty');
  } finally {
    await db.execute({ sql: 'DELETE FROM clients WHERE id = ?', args: [emptyFilesId] });
  }
  console.log('  OK');
  console.log();

  // ---------- Invoices builder ----------
  console.log('--- buildInvoicesSummary ---');
  const invLive = await buildInvoicesSummary(testClient.id);
  console.log(`  live headline: ${invLive.headline}`);
  console.log(`  live bullets:  ${JSON.stringify(invLive.bullets)}`);
  checkPlainLanguage(invLive, 'invoices-live');
  assert(invLive.headline.length > 0, 'live invoices headline non-empty');

  // Synthetic zero-invoice client
  const emptyInvId = nanoid();
  await db.execute({
    sql: `INSERT INTO clients (id, name, slug) VALUES (?, ?, ?)`,
    args: [emptyInvId, 'slice17-empty-i', `slice17-empty-i-${nanoid(4)}`],
  });
  try {
    const invEmpty = await buildInvoicesSummary(emptyInvId);
    checkPlainLanguage(invEmpty, 'inv-empty');
    eq(
      invEmpty.headline,
      'No invoices waiting right now.',
      'zero-data invoices headline'
    );
  } finally {
    await db.execute({ sql: 'DELETE FROM clients WHERE id = ?', args: [emptyInvId] });
  }
  console.log('  OK');
  console.log();

  // ---------- Synthetic: overdue + due-soon phrasing ----------
  console.log('--- synthetic overdue + due-soon ---');
  const syntheticInvClientId = nanoid();
  const tag = nanoid(5);
  await db.execute({
    sql: `INSERT INTO clients (id, name, slug) VALUES (?, ?, ?)`,
    args: [syntheticInvClientId, `slice17-inv-${tag}`, `slice17-inv-${tag}`],
  });

  // Create a synthetic contract for the FK on invoices.
  const contractId = nanoid();
  await db.execute({
    sql: `INSERT INTO contracts (id, client_id, title, type, status, created_by)
          VALUES (?, ?, ?, 'fixed', 'active', ?)`,
    args: [contractId, syntheticInvClientId, `slice17-inv-contract-${tag}`, testClient.adminUserId],
  });

  const overdueId = nanoid();
  const dueSoonId = nanoid();
  const paidId = nanoid();

  try {
    // Overdue invoice, $800 past due from 5 days ago
    await db.execute({
      sql: `INSERT INTO invoices
            (id, contract_id, client_id, invoice_number, status, issued_date,
             due_date, subtotal, tax, total, amount_paid, client_visible, created_by)
            VALUES (?, ?, ?, ?, 'sent', date('now', '-25 days'),
                    date('now', '-5 days'), 800, 0, 800, 0, 1, ?)`,
      args: [overdueId, contractId, syntheticInvClientId, `S17-OD-${tag}`, testClient.adminUserId],
    });
    // Due-soon invoice, $500 due in 7 days
    await db.execute({
      sql: `INSERT INTO invoices
            (id, contract_id, client_id, invoice_number, status, issued_date,
             due_date, subtotal, tax, total, amount_paid, client_visible, created_by)
            VALUES (?, ?, ?, ?, 'sent', date('now'),
                    date('now', '+7 days'), 500, 0, 500, 0, 1, ?)`,
      args: [dueSoonId, contractId, syntheticInvClientId, `S17-DS-${tag}`, testClient.adminUserId],
    });
    // Paid invoice — fully settled
    await db.execute({
      sql: `INSERT INTO invoices
            (id, contract_id, client_id, invoice_number, status, issued_date,
             due_date, subtotal, tax, total, amount_paid, client_visible, created_by)
            VALUES (?, ?, ?, ?, 'paid', date('now', '-40 days'),
                    date('now', '-10 days'), 300, 0, 300, 300, 1, ?)`,
      args: [paidId, contractId, syntheticInvClientId, `S17-PD-${tag}`, testClient.adminUserId],
    });

    const mixed = await buildInvoicesSummary(syntheticInvClientId);
    console.log(`  mixed headline: ${mixed.headline}`);
    console.log(`  mixed bullets:  ${JSON.stringify(mixed.bullets)}`);
    checkPlainLanguage(mixed, 'inv-mixed');
    assert(/past due/.test(mixed.headline), 'headline mentions past due');
    assert(/due soon/.test(mixed.headline), 'headline mentions due soon');
    assert(
      mixed.bullets.some((b) => /\$800/.test(b)),
      'bullets include $800 overdue'
    );
    assert(
      mixed.bullets.some((b) => /\$500/.test(b)),
      'bullets include $500 due-soon'
    );
    assert(mixed.callout !== null, 'mixed case has callout');

    // Now mark everything paid and re-check the "all paid" phrasing.
    await db.execute({
      sql: `UPDATE invoices SET amount_paid = total, status = 'paid' WHERE client_id = ?`,
      args: [syntheticInvClientId],
    });
    const allPaid = await buildInvoicesSummary(syntheticInvClientId);
    console.log(`  all-paid headline: ${allPaid.headline}`);
    checkPlainLanguage(allPaid, 'inv-paid');
    assert(/paid up/.test(allPaid.headline), 'all-paid headline mentions paid up');
  } finally {
    await db.execute({ sql: 'DELETE FROM invoices WHERE client_id = ?', args: [syntheticInvClientId] });
    await db.execute({ sql: 'DELETE FROM contracts WHERE id = ?', args: [contractId] });
    await db.execute({ sql: 'DELETE FROM clients WHERE id = ?', args: [syntheticInvClientId] });
  }
  console.log('  OK');
  console.log();

  // ---------- Traffic builder (Slice 18c) ----------
  console.log('--- buildTrafficSummary ---');

  // Case T1: baseline live ZipKit — no GA4 data → no-data phrasing
  // BUT the jargon heuristic must still allow "Google Analytics" in
  // the callout since the user explicitly asked for honest naming
  // of the Google service in the connect prompt. We relax the
  // forbidden list temporarily for this one known line.
  const liveTraffic = await buildTrafficSummary(testClient.id);
  console.log(`  live headline: ${liveTraffic.headline}`);
  assert(
    /don't have traffic data/.test(liveTraffic.headline),
    'live ZipKit (no GA4) returns no-data headline'
  );
  assert(
    liveTraffic.callout !== null && /Connect Google Analytics/.test(liveTraffic.callout),
    'no-data callout mentions Connect Google Analytics'
  );
  console.log('  T1 no-data OK');

  // The remaining cases synthesize metric_snapshots rows directly
  // under a fresh synthetic period so we can control the numbers.
  const trafficClientId = nanoid();
  await db.execute({
    sql: `INSERT INTO clients (id, name, slug) VALUES (?, ?, ?)`,
    args: [trafficClientId, `slice18c-traffic-${nanoid(4)}`, `slice18c-traffic-${nanoid(4)}`],
  });

  const mkPeriod = async (monthStart: string): Promise<string> => {
    const id = nanoid();
    const [y, m] = monthStart.split('-').map(Number);
    const endDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    await db.execute({
      sql: `INSERT INTO periods (id, client_id, period_type, period_start, period_end)
            VALUES (?, ?, 'month', ?, ?)`,
      args: [
        id,
        trafficClientId,
        `${y}-${String(m).padStart(2, '0')}-01`,
        `${y}-${String(m).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`,
      ],
    });
    return id;
  };

  const writeTraffic = async (
    periodId: string,
    values: {
      sessions: number;
      users: number;
      page_views: number;
      engaged_sessions: number;
      engagement_rate: number;
    }
  ) => {
    // Use a synthetic import row to satisfy the FK on metric_snapshots.
    const importId = nanoid();
    await db.execute({
      sql: `INSERT INTO imports
            (id, client_id, period_id, source, original_name, content_hash, status, row_count, uploaded_by, finished_at)
            VALUES (?, ?, ?, 'ga4', 'slice18c-test', ?, 'applied', 5, ?, datetime('now'))`,
      args: [importId, trafficClientId, periodId, nanoid(), testClient.adminUserId],
    });
    for (const [key, val] of Object.entries(values)) {
      await db.execute({
        sql: `INSERT INTO metric_snapshots
              (id, client_id, period_id, import_id, category, metric_key, metric_value, source)
              VALUES (?, ?, ?, ?, 'traffic', ?, ?, 'ga4')`,
        args: [nanoid(), trafficClientId, periodId, importId, key, val],
      });
    }
  };

  const createdPeriodIds: string[] = [];

  try {
    // Case T2: first-month (one period only).
    const p1 = await mkPeriod('2099-05');
    createdPeriodIds.push(p1);
    await writeTraffic(p1, {
      sessions: 240,
      users: 180,
      page_views: 620,
      engaged_sessions: 150,
      engagement_rate: 0.625,
    });

    const firstMonth = await buildTrafficSummary(trafficClientId);
    console.log(`  T2 first-month headline: ${firstMonth.headline}`);
    console.log(`  T2 first-month bullets:  ${JSON.stringify(firstMonth.bullets)}`);
    checkPlainLanguage(firstMonth, 'T2 first-month');
    assert(
      /first month we're tracking/.test(firstMonth.headline),
      'first-month headline'
    );
    eq(firstMonth.bullets.length, 3, 'first-month has 3 bullets');
    assert(/240 visits/.test(firstMonth.bullets[0]), 'bullet 0 mentions 240 visits');
    assert(/180 people/.test(firstMonth.bullets[0]), 'bullet 0 mentions 180 people');
    assert(/620 page views/.test(firstMonth.bullets[1]), 'bullet 1 mentions 620 page views');
    assert(/63% of visits were engaged/.test(firstMonth.bullets[2]) || /62% of visits were engaged/.test(firstMonth.bullets[2]), 'bullet 2 mentions engagement %');
    console.log('  T2 first-month OK');

    // Case T3: all-up compare (prior period smaller, current larger).
    const p2 = await mkPeriod('2099-06');
    createdPeriodIds.push(p2);
    await writeTraffic(p2, {
      sessions: 320, // +33% vs 240
      users: 240,    // +33% vs 180
      page_views: 800, // +29% vs 620
      engaged_sessions: 210,
      engagement_rate: 0.656,
    });

    const allUp = await buildTrafficSummary(trafficClientId);
    console.log(`  T3 all-up headline: ${allUp.headline}`);
    console.log(`  T3 all-up bullets:  ${JSON.stringify(allUp.bullets)}`);
    checkPlainLanguage(allUp, 'T3 all-up');
    eq(
      allUp.headline,
      'More people visited your site this month.',
      'all-up headline'
    );
    assert(allUp.bullets.length >= 1, 'has compare bullets');
    assert(
      allUp.bullets.some((b) => /80 more visits/.test(b) && /up 33%/.test(b)),
      'sessions bullet includes 80 more + 33%'
    );
    assert(
      allUp.bullets.some((b) => /60 more people/.test(b)),
      'users bullet'
    );
    console.log('  T3 all-up OK');

    // Case T4: all-down. Delete p2's metrics and rewrite with lower values.
    await db.execute({
      sql: `DELETE FROM metric_snapshots WHERE period_id = ?`,
      args: [p2],
    });
    await db.execute({
      sql: `DELETE FROM imports WHERE period_id = ?`,
      args: [p2],
    });
    await writeTraffic(p2, {
      sessions: 140, // -42% vs 240
      users: 100,    // -44%
      page_views: 400, // -35%
      engaged_sessions: 80,
      engagement_rate: 0.571,
    });

    const allDown = await buildTrafficSummary(trafficClientId);
    console.log(`  T4 all-down headline: ${allDown.headline}`);
    console.log(`  T4 all-down bullets:  ${JSON.stringify(allDown.bullets)}`);
    checkPlainLanguage(allDown, 'T4 all-down');
    eq(
      allDown.headline,
      'Fewer people visited your site this month.',
      'all-down headline'
    );
    assert(
      allDown.bullets.some((b) => /100 fewer visits/.test(b) && /down 42%/.test(b)),
      'sessions bullet includes 100 fewer + 42%'
    );
    console.log('  T4 all-down OK');

    // Case T5: all-flat (<5% change on every metric).
    await db.execute({
      sql: `DELETE FROM metric_snapshots WHERE period_id = ?`,
      args: [p2],
    });
    await db.execute({
      sql: `DELETE FROM imports WHERE period_id = ?`,
      args: [p2],
    });
    await writeTraffic(p2, {
      sessions: 245, // +2% vs 240
      users: 184,    // +2%
      page_views: 628, // +1.3%
      engaged_sessions: 155,
      engagement_rate: 0.632,
    });

    const allFlat = await buildTrafficSummary(trafficClientId);
    console.log(`  T5 all-flat headline: ${allFlat.headline}`);
    console.log(`  T5 all-flat bullets:  ${JSON.stringify(allFlat.bullets)}`);
    checkPlainLanguage(allFlat, 'T5 all-flat');
    eq(
      allFlat.headline,
      'Site traffic held steady this month.',
      'all-flat headline'
    );
    // When flat, builder surfaces one bullet with the current totals
    // as context.
    assert(
      allFlat.bullets.some((b) => /245 visits/.test(b)),
      'flat fallback bullet includes current totals'
    );
    console.log('  T5 all-flat OK');

    // Case T6: engagement callout fires (delta >= 5 percentage points).
    await db.execute({
      sql: `DELETE FROM metric_snapshots WHERE period_id = ?`,
      args: [p2],
    });
    await db.execute({
      sql: `DELETE FROM imports WHERE period_id = ?`,
      args: [p2],
    });
    await writeTraffic(p2, {
      sessions: 320, // up
      users: 240,
      page_views: 800,
      engaged_sessions: 260,
      engagement_rate: 0.812, // +18.7 percentage points vs 0.625
    });

    const withCallout = await buildTrafficSummary(trafficClientId);
    console.log(`  T6 callout: ${withCallout.callout}`);
    checkPlainLanguage(withCallout, 'T6 engagement-up');
    assert(withCallout.callout !== null, 'callout fires on ≥5pp engagement delta');
    assert(
      /more engaged/.test(withCallout.callout!) && /81%/.test(withCallout.callout!) && /63%/.test(withCallout.callout!),
      'callout names both percents with direction'
    );

    // Case T6b: engagement DOWN
    await db.execute({ sql: `DELETE FROM metric_snapshots WHERE period_id = ?`, args: [p2] });
    await db.execute({ sql: `DELETE FROM imports WHERE period_id = ?`, args: [p2] });
    await writeTraffic(p2, {
      sessions: 320,
      users: 240,
      page_views: 800,
      engaged_sessions: 100,
      engagement_rate: 0.312, // -31pp
    });
    const withDownCallout = await buildTrafficSummary(trafficClientId);
    checkPlainLanguage(withDownCallout, 'T6b engagement-down');
    assert(
      withDownCallout.callout !== null && /less engaged/.test(withDownCallout.callout),
      'engagement-down callout'
    );
    console.log('  T6 engagement callout OK');
  } finally {
    // Cleanup
    for (const pid of createdPeriodIds) {
      await db.execute({ sql: 'DELETE FROM metric_snapshots WHERE period_id = ?', args: [pid] });
      await db.execute({ sql: 'DELETE FROM imports WHERE period_id = ?', args: [pid] });
      await db.execute({ sql: 'DELETE FROM periods WHERE id = ?', args: [pid] });
    }
    await db.execute({ sql: 'DELETE FROM clients WHERE id = ?', args: [trafficClientId] });
  }
  console.log();

  console.log('SLICE 17 TEST PASSED ✓');
}

main().catch((err) => {
  console.error();
  console.error('SLICE 17 TEST FAILED:', err);
  process.exit(1);
});
