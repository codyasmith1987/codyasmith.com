#!/usr/bin/env node
// Admin UI end-to-end verification via curl against dev2 on 4322

const BASE = 'http://localhost:4322';
const results = [];

function route(path) {
  return path.replace(/\/(\?|$)/, '$1');
}

async function clearLoginRateLimits() {
  const { createClient } = await import('@libsql/client');
  const db = createClient({ url: 'file:./data/dev2.db' });
  await db.execute("DELETE FROM portal_rate_limits WHERE key LIKE 'login:%'").catch(err => {
    if (!/no such table/i.test(String(err?.message || ''))) throw err;
  });
}

function test(name, pass, detail) {
  results.push({ name, pass, detail: String(detail).slice(0, 200) });
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
  const m = html.match(/csrf-token" content="([^"]+)"/);
  return m ? m[1] : '';
}

async function get(path, session) {
  const res = await fetch(`${BASE}${route(path)}`, {
    headers: { Cookie: `portal_session=${session}` }, redirect: 'manual',
  });
  return { status: res.status, html: await res.text() };
}

async function post(path, body, session, csrf) {
  const res = await fetch(`${BASE}${route(path)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `portal_session=${session}`, 'X-CSRF-Token': csrf },
    body: JSON.stringify(body), redirect: 'manual',
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

async function put(path, body, session, csrf) {
  const res = await fetch(`${BASE}${route(path)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: `portal_session=${session}`, 'X-CSRF-Token': csrf },
    body: JSON.stringify(body), redirect: 'manual',
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

async function del(path, session, csrf) {
  const res = await fetch(`${BASE}${route(path)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Cookie: `portal_session=${session}`, 'X-CSRF-Token': csrf },
    redirect: 'manual',
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

async function run() {
  await clearLoginRateLimits();
  console.log('Logging in...');
  const session = await login('admin@dev2.test', 'testpass123');
  const csrf = await getCsrf(session);
  console.log('Session: OK, CSRF: OK\n');

  // ============ 1. PAGE LOADS ============
  console.log('--- PAGE LOADS ---');
  let r;

  r = await get('/portal/admin/contracts', session);
  test('page.contracts', r.status === 200 && r.html.includes('Contracts'), `status: ${r.status}`);

  r = await get('/portal/admin/invoices', session);
  test('page.invoices', r.status === 200 && r.html.includes('Invoices'), `status: ${r.status}`);

  r = await get('/portal/admin/approvals', session);
  test('page.approvals', r.status === 200 && r.html.includes('Approvals'), `status: ${r.status}`);

  r = await get('/portal/admin/change-orders', session);
  test('page.change_orders', r.status === 200 && r.html.includes('Change Orders'), `status: ${r.status}`);

  r = await get('/portal/admin/notifications', session);
  test('page.notifications', r.status === 200 && r.html.includes('Notifications'), `status: ${r.status}`);

  // ============ 2. CRUD FLOW ============
  console.log('\n--- CRUD FLOW ---');

  // Create contract
  r = await post('/portal/api/admin/contracts/', {
    client_id: 'jlCeA1SCHv8D6zD4U3h0b',
    title: 'UI Test Contract',
    type: 'fixed',
    total_value: 7500,
    start_date: '2026-04-15',
    end_date: '2026-07-15',
  }, session, csrf);
  const contractId = r.body?.id;
  test('crud.create_contract', r.status === 201 && !!contractId, `status: ${r.status}`);

  // Verify contract in list page HTML
  r = await get('/portal/admin/contracts', session);
  test('crud.contract_in_list', r.html.includes('UI Test Contract'), 'not found in HTML');

  // Create project
  r = await post('/portal/api/admin/projects/', {
    contract_id: contractId,
    client_id: 'jlCeA1SCHv8D6zD4U3h0b',
    title: 'UI Test Project',
  }, session, csrf);
  const projectId = r.body?.id;
  test('crud.create_project', r.status === 201 && !!projectId, `status: ${r.status}`);

  // Verify project in contract detail
  r = await get(`/portal/admin/contracts/${contractId}`, session);
  test('crud.project_in_contract_detail', r.status === 200 && r.html.includes('UI Test Project'), `status: ${r.status}`);

  // Create milestone
  r = await post('/portal/api/admin/milestones/', {
    project_id: projectId,
    title: 'UI Test Milestone',
    due_date: '2026-05-30',
  }, session, csrf);
  const milestoneId = r.body?.id;
  test('crud.create_milestone', r.status === 201 && !!milestoneId, `status: ${r.status}`);

  // Verify milestone in project detail
  r = await get(`/portal/admin/projects/${projectId}`, session);
  test('crud.milestone_in_project_detail', r.status === 200 && r.html.includes('UI Test Milestone'), `status: ${r.status}`);

  // Create task
  r = await post('/portal/api/admin/tasks/', {
    milestone_id: milestoneId,
    title: 'UI Test Task',
    priority: 'high',
  }, session, csrf);
  const taskId = r.body?.id;
  test('crud.create_task', r.status === 201 && !!taskId, `status: ${r.status}`);

  // Verify task in milestone detail
  r = await get(`/portal/admin/milestones/${milestoneId}`, session);
  test('crud.task_in_milestone_detail', r.status === 200 && r.html.includes('UI Test Task'), `status: ${r.status}`);

  // ============ 3. DETAIL PAGES ============
  console.log('\n--- DETAIL PAGES ---');

  r = await get(`/portal/admin/contracts/${contractId}`, session);
  test('detail.contract', r.status === 200 && r.html.includes('UI Test Contract'), `status: ${r.status}`);

  r = await get(`/portal/admin/projects/${projectId}`, session);
  test('detail.project', r.status === 200 && r.html.includes('UI Test Project'), `status: ${r.status}`);

  r = await get(`/portal/admin/milestones/${milestoneId}`, session);
  test('detail.milestone', r.status === 200 && r.html.includes('UI Test Milestone'), `status: ${r.status}`);

  r = await get(`/portal/admin/tasks/${taskId}`, session);
  test('detail.task', r.status === 200 && r.html.includes('UI Test Task'), `status: ${r.status}`);

  // ============ 4. INVOICE FLOW ============
  console.log('\n--- INVOICE FLOW ---');

  r = await post('/portal/api/admin/invoices/', {
    contract_id: contractId,
    client_id: 'jlCeA1SCHv8D6zD4U3h0b',
  }, session, csrf);
  const invoiceId = r.body?.id;
  const invoiceNumber = r.body?.invoice_number;
  test('invoice.create', r.status === 201 && !!invoiceId, `status: ${r.status}`);

  // Add two line items
  r = await put(`/portal/api/admin/invoices/${invoiceId}`, {
    action: 'add_item', description: 'Design work', quantity: 1, unit_price: 3000,
  }, session, csrf);
  test('invoice.add_item_1', r.status === 200, `status: ${r.status}`);

  r = await put(`/portal/api/admin/invoices/${invoiceId}`, {
    action: 'add_item', description: 'Development', quantity: 2, unit_price: 1500,
  }, session, csrf);
  test('invoice.add_item_2', r.status === 200, `status: ${r.status}`);

  // Verify invoice detail shows items and total
  r = await get(`/portal/admin/invoices/${invoiceId}`, session);
  test('invoice.detail_items', r.status === 200 && r.html.includes('Design work') && r.html.includes('Development'), `status: ${r.status}`);
  test('invoice.detail_total', r.html.includes('6000.00') || r.html.includes('6,000'), 'total not found');

  // Mark as sent
  await put(`/portal/api/admin/invoices/${invoiceId}`, {
    status: 'sent', issued_date: '2026-04-11', due_date: '2026-04-30',
  }, session, csrf);

  // Partial payment
  r = await post('/portal/api/admin/payments/record', {
    invoice_id: invoiceId, amount: 2000, payment_method: 'transfer', paid_at: '2026-04-12T12:00:00Z',
  }, session, csrf);
  test('invoice.partial_payment', r.status === 201, `status: ${r.status}`);

  r = await get(`/portal/admin/invoices/${invoiceId}`, session);
  test('invoice.detail_partial', r.html.includes('partial') || r.html.includes('2000') || r.html.includes('2,000'), 'partial not shown');

  // Full payment
  r = await post('/portal/api/admin/payments/record', {
    invoice_id: invoiceId, amount: 4000, payment_method: 'transfer', paid_at: '2026-04-13T12:00:00Z',
  }, session, csrf);
  test('invoice.full_payment', r.status === 201, `status: ${r.status}`);

  r = await get(`/portal/admin/invoices/${invoiceId}`, session);
  test('invoice.detail_paid', r.html.includes('paid'), 'paid status not shown');

  // ============ 5. APPROVAL FLOW ============
  console.log('\n--- APPROVAL FLOW ---');

  r = await post('/portal/api/admin/approvals/', {
    contract_id: contractId, title: 'UI Test Approval', description: 'Please approve this mockup',
  }, session, csrf);
  const approvalId = r.body?.id;
  test('approval.create', r.status === 201 && !!approvalId, `status: ${r.status}`);

  r = await get('/portal/admin/approvals', session);
  test('approval.in_list', r.html.includes('UI Test Approval'), 'not found in HTML');

  // Respond (as admin for simplicity)
  r = await put(`/portal/api/admin/approvals/${approvalId}`, {
    status: 'approved', response_note: 'Looks good',
  }, session, csrf);
  test('approval.respond', r.status === 200, `status: ${r.status}, body: ${JSON.stringify(r.body)}`);

  r = await get('/portal/admin/approvals?all=true', session);
  test('approval.status_updated', r.html.includes('approved'), 'approved status not found');

  // ============ 6. CHANGE ORDER FLOW ============
  console.log('\n--- CHANGE ORDER FLOW ---');

  r = await post('/portal/api/admin/change-orders/', {
    contract_id: contractId, title: 'UI Test Change Order', cost_impact: 2000, time_impact_days: 5,
  }, session, csrf);
  const coId = r.body?.id;
  test('change_order.create', r.status === 201 && !!coId, `status: ${r.status}`);

  r = await get(`/portal/admin/change-orders?contract=${contractId}`, session);
  test('change_order.in_list', r.html.includes('UI Test Change Order'), 'not found in HTML');

  r = await put(`/portal/api/admin/change-orders/${coId}`, { action: 'approve' }, session, csrf);
  test('change_order.approve', r.status === 200, `status: ${r.status}`);

  // ============ 7. NOTIFICATIONS PAGE ============
  console.log('\n--- NOTIFICATIONS ---');

  r = await get('/portal/admin/notifications', session);
  test('notifications.page_loads', r.status === 200 && r.html.includes('Notifications'), `status: ${r.status}`);

  // ============ 8. CASCADE DELETE ============
  console.log('\n--- CASCADE DELETE ---');

  r = await del(`/portal/api/admin/contracts/${contractId}`, session, csrf);
  test('cascade.delete_contract', r.status === 200, `status: ${r.status}`);

  r = await get(`/portal/admin/projects/${projectId}`, session);
  test('cascade.project_gone', r.status === 302 || r.status === 404 || r.html.includes('Contracts'), `status: ${r.status}`);

  r = await get(`/portal/admin/milestones/${milestoneId}`, session);
  test('cascade.milestone_gone', r.status === 302 || r.status === 404 || r.html.includes('Contracts'), `status: ${r.status}`);

  r = await get(`/portal/admin/tasks/${taskId}`, session);
  test('cascade.task_gone', r.status === 302 || r.status === 404 || r.html.includes('Contracts'), `status: ${r.status}`);

  // ============ 9. NAV VERIFICATION ============
  console.log('\n--- NAV ---');

  r = await get('/portal/admin/contracts', session);
  test('nav.contracts_link', r.html.includes('href="/portal/admin/contracts"'), 'Contracts nav link missing');
  test('nav.invoices_link', r.html.includes('href="/portal/admin/invoices"'), 'Invoices nav link missing');
  test('nav.approvals_link', r.html.includes('href="/portal/admin/approvals"'), 'Approvals nav link missing');

  // ============ 10. EMPTY STATE ============
  console.log('\n--- EMPTY STATE ---');

  // Delete all remaining test contracts to get clean empty state
  // (The one we created was already deleted above via cascade)
  // Just check the page with no contracts for this client filter
  r = await get('/portal/admin/contracts?client=nonexistent-client-id', session);
  test('empty.contracts_empty_state', r.html.includes('No contracts yet'), 'empty state not found');

  // ============ 11. SUMMARY CARDS ============
  console.log('\n--- SUMMARY CARDS ---');

  // Create a draft contract
  r = await post('/portal/api/admin/contracts/', {
    client_id: 'jlCeA1SCHv8D6zD4U3h0b', title: 'Summary Test Draft',
  }, session, csrf);
  const draftId = r.body?.id;

  // Create a sent invoice with past due date (should show as overdue candidate)
  r = await post('/portal/api/admin/invoices/', {
    contract_id: draftId, client_id: 'jlCeA1SCHv8D6zD4U3h0b',
  }, session, csrf);
  const overdueInvId = r.body?.id;
  await put(`/portal/api/admin/invoices/${overdueInvId}`, {
    action: 'add_item', description: 'Test item', unit_price: 100,
  }, session, csrf);
  await put(`/portal/api/admin/invoices/${overdueInvId}`, {
    status: 'sent', issued_date: '2026-03-01', due_date: '2026-03-15',
  }, session, csrf);

  // Reload contracts page and check summary cards
  r = await get('/portal/admin/contracts', session);
  test('summary.draft_count', r.html.includes('Draft'), 'Draft card not found');
  test('summary.active_count', r.html.includes('Active'), 'Active card not found');
  test('summary.overdue_count', r.html.includes('Overdue'), 'Overdue card not found');

  // Check that the draft contract count is nonzero
  // Dev mode injects data-astro-source-* attributes, so use a flexible regex
  const draftMatch = r.html.match(/<p[^>]*text-2xl[^>]*>\s*(\d+)\s*<\/p>\s*<p[^>]*>Draft<\/p>/);
  test('summary.draft_nonzero', draftMatch && parseInt(draftMatch[1]) > 0, `match: ${draftMatch?.[1] || 'none'}`);

  // Cleanup
  await del(`/portal/api/admin/contracts/${draftId}`, session, csrf);

  // ============ SUMMARY ============
  console.log('\n========================================');
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log(`TOTAL: ${results.length} | PASS: ${passed} | FAIL: ${failed}`);
  console.log('========================================');

  if (failed > 0) {
    console.log('\nFAILURES:');
    results.filter(r => !r.pass).forEach(r => {
      console.log(`  - ${r.name}: ${r.detail}`);
    });
  }
}

run().catch(err => { console.error('Test runner error:', err); process.exit(1); });
