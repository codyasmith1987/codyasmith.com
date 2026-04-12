#!/usr/bin/env node
// Trigger integration tests — verify downstream effects via real HTTP against dev2 on 4322

const BASE = 'http://localhost:4322';
const results = [];
const ADMIN_ID = 'YIPeOincMxhPce7yjPeuK';
const CLIENT_A_ID = 'ukPCtjfLtebMs8xRHXij1';
const CLIENT_A_CLIENT = 'jlCeA1SCHv8D6zD4U3h0b';

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
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

// Direct DB access for notification verification
async function getDb() {
  const { createClient } = await import('@libsql/client');
  return createClient({ url: 'file:./data/dev2.db' });
}

async function getNotificationsForUser(userId) {
  const db = await getDb();
  const r = await db.execute({ sql: 'SELECT id, type, title, body, entity_type, entity_id FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 10', args: [userId] });
  return r.rows.map(row => ({ id: row[0], type: row[1], title: row[2], body: row[3], entity_type: row[4], entity_id: row[5] }));
}

async function clearNotifications() {
  const db = await getDb();
  await db.execute('DELETE FROM notifications');
}

async function run() {
  console.log('Logging in...');
  const adminSession = await login('admin@dev2.test', 'testpass123');
  const adminCsrf = await getCsrf(adminSession);
  const clientASession = await login('testuser@dev2.test', 'testpass123');
  const clientACsrf = await getCsrf(clientASession);
  console.log('Sessions: OK\n');

  const adminPost = (p, b) => api('POST', p, b, adminSession, adminCsrf);
  const adminPut = (p, b) => api('PUT', p, b, adminSession, adminCsrf);
  const adminGet = (p) => api('GET', p, null, adminSession, null);
  const adminDel = (p) => api('DELETE', p, null, adminSession, adminCsrf);
  const clientPost = (p, b) => api('POST', p, b, clientASession, clientACsrf);

  // Clear notifications to start clean
  await clearNotifications();

  // ============ SETUP ============
  console.log('Setting up...');
  let r;

  r = await adminPost('/portal/api/admin/contracts/', {
    client_id: CLIENT_A_CLIENT, title: 'Trigger Test Contract', type: 'fixed', total_value: 5000,
  });
  const contractId = r.body.id;

  r = await adminPost('/portal/api/admin/projects/', {
    contract_id: contractId, client_id: CLIENT_A_CLIENT, title: 'Trigger Test Project', client_visible: true,
  });
  const projectId = r.body.id;

  r = await adminPost('/portal/api/admin/milestones/', {
    project_id: projectId, title: 'Trigger Test Milestone 1',
  });
  const ms1Id = r.body.id;

  r = await adminPost('/portal/api/admin/milestones/', {
    project_id: projectId, title: 'Trigger Test Milestone 2',
  });
  const ms2Id = r.body.id;

  r = await adminPost('/portal/api/admin/tasks/', { milestone_id: ms1Id, title: 'Task A' });
  const taskAId = r.body.id;
  r = await adminPost('/portal/api/admin/tasks/', { milestone_id: ms1Id, title: 'Task B' });
  const taskBId = r.body.id;

  r = await adminPost('/portal/api/admin/tasks/', { milestone_id: ms2Id, title: 'Task C' });
  const taskCId = r.body.id;

  console.log('Setup complete.\n');
  await clearNotifications(); // clear any setup noise

  // ============ TEST 1: Task → Milestone auto-complete ============
  console.log('--- TEST 1: Task → Milestone auto-complete ---');

  // Complete task A
  r = await adminPut(`/portal/api/admin/tasks/${taskAId}`, { status: 'done' });
  test('t1.task_a_done', r.status === 200, `status: ${r.status}`);

  // Milestone should NOT be complete yet (task B still open)
  r = await adminGet(`/portal/api/admin/milestones/${ms1Id}`);
  test('t1.milestone_not_yet_complete', r.body.status !== 'completed', `status: ${r.body.status}`);

  // Check notification for client (task completed)
  let notifs = await getNotificationsForUser(CLIENT_A_ID);
  test('t1.client_notified_task_a', notifs.some(n => n.type === 'task_completed' && n.body.includes('Task A')), `notifs: ${JSON.stringify(notifs.map(n => n.body))}`);

  // Complete task B → should auto-complete milestone
  await clearNotifications();
  r = await adminPut(`/portal/api/admin/tasks/${taskBId}`, { status: 'done' });
  test('t1.task_b_done', r.status === 200, `status: ${r.status}`);

  r = await adminGet(`/portal/api/admin/milestones/${ms1Id}`);
  test('t1.milestone_auto_completed', r.body.status === 'completed' && !!r.body.completed_at, `status: ${r.body.status}, completed_at: ${r.body.completed_at}`);

  // Check milestone completion notification
  notifs = await getNotificationsForUser(CLIENT_A_ID);
  test('t1.client_notified_milestone', notifs.some(n => n.type === 'milestone_completed' && n.body.includes('Trigger Test Milestone 1')), `notifs: ${JSON.stringify(notifs.map(n => n.body))}`);

  // ============ TEST 2: Milestone → Project auto-complete ============
  console.log('\n--- TEST 2: Milestone → Project auto-complete ---');

  await clearNotifications();

  // Complete task C → auto-completes milestone 2 → should auto-complete project
  r = await adminPut(`/portal/api/admin/tasks/${taskCId}`, { status: 'done' });
  test('t2.task_c_done', r.status === 200, `status: ${r.status}`);

  r = await adminGet(`/portal/api/admin/milestones/${ms2Id}`);
  test('t2.milestone2_auto_completed', r.body.status === 'completed', `status: ${r.body.status}`);

  r = await adminGet(`/portal/api/admin/projects/${projectId}`);
  test('t2.project_auto_completed', r.body.status === 'completed', `status: ${r.body.status}`);

  notifs = await getNotificationsForUser(CLIENT_A_ID);
  test('t2.client_notified_project', notifs.some(n => n.body.includes('Trigger Test Project') && n.body.includes('complete')), `notifs: ${JSON.stringify(notifs.map(n => n.body))}`);

  // ============ TEST 3: Approval responded → admin notified ============
  console.log('\n--- TEST 3: Approval responded → admin notified ---');

  await clearNotifications();

  r = await adminPost('/portal/api/admin/approvals/', {
    contract_id: contractId, title: 'Approve the logo',
  });
  const approvalId = r.body.id;

  // Client responds
  r = await clientPost('/portal/api/client/approvals', {
    id: approvalId, status: 'approved', response_note: 'Love it',
  });
  test('t3.client_responds', r.status === 200, `status: ${r.status}`);

  notifs = await getNotificationsForUser(ADMIN_ID);
  test('t3.admin_notified', notifs.some(n => n.type === 'approval_responded' && n.body.includes('Approve the logo')), `notifs: ${JSON.stringify(notifs.map(n => n.body))}`);

  // ============ TEST 4: Change order approved → contract value updated ============
  console.log('\n--- TEST 4: Change order approved → contract value updated ---');

  await clearNotifications();

  r = await adminPost('/portal/api/admin/change-orders/', {
    contract_id: contractId, title: 'Add analytics', cost_impact: 1500, time_impact_days: 3,
  });
  const coId = r.body.id;

  r = await adminPut(`/portal/api/admin/change-orders/${coId}`, { action: 'approve' });
  test('t4.co_approved', r.status === 200, `status: ${r.status}`);

  r = await adminGet(`/portal/api/admin/contracts/${contractId}`);
  test('t4.contract_value_updated', r.body.total_value === 6500, `total_value: ${r.body.total_value} (expected 6500)`);

  notifs = await getNotificationsForUser(CLIENT_A_ID);
  test('t4.client_notified', notifs.some(n => n.type === 'change_order_approved' && n.body.includes('Add analytics')), `notifs: ${JSON.stringify(notifs.map(n => n.body))}`);

  // ============ TEST 5: Invoice sent → client notified ============
  console.log('\n--- TEST 5: Invoice sent → client notified ---');

  await clearNotifications();

  r = await adminPost('/portal/api/admin/invoices/', {
    contract_id: contractId, client_id: CLIENT_A_CLIENT,
  });
  const invoiceId = r.body.id;
  await adminPut(`/portal/api/admin/invoices/${invoiceId}`, {
    action: 'add_item', description: 'Test item', unit_price: 1000,
  });

  r = await adminPut(`/portal/api/admin/invoices/${invoiceId}`, {
    status: 'sent', issued_date: '2026-04-11', due_date: '2026-04-30',
  });
  test('t5.invoice_sent', r.status === 200, `status: ${r.status}`);

  notifs = await getNotificationsForUser(CLIENT_A_ID);
  test('t5.client_notified', notifs.some(n => n.type === 'invoice_sent' && n.body.includes('INV-')), `notifs: ${JSON.stringify(notifs.map(n => n.body))}`);

  // ============ TEST 6: Payment → notifications ============
  console.log('\n--- TEST 6: Payment → notifications ---');

  await clearNotifications();

  // Partial payment
  r = await adminPost('/portal/api/admin/payments/record', {
    invoice_id: invoiceId, amount: 500, paid_at: '2026-04-12T12:00:00Z',
  });
  test('t6.partial_payment', r.status === 201, `status: ${r.status}`);

  notifs = await getNotificationsForUser(ADMIN_ID);
  test('t6.admin_notified_payment', notifs.some(n => n.type === 'payment_received' && n.body.includes('$500')), `notifs: ${JSON.stringify(notifs.map(n => n.body))}`);

  await clearNotifications();

  // Full payment (remaining 500)
  r = await adminPost('/portal/api/admin/payments/record', {
    invoice_id: invoiceId, amount: 500, paid_at: '2026-04-13T12:00:00Z',
  });
  test('t6.full_payment', r.status === 201, `status: ${r.status}`);

  notifs = await getNotificationsForUser(CLIENT_A_ID);
  test('t6.client_notified_paid', notifs.some(n => n.body.includes('paid in full')), `notifs: ${JSON.stringify(notifs.map(n => n.body))}`);

  // ============ TEST 7: No double-fire ============
  console.log('\n--- TEST 7: No double-fire ---');

  await clearNotifications();

  // Complete an already-done task
  r = await adminPut(`/portal/api/admin/tasks/${taskAId}`, { status: 'done' });
  test('t7.re_complete_task', r.status === 200, `status: ${r.status}`);

  // Should NOT create another task_completed notification (task was already done)
  notifs = await getNotificationsForUser(CLIENT_A_ID);
  const taskNotifs = notifs.filter(n => n.type === 'task_completed');
  test('t7.no_duplicate_notification', taskNotifs.length === 0, `task_completed count: ${taskNotifs.length}`);

  // ============ TEST 8: Cascade still works ============
  console.log('\n--- TEST 8: Cascade delete still works ---');

  r = await adminDel(`/portal/api/admin/contracts/${contractId}`);
  test('t8.cascade_delete', r.status === 200, `status: ${r.status}`);

  r = await adminGet(`/portal/api/admin/projects/${projectId}`);
  test('t8.project_gone', r.status === 404, `status: ${r.status}`);

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
