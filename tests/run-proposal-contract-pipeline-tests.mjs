#!/usr/bin/env node
// Proposal -> client selection -> contract preview -> acceptance -> agreement audit.
// Real HTTP against local dev2 on 4322.

import { createClient } from '@libsql/client';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';

const BASE = 'http://localhost:4322';
const PASSWORD = 'testpass123';

const results = [];

function test(name, pass, detail = '') {
  results.push({ name, pass, detail: typeof detail === 'object' ? JSON.stringify(detail) : String(detail) });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  if (!pass) console.log(`       ${typeof detail === 'object' ? JSON.stringify(detail) : detail}`);
}

function route(path) {
  return path.replace(/\/(\?|$)/, '$1');
}

function moneyEqual(a, b) {
  return Math.round(Number(a) * 100) === Math.round(Number(b) * 100);
}

function jsonHeaders(session, csrf) {
  const headers = { 'Content-Type': 'application/json' };
  if (session) headers.Cookie = `portal_session=${session}`;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  return headers;
}

async function login(email, password) {
  const res = await fetch(`${BASE}/portal/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    redirect: 'manual',
  });
  for (const c of (res.headers.getSetCookie?.() || [])) {
    const m = c.match(/portal_session=([^;]+)/);
    if (m) return m[1];
  }
  throw new Error(`Login failed for ${email}: status ${res.status}`);
}

async function getCsrf(session) {
  const res = await fetch(`${BASE}/portal/dashboard`, {
    headers: { Cookie: `portal_session=${session}` },
    redirect: 'manual',
  });
  const html = await res.text();
  const m = html.match(/csrf-token" content="([^"]+)"/);
  return m ? m[1] : '';
}

async function api(method, path, body, session, csrf) {
  const res = await fetch(`${BASE}${route(path)}`, {
    method,
    headers: jsonHeaders(session, csrf),
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed, text, headers: res.headers };
}

async function getPage(path, session) {
  const res = await fetch(`${BASE}${route(path)}`, {
    headers: session ? { Cookie: `portal_session=${session}` } : {},
    redirect: 'manual',
  });
  return { status: res.status, text: await res.text() };
}

async function clearLoginRateLimits(db) {
  await db.execute("DELETE FROM portal_rate_limits WHERE key LIKE 'login:%'").catch(err => {
    if (!/no such table/i.test(String(err?.message || ''))) throw err;
  });
}

async function cleanup(db, fixture) {
  if (!fixture?.clientId) return;
  const agreementRows = await db.execute({
    sql: 'SELECT id FROM client_agreements WHERE proposal_id = ?',
    args: [fixture.proposalId || ''],
  }).catch(() => ({ rows: [] }));
  for (const row of agreementRows.rows || []) {
    const agreementId = row[0];
    await db.execute({ sql: 'DELETE FROM agreement_signatures WHERE agreement_id = ?', args: [agreementId] }).catch(() => {});
    await db.execute({ sql: 'DELETE FROM agreement_signers WHERE agreement_id = ?', args: [agreementId] }).catch(() => {});
  }
  await db.execute({ sql: 'DELETE FROM client_agreements WHERE proposal_id = ?', args: [fixture.proposalId || ''] }).catch(() => {});
  await db.execute({ sql: 'DELETE FROM proposal_drafts WHERE client_id = ? AND slug = ?', args: [fixture.clientId, fixture.slug || ''] }).catch(() => {});
  await db.execute({ sql: 'DELETE FROM proposals WHERE id = ? OR slug = ?', args: [fixture.proposalId || '', fixture.slug || ''] }).catch(() => {});
  await db.execute({ sql: 'DELETE FROM activity_log WHERE client_id = ?', args: [fixture.clientId] }).catch(() => {});
  await db.execute({ sql: 'DELETE FROM notifications WHERE user_id = ?', args: [fixture.userId || ''] }).catch(() => {});
  await db.execute({ sql: 'DELETE FROM sessions WHERE user_id = ?', args: [fixture.userId || ''] }).catch(() => {});
  await db.execute({ sql: 'DELETE FROM client_sites WHERE client_id = ?', args: [fixture.clientId] }).catch(() => {});
  await db.execute({ sql: 'DELETE FROM users WHERE id = ? OR email = ?', args: [fixture.userId || '', fixture.email || ''] }).catch(() => {});
  await db.execute({ sql: 'DELETE FROM clients WHERE id = ?', args: [fixture.clientId] }).catch(() => {});
}

async function createFixture(db) {
  const stamp = Date.now().toString(36);
  const clientId = `pct_${stamp}_${nanoid(6)}`;
  const userId = `pctu_${stamp}_${nanoid(6)}`;
  const slug = `portal-pipeline-${stamp}`;
  const email = `portal-pipeline-${stamp}@dev2.test`;
  const hash = await bcrypt.hash(PASSWORD, 12);

  await db.execute({
    sql: 'INSERT INTO clients (id, name, slug, active, domain) VALUES (?, ?, ?, 1, ?)',
    args: [clientId, 'Portal Pipeline Test Co', slug, 'pipeline.example.com'],
  });
  await db.execute({
    sql: `INSERT INTO users (id, email, name, password_hash, role, client_id)
          VALUES (?, ?, ?, ?, 'client', ?)`,
    args: [userId, email, 'Portal Pipeline Client', hash, clientId],
  });
  await db.execute({
    sql: `INSERT INTO client_sites
            (id, client_id, domain, is_primary, is_managed, label, sort_order, page_count)
          VALUES (?, ?, ?, 1, 1, ?, 0, 20)`,
    args: [`site_${stamp}_${nanoid(6)}`, clientId, 'pipeline.example.com', 'Pipeline primary site'],
  });

  return { stamp, clientId, userId, slug, email, proposalId: '' };
}

async function run() {
  const db = createClient({ url: 'file:./data/dev2.db' });
  let fixture = null;

  try {
    await clearLoginRateLimits(db);
    fixture = await createFixture(db);

    const adminSession = await login('admin@dev2.test', PASSWORD);
    const clientSession = await login(fixture.email, PASSWORD);
    const adminCsrf = await getCsrf(adminSession);
    const clientCsrf = await getCsrf(clientSession);
    test('sessions.admin_and_client', !!adminSession && !!clientSession && !!adminCsrf && !!clientCsrf);

    const createRes = await api('POST', '/portal/api/admin/proposals/create', {
      client_id: fixture.clientId,
      status: 'published',
      compose: {
        products: ['web-management', 'marketing-consulting', 'build'],
        product_vars: {
          'web-management': {
            page_count: 20,
            site_count: 1,
          },
          'marketing-consulting': {
            revenue_band: 'over-10m',
          },
          build: {
            build_total_pages: 14,
            build_description: 'A net-new product-line site with an optional split pre-sell micro-site.',
            build_options: [
              {
                id: 'opt1',
                name: 'Single site with focused pre-sell section',
                pitch: 'One new site carries the brand and the pre-sell section.',
                schedule_a_note: 'Single site build covering the brand and pre-sell section.',
                wm_sites_added: [
                  { domain: 'pipeline-build.example.com', label: 'Pipeline build site', page_count_estimate: 14 },
                ],
                wm_site_modifications: [],
                rollout_phases: [
                  { phase_num: 'Phase 1', h3: 'Build the primary site', html: 'The focused pre-sell section launches inside the primary site.' },
                ],
              },
              {
                id: 'opt2',
                name: 'Split into two sites for focus',
                pitch: 'The brand site and pre-sell micro-site launch as separate builds.',
                schedule_a_note: 'Two site builds: primary product-line site plus standalone pre-sell micro-site.',
                wm_sites_added: [
                  { domain: 'pipeline-build.example.com', label: 'Pipeline build site', page_count_estimate: 14 },
                  { domain: 'pipeline-presell.example.com', label: 'Pipeline pre-sell micro-site', page_count_estimate: 14 },
                ],
                wm_site_modifications: [],
                rollout_phases: [
                  { phase_num: 'Phase 1', h3: 'Launch the micro-site', html: 'The focused pre-sell site launches first.' },
                  { phase_num: 'Phase 2', h3: 'Launch the product-line site', html: 'The primary product-line site follows.' },
                ],
              },
            ],
          },
        },
        narrative_variables: {
          industry: 'family-of-companies',
          urgency: 'maintenance',
          focus: ['brand', 'search', 'pre-sell'],
        },
        signers: [
          { name: 'Portal Pipeline Client', email: fixture.email },
        ],
        overrides: {
          title: 'Engagement Proposal for Portal Pipeline Test Co',
          slug: fixture.slug,
          prepared_for: 'Portal Pipeline Client',
        },
      },
    }, adminSession, adminCsrf);
    test('admin.compose_published_proposal', createRes.status === 201 && createRes.body?.slug === fixture.slug, createRes.body);
    fixture.proposalId = createRes.body?.id || '';

    const proposalPage = await getPage(`/portal/proposals/${fixture.slug}`, clientSession);
    test('client.proposal_page_loads', proposalPage.status === 200 && proposalPage.text.includes('Pick a build approach'), `status=${proposalPage.status}`);

    const selections = {
      wm_tier: 'better',
      mc_yes_no: 'yes',
      mc_tier: 'better',
      build_options: 'opt2',
    };
    const saveRes = await api('POST', `/portal/api/proposals/${fixture.slug}/accept`, { selections }, clientSession, clientCsrf);
    test('client.save_selections', saveRes.status === 200 && saveRes.body?.status === 'saved', saveRes.body);
    test('pricing.one_time_after_split_option', moneyEqual(saveRes.body?.pricing?.oneTime, 16925), saveRes.body?.pricing);
    test('pricing.monthly_after_split_option', moneyEqual(saveRes.body?.pricing?.monthly, 3789.20), saveRes.body?.pricing);

    const preview = await getPage(`/portal/contracts/preview/${fixture.slug}`, clientSession);
    test('client.contract_preview_loads', preview.status === 200 && preview.text.includes('Schedule A'), `status=${preview.status}`);
    test('preview.preserves_fractional_wm_total', preview.text.includes('$1,292.20'), 'expected $1,292.20 in preview');

    const acceptRes = await api('POST', `/portal/api/proposals/${fixture.slug}/accept`, {
      selections,
      signature: 'Portal Pipeline Client',
    }, clientSession, clientCsrf);
    test('client.accept_finalizes', acceptRes.status === 200 && acceptRes.body?.status === 'finalized', acceptRes.body);

    const agreementRows = await db.execute({
      sql: `SELECT ca.id, ca.status, ca.schedule_a, p.status, p.finalized_at
            FROM client_agreements ca
            JOIN proposals p ON p.id = ca.proposal_id
            WHERE ca.proposal_id = ?
            ORDER BY ca.created_at DESC
            LIMIT 1`,
      args: [fixture.proposalId],
    });
    const row = agreementRows.rows[0];
    test('agreement.created_from_acceptance', !!row, 'agreement row missing');
    if (row) {
      const scheduleA = JSON.parse(row[2]);
      test('agreement.status_draft', row[1] === 'draft', `status=${row[1]}`);
      test('proposal.marked_accepted', row[3] === 'accepted' && !!row[4], `status=${row[3]} finalized_at=${row[4]}`);
      test('schedule.web_management_site_count', scheduleA.web_management?.site_count === 3, scheduleA.web_management);
      test('schedule.web_management_monthly_matches_proposal', moneyEqual(scheduleA.web_management?.monthly_total, 1292.20), scheduleA.web_management);
      test('schedule.web_management_onboarding_excludes_build_sites', moneyEqual(scheduleA.web_management?.onboarding_total, 800), scheduleA.web_management);
      test('schedule.marketing_consulting_matches_proposal', moneyEqual(scheduleA.marketing_consulting?.monthly_retainer, 2497) && moneyEqual(scheduleA.marketing_consulting?.initial_audit_fee, 6000), scheduleA.marketing_consulting);
      const buildRows = (scheduleA.web_management?.sites || []).filter(site =>
        String(site.domain || '').includes('pipeline-build.example.com')
        || String(site.domain || '').includes('pipeline-presell.example.com')
      );
      test('schedule.added_build_sites_have_zero_wm_onboarding', buildRows.length === 2 && buildRows.every(site => moneyEqual(site.onboarding_contribution, 0)), buildRows);
      test('schedule.build_sow_ref_has_selected_option', String(scheduleA.build_sow_ref || '').includes('Split into two sites for focus'), scheduleA.build_sow_ref);
    }

    console.log('\n========================================');
    const passed = results.filter(r => r.pass).length;
    const failed = results.filter(r => !r.pass).length;
    console.log(`TOTAL: ${results.length} | PASS: ${passed} | FAIL: ${failed}`);
    console.log('========================================');
    if (failed > 0) process.exitCode = 1;
  } finally {
    await cleanup(db, fixture);
  }
}

run().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
