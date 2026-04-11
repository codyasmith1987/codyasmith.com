# Phase 1 Endpoint Integration Tests

**Executed:** 2026-04-11 against dev2 server on localhost:4322
**Database:** file:./data/dev2.db (local SQLite, not remote Turso)
**Test script:** tests/run-phase1-tests.mjs
**Method:** Real HTTP requests, no mocks. Admin user (admin@dev2.test) and client user (testuser@dev2.test) bootstrapped with bcrypt passwords. CSRF tokens fetched from live page loads.

## Results Summary

**TOTAL: 69 | PASS: 69 | FAIL: 0**

## Test Matrix

### Contracts

| # | Test | Method | Endpoint | Status | Result |
|---|------|--------|----------|--------|--------|
| 1 | contract.create | POST | /portal/api/admin/contracts/ | 201 | PASS |
| 2 | contract.list | GET | /portal/api/admin/contracts/ | 200 | PASS |
| 3 | contract.list_by_client | GET | /portal/api/admin/contracts/?client_id=... | 200 | PASS |
| 4 | contract.get | GET | /portal/api/admin/contracts/:id | 200 | PASS |
| 5 | contract.update | PUT | /portal/api/admin/contracts/:id | 200 | PASS |
| 6 | contract.update_verify | GET | /portal/api/admin/contracts/:id | 200 | PASS |
| 7 | contract.delete | DELETE | /portal/api/admin/contracts/:id | 200 | PASS |
| 8 | contract.delete_verify | GET | /portal/api/admin/contracts/:id | 404 | PASS |

### Projects

| # | Test | Method | Endpoint | Status | Result |
|---|------|--------|----------|--------|--------|
| 9 | project.create | POST | /portal/api/admin/projects/ | 201 | PASS |
| 10 | project.list_by_contract | GET | /portal/api/admin/projects/?contract_id=... | 200 | PASS |
| 11 | project.get | GET | /portal/api/admin/projects/:id | 200 | PASS |
| 12 | project.update | PUT | /portal/api/admin/projects/:id | 200 | PASS |
| 13 | project.delete | DELETE | /portal/api/admin/projects/:id | 200 | PASS |

### Milestones

| # | Test | Method | Endpoint | Status | Result |
|---|------|--------|----------|--------|--------|
| 14 | milestone.create | POST | /portal/api/admin/milestones/ | 201 | PASS |
| 15 | milestone.list_by_project | GET | /portal/api/admin/milestones/?project_id=... | 200 | PASS |
| 16 | milestone.get | GET | /portal/api/admin/milestones/:id | 200 | PASS |
| 17 | milestone.update | PUT | /portal/api/admin/milestones/:id | 200 | PASS |
| 18 | milestone.auto_completed_at | PUT | /portal/api/admin/milestones/:id (status=completed) | 200 | PASS |
| 19 | milestone.completed_at_set | GET | /portal/api/admin/milestones/:id | 200 | PASS |
| 20 | milestone.delete | DELETE | /portal/api/admin/milestones/:id | 200 | PASS |

### Tasks

| # | Test | Method | Endpoint | Status | Result |
|---|------|--------|----------|--------|--------|
| 21 | task.create_visible | POST | /portal/api/admin/tasks/ (client_visible=true) | 201 | PASS |
| 22 | task.create_internal | POST | /portal/api/admin/tasks/ (client_visible=false) | 201 | PASS |
| 23 | task.list_by_milestone | GET | /portal/api/admin/tasks/?milestone_id=... | 200 | PASS |
| 24 | task.get | GET | /portal/api/admin/tasks/:id | 200 | PASS |
| 25 | task.update | PUT | /portal/api/admin/tasks/:id | 200 | PASS |
| 26 | task.auto_completed_at | GET | /portal/api/admin/tasks/:id (after status=done) | 200 | PASS |
| 27 | task.delete | DELETE | /portal/api/admin/tasks/:id | 200 | PASS |
| 28 | task.delete_verify | GET | /portal/api/admin/tasks/:id | 404 | PASS |

### Invoices with Line Item Auto-Recalc

| # | Test | Method | Endpoint | Status | Result |
|---|------|--------|----------|--------|--------|
| 29 | invoice.create | POST | /portal/api/admin/invoices/ | 201 | PASS |
| 30 | invoice.add_item_1 | PUT | /portal/api/admin/invoices/:id (action=add_item, $2000) | 200 | PASS |
| 31 | invoice.add_item_2 | PUT | /portal/api/admin/invoices/:id (action=add_item, 2x$500) | 200 | PASS |
| 32 | invoice.total_after_add | GET | /portal/api/admin/invoices/:id | 200 | PASS - subtotal=3000, total=3000 |
| 33 | invoice.update_item | PUT | /portal/api/admin/invoices/:id (action=update_item, price to $750) | 200 | PASS |
| 34 | invoice.total_after_update | GET | /portal/api/admin/invoices/:id | 200 | PASS - subtotal=3500, total=3500 |
| 35 | invoice.delete_item | PUT | /portal/api/admin/invoices/:id (action=delete_item) | 200 | PASS |
| 36 | invoice.total_after_delete | GET | /portal/api/admin/invoices/:id | 200 | PASS - subtotal=2000, total=2000 |
| 37 | invoice.send | PUT | /portal/api/admin/invoices/:id (status=sent, client_visible=true) | 200 | PASS |

