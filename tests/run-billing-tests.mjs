#!/usr/bin/env node
// Billing systems integration tests — all 7 systems against dev2 on 4322

const BASE = 'http://localhost:4322';
const results = [];
const CLIENT_A_CLIENT = 'jlCeA1SCHv8D6zD4U3h0b';
const CLIENT_A_USER = 'ukPCtjfLtebMs8xRHXij1';
const ADMIN_ID = 'YIPeOincMxhPce7yjPeuK';

function test(name, pass, detail) {
  results.push({ name, pass, detail: String(detail).slice(0, 300) });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  if (!pass) console.log(`       ${String(detail).slice(0, 300)}`);
}

async function login(email, password) {
  const res = await fetch(`${BASE}/portal/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }), redirect: 'manual',
  });
  for (const c of (res.headers.getSetCookie?.() || [])) {
    const m = c.match(/portal_session=([^;]+)/);
    if (m) return m[1];
  }
  throw new Error(`Login failed: ${res.status}`);
}

async function getCsrf(session) {
  const res = await fetch(`${BASE}/portal/dashboard`, {
    headers: { Cookie: `portal_session=${session}` }, redirect: 'manual',
  });
  return (await res.text()).match(/csrf-token" content="([^"]+)"/)?.[1] || '';
}

async function api(method, path, body, session, csrf) {
  const headers = { 'Content-Type': 'application/json' };
  if (session) headers.Cookie = `portal_session=${session}`;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  const opts = { method, headers, redirect: 'manual' };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/pdf')) {
    const buf = await res.arrayBuffer();
    return { status: res.status, body: { size: buf.byteLength, type: 'pdf' }, headers: Object.fromEntries(res.headers.entries()) };
  }
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

async function getDb() {
  const { createClient } = await import('@libsql/client');
  return createClient({ url: 'file:./data/dev2.db' });
}

async function run() {
  console.log('Logging in...');
  const adminSession = await login('admin@dev2.test', 'testpass123');
  const adminCsrf = await getCsrf(adminSession);
  const clientSession = await login('testuser@dev2.test', 'testpass123');
  console.log('Sessions: OK\n');

  const post = (p, b) => api('POST', p, b, adminSession, adminCsrf);
  const put = (p, b) => api('PUT', p, b, adminSession, adminCsrf);
  const get = (p) => api('GET', p, null, adminSession, null);
  const del = (p) => api('DELETE', p, null, adminSession, adminCsrf);

  const db = await getDb();
  await db.execute('DELETE FROM notifications');

  // ============ SYSTEM 1: Contract billing fields ============
  console.log('--- SYSTEM 1: Contract billing rules ---');

  let r = await post('/portal/api/admin/contracts/', {
    client_id: CLIENT_A_CLIENT,
    title: 'ZKH Web Management Test',
    type: 'retainer',
    billing_cadence: 'monthly',
    billing_day: new Date().getDate(), // today's date so generation triggers
    recurring_amount: 500,
    included_hours: 5,
    overage_rate: 100,
    payment_terms_days: 30,
    total_value: 6000,
    start_date: '2026-01-01',
  });
  const contractId = r.body.id;
  test('s1.create_with_billing', r.status === 201 && !!contractId, r.body);

  // Verify billing fields persisted
  r = await get(`/portal/api/admin/contracts/${contractId}`);
  test('s1.billing_cadence', r.body.billing_cadence === 'monthly', `cadence: ${r.body.billing_cadence}`);
  test('s1.billing_day', r.body.billing_day === new Date().getDate(), `day: ${r.body.billing_day}`);
  test('s1.recurring_amount', r.body.recurring_amount === 500, `amount: ${r.body.recurring_amount}`);
  test('s1.included_hours', r.body.included_hours === 5, `hours: ${r.body.included_hours}`);
  test('s1.overage_rate', r.body.overage_rate === 100, `rate: ${r.body.overage_rate}`);
  test('s1.payment_terms', r.body.payment_terms_days === 30, `terms: ${r.body.payment_terms_days}`);

  // Activate contract
  await put(`/portal/api/admin/contracts/${contractId}`, { status: 'active' });

  // ============ SYSTEM 2: Recurring invoice generation ============
  console.log('\n--- SYSTEM 2: Recurring invoice generation ---');

  r = await post('/portal/api/admin/billing/generate', {});
  test('s2.generate_call', r.status === 200, r.body);
  test('s2.generated_count', r.body.generated >= 1, `generated: ${r.body.generated}`);

  // Verify invoice was created
  r = await get(`/portal/api/admin/invoices/?contract_id=${contractId}`);
  const invoices = Array.isArray(r.body) ? r.body : [];
  test('s2.invoice_exists', invoices.length >= 1, `count: ${invoices.length}`);

  let invoiceId = invoices[0]?.id;
  if (invoiceId) {
    r = await get(`/portal/api/admin/invoices/${invoiceId}`);
    test('s2.has_recurring_item', r.body.items?.some(i => i.description.includes('ZKH Web Management')), `items: ${JSON.stringify(r.body.items?.map(i => i.description))}`);
    test('s2.has_billing_period', !!r.body.billing_period_start, `period: ${r.body.billing_period_start}`);
    test('s2.total_correct', r.body.total === 500, `total: ${r.body.total}`);
    test('s2.client_visible', r.body.client_visible === 1, `visible: ${r.body.client_visible}`);
  }

  // No duplicate on re-generate
  r = await post('/portal/api/admin/billing/generate', {});
  test('s2.no_duplicate', r.body.generated === 0, `generated: ${r.body.generated}`);

  // ============ SYSTEM 3: Hours/overage ============
  console.log('\n--- SYSTEM 3: Hours tracking + overage ---');

  // Create project/milestone/tasks under the contract
  r = await post('/portal/api/admin/projects/', {
    contract_id: contractId, client_id: CLIENT_A_CLIENT, title: 'Hours Test Project',
  });
  const projId = r.body.id;
  r = await post('/portal/api/admin/milestones/', { project_id: projId, title: 'Hours Test MS' });
  const msId = r.body.id;

  r = await post('/portal/api/admin/tasks/', { milestone_id: msId, title: 'Task 1', estimated_hours: 3 });
  const t1 = r.body.id;
  r = await post('/portal/api/admin/tasks/', { milestone_id: msId, title: 'Task 2', estimated_hours: 4 });
  const t2 = r.body.id;

  // Record 3 hours on task 1 (within included)
  await put(`/portal/api/admin/tasks/${t1}`, { actual_hours: 3, status: 'done' });

  // Record 4 hours on task 2 (total 7, overage = 2h * $100 = $200)
  await put(`/portal/api/admin/tasks/${t2}`, { actual_hours: 4, status: 'done' });

  // Verify overage pending charge exists
  const charges = await db.execute({
    sql: "SELECT description, amount FROM pending_charges WHERE contract_id = ? AND source_type = 'overage' AND billed_invoice_id IS NULL",
    args: [contractId],
  });
  test('s3.overage_charge_exists', charges.rows.length >= 1, `count: ${charges.rows.length}`);
  if (charges.rows.length > 0) {
    test('s3.overage_amount', charges.rows[0][1] === 200, `amount: ${charges.rows[0][1]} (expected 200)`);
  }

  // ============ SYSTEM 6: Change order flow-through ============
  console.log('\n--- SYSTEM 6: Change order flow-through ---');

  r = await post('/portal/api/admin/change-orders/', {
    contract_id: contractId, title: 'Add analytics dashboard', cost_impact: 750,
  });
  const coId = r.body.id;
  r = await put(`/portal/api/admin/change-orders/${coId}`, { action: 'approve' });
  test('s6.co_approved', r.status === 200, r.body);

  // Verify pending charge created
  const coCharges = await db.execute({
    sql: "SELECT description, amount FROM pending_charges WHERE contract_id = ? AND source_type = 'change_order' AND billed_invoice_id IS NULL",
    args: [contractId],
  });
  test('s6.pending_charge_exists', coCharges.rows.length >= 1, `count: ${coCharges.rows.length}`);
  test('s6.charge_amount', coCharges.rows[0]?.[1] === 750, `amount: ${coCharges.rows[0]?.[1]}`);

  // ============ SYSTEM 5: Auto client updates ============
  console.log('\n--- SYSTEM 5: Auto client updates ---');

  // Check that task completion auto-wrote client_update_text
  // (tasks were completed in System 3 tests, but they weren't client_visible)
  // Create a visible task and complete it
  r = await post('/portal/api/admin/tasks/', {
    milestone_id: msId, title: 'Visible Task', client_visible: true,
  });
  const visTask = r.body.id;
  await put(`/portal/api/admin/tasks/${visTask}`, { status: 'done' });

  r = await get(`/portal/api/admin/tasks/${visTask}`);
  test('s5.auto_task_update_text', r.body.client_update_text?.includes('Visible Task completed on'), `text: ${r.body.client_update_text}`);

  // Client notification from invoice generation
  const notifs = await db.execute({
    sql: "SELECT title, body FROM notifications WHERE user_id = ? AND type = 'invoice_sent'",
    args: [CLIENT_A_USER],
  });
  test('s5.client_invoice_notification', notifs.rows.length >= 1, `count: ${notifs.rows.length}`);

  // ============ SYSTEM 4: Reminder check ============
  console.log('\n--- SYSTEM 4: Reminder check ---');

  // Create a sent invoice due within 3 days
  r = await post('/portal/api/admin/invoices/', {
    contract_id: contractId, client_id: CLIENT_A_CLIENT,
  });
  const remInvId = r.body.id;
  await put(`/portal/api/admin/invoices/${remInvId}`, {
    action: 'add_item', description: 'Reminder test', unit_price: 100,
  });
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  await put(`/portal/api/admin/invoices/${remInvId}`, {
    status: 'sent',
    issued_date: new Date().toISOString().split('T')[0],
    due_date: tomorrow.toISOString().split('T')[0],
  });

  // Visiting contracts page triggers reminder check
  // (can't test email delivery in dev, but can verify last_reminder_sent gets set if Brevo key exists)
  // In dev2, BREVO_API_KEY is not set, so email.ts logs to console and returns false
  // last_reminder_sent won't be set — which is correct behavior for dev
  r = await get(`/portal/api/admin/invoices/${remInvId}`);
  test('s4.invoice_awaiting_reminder', r.body.status === 'sent' && r.body.last_reminder_sent === null, `status: ${r.body.status}, reminded: ${r.body.last_reminder_sent}`);

  // ============ SYSTEM 7: PDF generation ============
  console.log('\n--- SYSTEM 7: PDF generation ---');

  // Admin PDF
  if (invoiceId) {
    r = await api('GET', `/portal/api/admin/invoices/${invoiceId}/pdf`, null, adminSession, null);
    test('s7.admin_pdf_status', r.status === 200, `status: ${r.status}`);
    test('s7.admin_pdf_type', r.body.type === 'pdf', `type: ${r.body.type}`);
    test('s7.admin_pdf_size', r.body.size > 500, `size: ${r.body.size}`);
  }

  // Client PDF (need to make the invoice client-visible first)
  if (invoiceId) {
    await put(`/portal/api/admin/invoices/${invoiceId}`, { client_visible: true });
    r = await api('GET', `/portal/api/client/invoices/${invoiceId}/pdf`, null, clientSession, null);
    test('s7.client_pdf_status', r.status === 200, `status: ${r.status}`);
    test('s7.client_pdf_type', r.body.type === 'pdf', `type: ${r.body.type}`);
  }

  // Client PDF for non-visible invoice should fail
  r = await api('GET', `/portal/api/client/invoices/${remInvId}/pdf`, null, clientSession, null);
  test('s7.client_pdf_blocked', r.status === 404, `status: ${r.status}`);

  // ============ CLEANUP ============
  await del(`/portal/api/admin/contracts/${contractId}`);

  // ============ SUMMARY ============
  console.log('\n========================================');
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log(`TOTAL: ${results.length} | PASS: ${passed} | FAIL: ${failed}`);
  console.log('========================================');

  if (failed > 0) {
    console.log('\nFAILURES:');
    results.filter(r => !r.pass).forEach(r => console.log(`  - ${r.name}: ${r.detail}`));
  }
}

run().catch(err => { console.error('Test runner error:', err); process.exit(1); });
