#!/usr/bin/env node
// Client UI end-to-end verification against dev2 on 4322

const BASE = 'http://localhost:4322';
const results = [];

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
  const html = await res.text();
  return html.match(/csrf-token" content="([^"]+)"/)?.[1] || '';
}

async function get(path, session) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Cookie: `portal_session=${session}` }, redirect: 'manual',
  });
  return { status: res.status, html: await res.text(), headers: res.headers };
}

async function apiPost(path, body, session, csrf) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `portal_session=${session}`, 'X-CSRF-Token': csrf },
    body: JSON.stringify(body), redirect: 'manual',
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

async function apiPut(path, body, session, csrf) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: `portal_session=${session}`, 'X-CSRF-Token': csrf },
    body: JSON.stringify(body), redirect: 'manual',
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

async function apiDel(path, session, csrf) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Cookie: `portal_session=${session}`, 'X-CSRF-Token': csrf },
    redirect: 'manual',
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

async function run() {
  console.log('Logging in...');
  const adminSession = await login('admin@dev2.test', 'testpass123');
  const adminCsrf = await getCsrf(adminSession);
  const clientASession = await login('testuser@dev2.test', 'testpass123');
  const clientACsrf = await getCsrf(clientASession);
  const clientBSession = await login('clientb@dev2.test', 'testpass123');
  console.log('All sessions: OK\n');

  // ============ SETUP: create test data as admin ============
  console.log('Setting up test data...');

  // Contract for Client A
  let r = await apiPost('/portal/api/admin/contracts/', {
    client_id: 'jlCeA1SCHv8D6zD4U3h0b', title: 'Client UI Test Contract', type: 'fixed', total_value: 5000,
  }, adminSession, adminCsrf);
  const contractId = r.body.id;

  // Project (client visible)
  r = await apiPost('/portal/api/admin/projects/', {
    contract_id: contractId, client_id: 'jlCeA1SCHv8D6zD4U3h0b', title: 'Client UI Test Project', client_visible: true,
  }, adminSession, adminCsrf);
  const projectId = r.body.id;

  // Milestone (client visible, in_progress)
  r = await apiPost('/portal/api/admin/milestones/', {
    project_id: projectId, title: 'Design Phase', due_date: '2026-05-30',
    client_visible: true, client_update_text: 'Working on wireframes',
  }, adminSession, adminCsrf);
  const milestoneId = r.body.id;
  await apiPut(`/portal/api/admin/milestones/${milestoneId}`, { status: 'in_progress' }, adminSession, adminCsrf);

  // Visible task
  r = await apiPost('/portal/api/admin/tasks/', {
    milestone_id: milestoneId, title: 'Homepage wireframe', client_visible: true,
    client_update_text: 'Draft ready for review', estimated_hours: 6, actual_hours: 3,
  }, adminSession, adminCsrf);
  const visibleTaskId = r.body.id;

  // Internal task (NOT visible)
  r = await apiPost('/portal/api/admin/tasks/', {
    milestone_id: milestoneId, title: 'Internal: setup dev environment',
    client_visible: false, estimated_hours: 2,
  }, adminSession, adminCsrf);
  const internalTaskId = r.body.id;

  // Invoice (client visible)
  r = await apiPost('/portal/api/admin/invoices/', {
    contract_id: contractId, client_id: 'jlCeA1SCHv8D6zD4U3h0b',
  }, adminSession, adminCsrf);
  const invoiceId = r.body.id;
  await apiPut(`/portal/api/admin/invoices/${invoiceId}`, {
    action: 'add_item', description: 'Design retainer', quantity: 1, unit_price: 2500,
  }, adminSession, adminCsrf);
  await apiPut(`/portal/api/admin/invoices/${invoiceId}`, {
    status: 'sent', issued_date: '2026-04-11', due_date: '2026-04-30', client_visible: true,
  }, adminSession, adminCsrf);

  // Partial payment
  await apiPost('/portal/api/admin/payments/record', {
    invoice_id: invoiceId, amount: 1000, payment_method: 'transfer', paid_at: '2026-04-12T12:00:00Z',
  }, adminSession, adminCsrf);

  // Approval (pending)
  r = await apiPost('/portal/api/admin/approvals/', {
    contract_id: contractId, title: 'Approve homepage design', description: 'Please review the attached mockup and confirm direction.',
  }, adminSession, adminCsrf);
  const approvalId = r.body.id;

  // Notifications for client user
  const { createClient: createDbClient } = await import('@libsql/client');
  const db = createDbClient({ url: 'file:./data/dev2.db' });
  const { nanoid } = await import('nanoid');
  await db.execute({
    sql: "INSERT INTO notifications (id, user_id, type, title, body) VALUES (?, 'ukPCtjfLtebMs8xRHXij1', 'milestone_completed', 'Milestone completed', 'Design phase is done')",
    args: [nanoid()],
  });

  console.log('Test data ready.\n');

  // ============ 1. PAGE LOADS ============
  console.log('--- PAGE LOADS (Client A) ---');

  r = await get('/portal/projects', clientASession);
  test('page.projects', r.status === 200 && r.html.includes('Your Projects'), `status: ${r.status}`);

  r = await get('/portal/approvals', clientASession);
  test('page.approvals', r.status === 200 && r.html.includes('Approvals'), `status: ${r.status}`);

  r = await get('/portal/invoices', clientASession);
  test('page.invoices', r.status === 200 && r.html.includes('Invoices'), `status: ${r.status}`);

  r = await get('/portal/notifications', clientASession);
  test('page.notifications', r.status === 200 && r.html.includes('Notifications'), `status: ${r.status}`);

  // ============ 2. PROJECTS DATA SAFETY ============
  console.log('\n--- DATA SAFETY ---');

  r = await get('/portal/projects', clientASession);
  const projHtml = r.html;

  test('safety.project_visible', projHtml.includes('Client UI Test Project'), 'project not found');
  test('safety.milestone_visible', projHtml.includes('Design Phase'), 'milestone not found');
  test('safety.visible_task_shown', projHtml.includes('Homepage wireframe'), 'visible task not found');
  test('safety.client_update_shown', projHtml.includes('Working on wireframes'), 'client_update_text not found');
  test('safety.internal_task_hidden', !projHtml.includes('Internal: setup dev environment'), 'INTERNAL TASK LEAKED');
  test('safety.no_estimated_hours', !projHtml.includes('estimated_hours') && !projHtml.includes('6 hours') && !projHtml.includes('6h est'), 'hours leaked');
  test('safety.no_actual_hours', !projHtml.includes('actual_hours') && !projHtml.includes('3 hours'), 'actual hours leaked');
  test('safety.no_assigned_to', !projHtml.includes('assigned_to'), 'assigned_to leaked');
  test('safety.no_priority_field', !projHtml.includes('"priority"'), 'priority leaked as field name');

  // ============ 3. INVOICES DATA SAFETY ============
  console.log('\n--- INVOICE DATA ---');

  r = await get('/portal/invoices', clientASession);
  const invHtml = r.html;

  test('invoice.shown', invHtml.includes('INV-'), 'invoice number not found');
  test('invoice.total_shown', invHtml.includes('2500') || invHtml.includes('2,500'), 'total not found');
  test('invoice.payment_shown', invHtml.includes('1000') || invHtml.includes('1,000'), 'payment amount not found');
  test('invoice.no_created_by', !invHtml.includes('created_by'), 'created_by leaked');
  test('invoice.no_contract_id', !invHtml.includes(contractId), 'contract_id leaked in HTML');

  // ============ 4. APPROVALS ============
  console.log('\n--- APPROVALS ---');

  r = await get('/portal/approvals', clientASession);
  test('approval.shown', r.html.includes('Approve homepage design'), 'approval not found');
  test('approval.description_shown', r.html.includes('Please review the attached mockup'), 'description not found');
  test('approval.has_approve_btn', r.html.includes('data-approve'), 'approve button not found');

  // Respond to approval
  r = await apiPost('/portal/api/client/approvals', {
    id: approvalId, status: 'approved', response_note: 'Looks great, proceed',
  }, clientASession, clientACsrf);
  test('approval.respond', r.status === 200, `status: ${r.status}`);

  // Verify approval is gone from pending list
  r = await get('/portal/approvals', clientASession);
  test('approval.gone_after_respond', !r.html.includes('Approve homepage design') || r.html.includes('Nothing waiting on you'), 'still showing after response');

  // ============ 5. CROSS-TENANT (Client B) ============
  console.log('\n--- CROSS-TENANT (Client B) ---');

  r = await get('/portal/projects', clientBSession);
  test('cross_tenant.no_projects', r.status === 200 && !r.html.includes('Client UI Test'), 'Client A project leaked to B');

  r = await get('/portal/invoices', clientBSession);
  test('cross_tenant.no_invoices', r.status === 200 && !r.html.includes('INV-'), 'Client A invoice leaked to B');

  r = await get('/portal/approvals', clientBSession);
  test('cross_tenant.no_approvals', r.status === 200 && !r.html.includes('Approve homepage'), 'Client A approval leaked to B');

  // ============ 6. ADMIN LOCKOUT ============
  console.log('\n--- ADMIN LOCKOUT ---');

  r = await get('/portal/admin/contracts', clientASession);
  // Middleware redirects non-admin to dashboard
  test('lockout.admin_contracts', r.status === 302 || r.html.includes('Dashboard'), `status: ${r.status}`);

  r = await get('/portal/admin/invoices', clientASession);
  test('lockout.admin_invoices', r.status === 302 || r.html.includes('Dashboard'), `status: ${r.status}`);

  // ============ 7. NAV VERIFICATION ============
  console.log('\n--- NAV ---');

  r = await get('/portal/projects', clientASession);
  test('nav.projects_link', r.html.includes('href="/portal/projects"'), 'Projects nav link missing');
  test('nav.approvals_link', r.html.includes('href="/portal/approvals"'), 'Approvals nav link missing');
  test('nav.invoices_link', r.html.includes('href="/portal/invoices"'), 'Invoices nav link missing');
  test('nav.work_section', r.html.includes('>Work<'), 'Work section header missing');
  test('nav.reports_section', r.html.includes('>Reports<'), 'Reports section header missing');
  test('nav.notifications_link', r.html.includes('href="/portal/notifications"'), 'Notifications link missing');
  test('nav.no_admin_section', !r.html.includes('href="/portal/admin/contracts"'), 'Admin links leaked to client nav');

  // ============ 8. EMPTY STATES ============
  console.log('\n--- EMPTY STATES ---');

  // Client B has no data
  r = await get('/portal/projects', clientBSession);
  test('empty.projects', r.html.includes('No active projects'), 'empty state missing');

  r = await get('/portal/invoices', clientBSession);
  test('empty.invoices', r.html.includes('No invoices yet'), 'empty state missing');

  r = await get('/portal/approvals', clientBSession);
  test('empty.approvals', r.html.includes('Nothing waiting on you'), 'empty state missing');

  // ============ CLEANUP ============
  await apiDel(`/portal/api/admin/contracts/${contractId}`, adminSession, adminCsrf);

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
