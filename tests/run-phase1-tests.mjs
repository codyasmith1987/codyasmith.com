#!/usr/bin/env node
// Phase 1 endpoint integration tests — real HTTP against dev2 on 4322
// Run: node tests/run-phase1-tests.mjs

const BASE = 'http://localhost:4322';

// Log in and extract session cookie from Set-Cookie header
async function login(email, password) {
  const res = await fetch(`${BASE}/portal/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    redirect: 'manual',
  });
  const cookies = res.headers.getSetCookie?.() || [];
  for (const c of cookies) {
    const match = c.match(/portal_session=([^;]+)/);
    if (match) return match[1];
  }
  // Fallback: check if redirect has cookie
  throw new Error(`Login failed for ${email}: status ${res.status}`);
}

let ADMIN_SESSION = '';
let CLIENT_SESSION = '';

// We need CSRF tokens — get them from a page load
async function getCsrf(session) {
  const res = await fetch(`${BASE}/portal/dashboard`, {
    headers: { Cookie: `portal_session=${session}` },
    redirect: 'manual',
  });
  const html = await res.text();
  const match = html.match(/csrf-token" content="([^"]+)"/);
  return match ? match[1] : '';
}

// Test runner
const results = [];
let adminCsrf = '';
let clientCsrf = '';

async function api(method, path, body, session, csrf) {
  const headers = {
    Cookie: `portal_session=${session}`,
    'Content-Type': 'application/json',
  };
  if (csrf) headers['X-CSRF-Token'] = csrf;

  const opts = { method, headers };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);

  const url = method === 'GET' && body === null ? `${BASE}${path}` : `${BASE}${path}`;
  const res = await fetch(url, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

function adminGet(path) { return api('GET', path, null, ADMIN_SESSION, null); }
function adminPost(path, body) { return api('POST', path, body, ADMIN_SESSION, adminCsrf); }
function adminPut(path, body) { return api('PUT', path, body, ADMIN_SESSION, adminCsrf); }
function adminDelete(path) { return api('DELETE', path, null, ADMIN_SESSION, adminCsrf); }
function clientGet(path) { return api('GET', path, null, CLIENT_SESSION, null); }
function clientPost(path, body) { return api('POST', path, body, CLIENT_SESSION, clientCsrf); }

function test(name, pass, detail) {
  results.push({ name, pass, detail });
  const icon = pass ? 'PASS' : 'FAIL';
  console.log(`[${icon}] ${name}`);
  if (!pass) console.log(`       ${typeof detail === 'object' ? JSON.stringify(detail) : detail}`);
}

async function run() {
  console.log('Logging in...');
  ADMIN_SESSION = await login('admin@dev2.test', 'testpass123');
  CLIENT_SESSION = await login('testuser@dev2.test', 'testpass123');
  console.log(`Admin session: ${ADMIN_SESSION ? 'OK' : 'MISSING'}`);
  console.log(`Client session: ${CLIENT_SESSION ? 'OK' : 'MISSING'}`);

  adminCsrf = await getCsrf(ADMIN_SESSION);
  clientCsrf = await getCsrf(CLIENT_SESSION);
  console.log(`Admin CSRF: ${adminCsrf ? 'OK' : 'MISSING'}`);
  console.log(`Client CSRF: ${clientCsrf ? 'OK' : 'MISSING'}`);
  console.log('');

  // ============ CONTRACTS ============
  console.log('--- CONTRACTS ---');

  // Create
  let r = await adminPost('/portal/api/admin/contracts/', {
    client_id: 'jlCeA1SCHv8D6zD4U3h0b',
    title: 'Test Contract Alpha',
    description: 'Integration test contract',
    type: 'fixed',
    total_value: 5000,
    start_date: '2026-04-01',
    end_date: '2026-06-30',
  });
  const contractId = r.body?.id;
  test('contract.create', r.status === 201 && !!contractId, r.body);

  // List
  r = await adminGet('/portal/api/admin/contracts/');
  test('contract.list', r.status === 200 && Array.isArray(r.body) && r.body.some(c => c.id === contractId), `count: ${r.body?.length}`);

  // List by client
  r = await adminGet('/portal/api/admin/contracts/?client_id=jlCeA1SCHv8D6zD4U3h0b');
  test('contract.list_by_client', r.status === 200 && r.body.some(c => c.id === contractId), `count: ${r.body?.length}`);

  // Get
  r = await adminGet(`/portal/api/admin/contracts/${contractId}`);
  test('contract.get', r.status === 200 && r.body.title === 'Test Contract Alpha', r.body);

  // Update
  r = await adminPut(`/portal/api/admin/contracts/${contractId}`, {
    status: 'active',
    title: 'Test Contract Alpha Updated',
  });
  test('contract.update', r.status === 200, r.body);

  // Verify update
  r = await adminGet(`/portal/api/admin/contracts/${contractId}`);
  test('contract.update_verify', r.body.status === 'active' && r.body.title === 'Test Contract Alpha Updated', r.body);

  // ============ PROJECTS ============
  console.log('\n--- PROJECTS ---');

  r = await adminPost('/portal/api/admin/projects/', {
    contract_id: contractId,
    client_id: 'jlCeA1SCHv8D6zD4U3h0b',
    title: 'Test Project Beta',
    description: 'Integration test project',
    client_visible: true,
  });
  const projectId = r.body?.id;
  test('project.create', r.status === 201 && !!projectId, r.body);

  r = await adminGet(`/portal/api/admin/projects/?contract_id=${contractId}`);
  test('project.list_by_contract', r.status === 200 && r.body.some(p => p.id === projectId), `count: ${r.body?.length}`);

  r = await adminGet(`/portal/api/admin/projects/${projectId}`);
  test('project.get', r.status === 200 && r.body.title === 'Test Project Beta', r.body);

  r = await adminPut(`/portal/api/admin/projects/${projectId}`, {
    status: 'in_progress',
    title: 'Test Project Beta Updated',
  });
  test('project.update', r.status === 200, r.body);

  // ============ MILESTONES ============
  console.log('\n--- MILESTONES ---');

  r = await adminPost('/portal/api/admin/milestones/', {
    project_id: projectId,
    title: 'Test Milestone Gamma',
    description: 'Integration test milestone',
    due_date: '2026-05-15',
    client_visible: true,
    client_update_text: 'Design phase is underway',
  });
  const milestoneId = r.body?.id;
  test('milestone.create', r.status === 201 && !!milestoneId, r.body);

  r = await adminGet(`/portal/api/admin/milestones/?project_id=${projectId}`);
  test('milestone.list_by_project', r.status === 200 && r.body.some(m => m.id === milestoneId), `count: ${r.body?.length}`);

  r = await adminGet(`/portal/api/admin/milestones/${milestoneId}`);
  test('milestone.get', r.status === 200 && r.body.title === 'Test Milestone Gamma', r.body);

  r = await adminPut(`/portal/api/admin/milestones/${milestoneId}`, {
    status: 'in_progress',
  });
  test('milestone.update', r.status === 200, r.body);

  // Test auto-completed_at
  r = await adminPut(`/portal/api/admin/milestones/${milestoneId}`, {
    status: 'completed',
  });
  test('milestone.auto_completed_at', r.status === 200, r.body);
  r = await adminGet(`/portal/api/admin/milestones/${milestoneId}`);
  test('milestone.completed_at_set', !!r.body.completed_at, `completed_at: ${r.body.completed_at}`);

  // Reset for further testing
  await adminPut(`/portal/api/admin/milestones/${milestoneId}`, { status: 'in_progress' });

  // ============ TASKS ============
  console.log('\n--- TASKS ---');

  // Create visible task
  r = await adminPost('/portal/api/admin/tasks/', {
    milestone_id: milestoneId,
    title: 'Test Task Delta (visible)',
    description: 'Client-visible task',
    priority: 'high',
    estimated_hours: 4,
    actual_hours: 2,
    client_visible: true,
    client_update_text: 'Working on your homepage redesign',
  });
  const visibleTaskId = r.body?.id;
  test('task.create_visible', r.status === 201 && !!visibleTaskId, r.body);

  // Create internal task
  r = await adminPost('/portal/api/admin/tasks/', {
    milestone_id: milestoneId,
    title: 'Test Task Epsilon (internal)',
    description: 'Internal only task with cost data',
    priority: 'normal',
    estimated_hours: 8,
    client_visible: false,
  });
  const internalTaskId = r.body?.id;
  test('task.create_internal', r.status === 201 && !!internalTaskId, r.body);

  r = await adminGet(`/portal/api/admin/tasks/?milestone_id=${milestoneId}`);
  test('task.list_by_milestone', r.status === 200 && r.body.length === 2, `count: ${r.body?.length}`);

  r = await adminGet(`/portal/api/admin/tasks/${visibleTaskId}`);
  test('task.get', r.status === 200 && r.body.title === 'Test Task Delta (visible)', r.body);

  r = await adminPut(`/portal/api/admin/tasks/${visibleTaskId}`, {
    status: 'done',
    actual_hours: 3.5,
  });
  test('task.update', r.status === 200, r.body);

  r = await adminGet(`/portal/api/admin/tasks/${visibleTaskId}`);
  test('task.auto_completed_at', !!r.body.completed_at, `completed_at: ${r.body.completed_at}`);

  // ============ INVOICES ============
  console.log('\n--- INVOICES ---');

  r = await adminPost('/portal/api/admin/invoices/', {
    contract_id: contractId,
    client_id: 'jlCeA1SCHv8D6zD4U3h0b',
    milestone_id: milestoneId,
    due_date: '2026-05-01',
    notes: 'Test invoice',
  });
  const invoiceId = r.body?.id;
  const invoiceNumber = r.body?.invoice_number;
  test('invoice.create', r.status === 201 && !!invoiceId && !!invoiceNumber, r.body);

  // Add line items
  r = await adminPut(`/portal/api/admin/invoices/${invoiceId}`, {
    action: 'add_item',
    description: 'Website design',
    quantity: 1,
    unit_price: 2000,
  });
  const item1Id = r.body?.id;
  test('invoice.add_item_1', r.status === 200 && !!item1Id, r.body);

  r = await adminPut(`/portal/api/admin/invoices/${invoiceId}`, {
    action: 'add_item',
    description: 'SEO setup',
    quantity: 2,
    unit_price: 500,
  });
  const item2Id = r.body?.id;
  test('invoice.add_item_2', r.status === 200 && !!item2Id, r.body);

  // Verify totals after adding items (subtotal should be 2000 + 1000 = 3000)
  r = await adminGet(`/portal/api/admin/invoices/${invoiceId}`);
  test('invoice.total_after_add', r.body.subtotal === 3000 && r.body.total === 3000, `subtotal: ${r.body.subtotal}, total: ${r.body.total}`);

  // Update item
  r = await adminPut(`/portal/api/admin/invoices/${invoiceId}`, {
    action: 'update_item',
    item_id: item2Id,
    unit_price: 750,
  });
  test('invoice.update_item', r.status === 200, r.body);

  // Verify recalc (2000 + 2*750 = 3500)
  r = await adminGet(`/portal/api/admin/invoices/${invoiceId}`);
  test('invoice.total_after_update', r.body.subtotal === 3500 && r.body.total === 3500, `subtotal: ${r.body.subtotal}, total: ${r.body.total}`);

  // Delete item
  r = await adminPut(`/portal/api/admin/invoices/${invoiceId}`, {
    action: 'delete_item',
    item_id: item2Id,
  });
  test('invoice.delete_item', r.status === 200, r.body);

  // Verify recalc (2000 only)
  r = await adminGet(`/portal/api/admin/invoices/${invoiceId}`);
  test('invoice.total_after_delete', r.body.subtotal === 2000 && r.body.total === 2000, `subtotal: ${r.body.subtotal}, total: ${r.body.total}`);

  // Make invoice visible to client for later client-endpoint tests
  r = await adminPut(`/portal/api/admin/invoices/${invoiceId}`, {
    status: 'sent',
    issued_date: '2026-04-11',
    client_visible: true,
  });
  test('invoice.send', r.status === 200, r.body);

  // ============ PAYMENTS ============
  console.log('\n--- PAYMENTS ---');

  // Partial payment
  r = await adminPost('/portal/api/admin/payments/record', {
    invoice_id: invoiceId,
    amount: 500,
    payment_method: 'check',
    reference: 'CHK-001',
    paid_at: '2026-04-11T12:00:00Z',
  });
  const payment1Id = r.body?.id;
  test('payment.record_partial', r.status === 201 && !!payment1Id, r.body);

  // Verify status transition to partial
  r = await adminGet(`/portal/api/admin/invoices/${invoiceId}`);
  test('payment.status_partial', r.body.status === 'partial' && r.body.amount_paid === 500, `status: ${r.body.status}, paid: ${r.body.amount_paid}`);

  // Full payment (remaining 1500)
  r = await adminPost('/portal/api/admin/payments/record', {
    invoice_id: invoiceId,
    amount: 1500,
    payment_method: 'transfer',
    reference: 'TXN-002',
    paid_at: '2026-04-12T12:00:00Z',
  });
  test('payment.record_full', r.status === 201, r.body);

  // Verify status transition to paid
  r = await adminGet(`/portal/api/admin/invoices/${invoiceId}`);
  test('payment.status_paid', r.body.status === 'paid' && r.body.amount_paid === 2000, `status: ${r.body.status}, paid: ${r.body.amount_paid}`);

  // ============ APPROVALS ============
  console.log('\n--- APPROVALS ---');

  r = await adminPost('/portal/api/admin/approvals/', {
    contract_id: contractId,
    milestone_id: milestoneId,
    title: 'Approve homepage mockup',
    description: 'Please review the attached mockup',
  });
  const approvalId = r.body?.id;
  test('approval.create', r.status === 201 && !!approvalId, r.body);

  r = await adminGet('/portal/api/admin/approvals/?pending=true');
  test('approval.list_pending', r.status === 200 && r.body.some(a => a.id === approvalId), `count: ${r.body?.length}`);

  // Client approves
  r = await clientPost('/portal/api/client/approvals', {
    id: approvalId,
    status: 'approved',
    response_note: 'Looks great!',
  });
  test('approval.client_approve', r.status === 200, r.body);

  r = await adminGet(`/portal/api/admin/approvals/${approvalId}`);
  test('approval.verify_approved', r.body.status === 'approved' && r.body.response_note === 'Looks great!', r.body);

  // Create another and reject
  r = await adminPost('/portal/api/admin/approvals/', {
    contract_id: contractId,
    title: 'Approve color palette',
    description: 'Review brand colors',
  });
  const approval2Id = r.body?.id;
  test('approval.create_2', r.status === 201 && !!approval2Id, r.body);

  r = await clientPost('/portal/api/client/approvals', {
    id: approval2Id,
    status: 'rejected',
    response_note: 'Too bright, need earth tones',
  });
  test('approval.client_reject', r.status === 200, r.body);

  r = await adminGet(`/portal/api/admin/approvals/${approval2Id}`);
  test('approval.verify_rejected', r.body.status === 'rejected', r.body);

  // ============ CHANGE ORDERS ============
  console.log('\n--- CHANGE ORDERS ---');

  r = await adminPost('/portal/api/admin/change-orders/', {
    contract_id: contractId,
    title: 'Add blog section',
    description: 'Client wants a blog added to scope',
    cost_impact: 1500,
    time_impact_days: 7,
  });
  const changeOrderId = r.body?.id;
  test('change_order.create', r.status === 201 && !!changeOrderId, r.body);

  r = await adminGet(`/portal/api/admin/change-orders/?contract_id=${contractId}`);
  test('change_order.list', r.status === 200 && r.body.some(co => co.id === changeOrderId), `count: ${r.body?.length}`);

  r = await adminPut(`/portal/api/admin/change-orders/${changeOrderId}`, {
    action: 'approve',
  });
  test('change_order.approve', r.status === 200, r.body);

  r = await adminGet(`/portal/api/admin/change-orders/${changeOrderId}`);
  test('change_order.verify_approved', r.body.status === 'approved' && !!r.body.approved_at, r.body);

  // ============ NOTIFICATIONS ============
  console.log('\n--- NOTIFICATIONS ---');

  // Create notification for client user directly via DB (simulating trigger)
  const notifRes = await fetch(`${BASE}/portal/api/notifications/`, {
    method: 'GET',
    headers: { Cookie: `portal_session=${CLIENT_SESSION}` },
  });
  const notifsBefore = await notifRes.json();

  // We need to create notifications. Since there's no admin create-notification endpoint,
  // insert directly into DB
  const { createClient } = await import('@libsql/client');
  const db = createClient({ url: 'file:./data/dev2.db' });
  const { nanoid } = await import('nanoid');

  const notif1Id = nanoid();
  const notif2Id = nanoid();
  const notif3Id = nanoid();
  await db.batch([
    { sql: "INSERT INTO notifications (id, user_id, type, title, body) VALUES (?, ?, 'milestone_completed', 'Milestone completed', 'Design phase is done')", args: [notif1Id, 'ukPCtjfLtebMs8xRHXij1'] },
    { sql: "INSERT INTO notifications (id, user_id, type, title, body) VALUES (?, ?, 'invoice_sent', 'Invoice ready', 'Invoice INV-2026-0001 is ready for review')", args: [notif2Id, 'ukPCtjfLtebMs8xRHXij1'] },
    { sql: "INSERT INTO notifications (id, user_id, type, title, body) VALUES (?, ?, 'general', 'Welcome', 'Welcome to the portal')", args: [notif3Id, 'ukPCtjfLtebMs8xRHXij1'] },
  ], 'write');

  r = await api('GET', '/portal/api/notifications/', null, CLIENT_SESSION, null);
  test('notification.list', r.status === 200 && Array.isArray(r.body) && r.body.length >= 3, `count: ${r.body?.length}`);

  r = await api('GET', '/portal/api/notifications/?count=true', null, CLIENT_SESSION, null);
  test('notification.unread_count', r.status === 200 && r.body.unread >= 3, `unread: ${r.body?.unread}`);

  // Mark one as read
  r = await clientPost('/portal/api/notifications/', { id: notif1Id });
  test('notification.mark_read', r.status === 200, r.body);

  r = await api('GET', '/portal/api/notifications/?count=true', null, CLIENT_SESSION, null);
  test('notification.unread_after_mark', r.body.unread >= 2, `unread: ${r.body?.unread}`);

  // Mark all read
  r = await clientPost('/portal/api/notifications/', { all: true });
  test('notification.mark_all_read', r.status === 200, r.body);

  r = await api('GET', '/portal/api/notifications/?count=true', null, CLIENT_SESSION, null);
  test('notification.unread_zero', r.body.unread === 0, `unread: ${r.body?.unread}`);

  // ============ CLIENT-VISIBLE FILTERING ============
  console.log('\n--- CLIENT-VISIBLE FILTERING ---');

  // Client projects endpoint
  r = await clientGet('/portal/api/client/projects');
  test('client.projects_accessible', r.status === 200 && Array.isArray(r.body), `count: ${r.body?.length}`);

  if (r.status === 200 && r.body.length > 0) {
    const proj = r.body[0];
    // Check no internal fields leak at project level
    test('client.projects_no_internal_fields',
      proj.estimated_hours === undefined && proj.actual_hours === undefined && proj.sort_order === undefined,
      `keys: ${Object.keys(proj)}`);

    // Check milestones
    if (proj.milestones?.length > 0) {
      const ms = proj.milestones[0];
      test('client.milestone_has_update_text', ms.client_update_text !== undefined, `keys: ${Object.keys(ms)}`);

      // Check tasks within milestones
      if (ms.tasks?.length > 0) {
        const task = ms.tasks[0];
        // CRITICAL: no estimated_hours, actual_hours, or internal description
        test('client.task_no_hours',
          task.estimated_hours === undefined && task.actual_hours === undefined,
          `keys: ${Object.keys(task)}`);
        test('client.task_no_description',
          task.description === undefined,
          `keys: ${Object.keys(task)}`);
        test('client.task_no_internal_fields',
          task.assigned_to === undefined && task.priority === undefined && task.sort_order === undefined,
          `keys: ${Object.keys(task)}`);
      }

      // Verify internal task (client_visible=0) is NOT present
      const allTaskTitles = proj.milestones.flatMap(m => m.tasks.map(t => t.title));
      test('client.no_invisible_tasks',
        !allTaskTitles.includes('Test Task Epsilon (internal)'),
        `tasks: ${JSON.stringify(allTaskTitles)}`);
    }
  }

  // Client invoices endpoint
  r = await clientGet('/portal/api/client/invoices');
  test('client.invoices_accessible', r.status === 200 && Array.isArray(r.body), `count: ${r.body?.length}`);

  if (r.status === 200 && r.body.length > 0) {
    const inv = r.body[0];
    // Should have total, amount_paid, items, payments
    test('client.invoice_has_total', inv.total !== undefined && inv.amount_paid !== undefined, `total: ${inv.total}, paid: ${inv.amount_paid}`);
    // Should NOT have created_by or internal admin fields
    test('client.invoice_no_admin_fields',
      inv.created_by === undefined && inv.contract_id === undefined,
      `keys: ${Object.keys(inv)}`);
  }

  // Client approvals endpoint
  r = await clientGet('/portal/api/client/approvals');
  test('client.approvals_accessible', r.status === 200 && Array.isArray(r.body), `count: ${r.body?.length}`);
  // All approvals should now be responded to (none pending)
  // That's expected since we approved/rejected both

  // ============ DELETE TESTS ============
  console.log('\n--- DELETE TESTS ---');

  // Create throwaway entities to delete
  r = await adminPost('/portal/api/admin/contracts/', {
    client_id: 'jlCeA1SCHv8D6zD4U3h0b',
    title: 'Delete Me Contract',
  });
  const delContractId = r.body?.id;

  r = await adminPost('/portal/api/admin/projects/', {
    contract_id: delContractId,
    client_id: 'jlCeA1SCHv8D6zD4U3h0b',
    title: 'Delete Me Project',
  });
  const delProjectId = r.body?.id;

  r = await adminPost('/portal/api/admin/milestones/', {
    project_id: delProjectId,
    title: 'Delete Me Milestone',
  });
  const delMilestoneId = r.body?.id;

  r = await adminPost('/portal/api/admin/tasks/', {
    milestone_id: delMilestoneId,
    title: 'Delete Me Task',
  });
  const delTaskId = r.body?.id;

  // Delete in reverse order (respecting FK constraints)
  r = await adminDelete(`/portal/api/admin/tasks/${delTaskId}`);
  test('task.delete', r.status === 200, r.body);

  r = await adminGet(`/portal/api/admin/tasks/${delTaskId}`);
  test('task.delete_verify', r.status === 404, r.body);

  r = await adminDelete(`/portal/api/admin/milestones/${delMilestoneId}`);
  test('milestone.delete', r.status === 200, r.body);

  r = await adminDelete(`/portal/api/admin/projects/${delProjectId}`);
  test('project.delete', r.status === 200, r.body);

  r = await adminDelete(`/portal/api/admin/contracts/${delContractId}`);
  test('contract.delete', r.status === 200, r.body);

  r = await adminGet(`/portal/api/admin/contracts/${delContractId}`);
  test('contract.delete_verify', r.status === 404, r.body);

  // ============ SUMMARY ============
  console.log('\n========================================');
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log(`TOTAL: ${results.length} | PASS: ${passed} | FAIL: ${failed}`);
  console.log('========================================\n');

  if (failed > 0) {
    console.log('FAILURES:');
    results.filter(r => !r.pass).forEach(r => {
      console.log(`  - ${r.name}: ${typeof r.detail === 'object' ? JSON.stringify(r.detail) : r.detail}`);
    });
  }

  // Output full results as JSON for the test doc
  console.log('\n--- FULL RESULTS JSON ---');
  console.log(JSON.stringify(results, null, 2));
}

run().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