### Payments with Invoice Status Transitions

| # | Test | Method | Endpoint | Status | Result |
|---|------|--------|----------|--------|--------|
| 38 | payment.record_partial | POST | /portal/api/admin/payments/record ($500 of $2000) | 201 | PASS |
| 39 | payment.status_partial | GET | /portal/api/admin/invoices/:id | 200 | PASS - status=partial, paid=500 |
| 40 | payment.record_full | POST | /portal/api/admin/payments/record ($1500) | 201 | PASS |
| 41 | payment.status_paid | GET | /portal/api/admin/invoices/:id | 200 | PASS - status=paid, paid=2000 |

### Approvals (Admin Create + Client Respond)

| # | Test | Method | Endpoint | Status | Result |
|---|------|--------|----------|--------|--------|
| 42 | approval.create | POST | /portal/api/admin/approvals/ | 201 | PASS |
| 43 | approval.list_pending | GET | /portal/api/admin/approvals/?pending=true | 200 | PASS |
| 44 | approval.client_approve | POST | /portal/api/client/approvals (as client user) | 200 | PASS |
| 45 | approval.verify_approved | GET | /portal/api/admin/approvals/:id | 200 | PASS - status=approved, note="Looks great!" |
| 46 | approval.create_2 | POST | /portal/api/admin/approvals/ | 201 | PASS |
| 47 | approval.client_reject | POST | /portal/api/client/approvals (as client user) | 200 | PASS |
| 48 | approval.verify_rejected | GET | /portal/api/admin/approvals/:id | 200 | PASS - status=rejected |

### Change Orders

| # | Test | Method | Endpoint | Status | Result |
|---|------|--------|----------|--------|--------|
| 49 | change_order.create | POST | /portal/api/admin/change-orders/ ($1500, +7 days) | 201 | PASS |
| 50 | change_order.list | GET | /portal/api/admin/change-orders/?contract_id=... | 200 | PASS |
| 51 | change_order.approve | PUT | /portal/api/admin/change-orders/:id (action=approve) | 200 | PASS |
| 52 | change_order.verify_approved | GET | /portal/api/admin/change-orders/:id | 200 | PASS - status=approved, approved_at set |

### Notifications

| # | Test | Method | Endpoint | Status | Result |
|---|------|--------|----------|--------|--------|
| 53 | notification.list | GET | /portal/api/notifications/ (as client) | 200 | PASS - 3 notifications |
| 54 | notification.unread_count | GET | /portal/api/notifications/?count=true | 200 | PASS - unread=3 |
| 55 | notification.mark_read | POST | /portal/api/notifications/ (id=...) | 200 | PASS |
| 56 | notification.unread_after_mark | GET | /portal/api/notifications/?count=true | 200 | PASS - unread=2 |
| 57 | notification.mark_all_read | POST | /portal/api/notifications/ (all=true) | 200 | PASS |
| 58 | notification.unread_zero | GET | /portal/api/notifications/?count=true | 200 | PASS - unread=0 |

### Client-Visible Filtering (Data Leak Tests)

| # | Test | Method | What was checked | Result |
|---|------|--------|------------------|--------|
| 59 | client.projects_accessible | GET /portal/api/client/projects | Client sees 1 project (client_visible=1) | PASS |
| 60 | client.projects_no_internal_fields | - | Response keys: id, title, description, status, milestones. No sort_order, estimated_hours, actual_hours | PASS |
| 61 | client.milestone_has_update_text | - | Keys: id, title, description, status, due_date, completed_at, client_update_text, tasks | PASS |
| 62 | client.task_no_hours | - | Task keys: id, title, status, client_update_text. No estimated_hours, actual_hours | PASS |
| 63 | client.task_no_description | - | No internal description field leaked | PASS |
| 64 | client.task_no_internal_fields | - | No assigned_to, priority, sort_order | PASS |
| 65 | client.no_invisible_tasks | - | "Test Task Epsilon (internal)" with client_visible=0 is absent | PASS |
| 66 | client.invoices_accessible | GET /portal/api/client/invoices | Client sees 1 invoice (client_visible=1) | PASS |
| 67 | client.invoice_has_total | - | total and amount_paid present | PASS |
| 68 | client.invoice_no_admin_fields | - | Keys: id, invoice_number, status, issued_date, due_date, total, amount_paid, notes, items, payments. No created_by, contract_id | PASS |
| 69 | client.approvals_accessible | GET /portal/api/client/approvals | Returns 0 (all already responded to) | PASS |

## Bugs Found During Testing

None. All 69 tests passed on first run.

## Client Data Leak Audit

Every `/api/client/*` endpoint was verified to strip:
- `estimated_hours` / `actual_hours` (task-level)
- `assigned_to` / `priority` / `sort_order` (task-level)
- Internal `description` on tasks (only `client_update_text` exposed)
- Tasks with `client_visible=0` (completely absent from response)
- `created_by` / `contract_id` on invoices (admin-only context)
- No cost fields marked admin-only leaked through

## Notes

- Invoice auto-recalc verified through 3 states: after add (3000), after price update (3500), after item delete (2000)
- Payment status transitions verified: sent -> partial (after $500) -> paid (after $1500 more)
- Both approval paths tested: client approved one, client rejected another
- Milestone completed_at auto-set verified when status changed to "completed"
- Task completed_at auto-set verified when status changed to "done"
