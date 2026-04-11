# Phase 1 Final State

**Date:** 2026-04-11
**Canonical branch:** `dev2-phase1`
**Worktree:** `C:\Users\codya\projects\codyasmith-dev2`
**Database:** `file:./data/dev2.db` (local SQLite, isolated from remote Turso)
**Server port:** 4322

## Commit Stack (phase0-clean forward)

| Hash | Description |
|------|-------------|
| `2f7ecda` | Phase 0: Portal foundation stabilization |
| `229fd61` | Fix logout not deleting server-side session |
| `f521b88` | Fix activity-log wording for user creation |
| `341ed41` | dev2: Add local file database and storage prefix support |
| `e9fa066` | Phase 1: Schema migrations, helpers, and API routes |
| `01b8444` | Add Phase 1 integration test plan and runner |
| `5bc7c8b` | Helper audit fixes, CSRF hardening, body size limit, negative tests |
| `479673a` | Add runtime column allowlists to dynamic UPDATE builders |

Note: `phase0-clean` also has `4ced90e` (middleware backport) which is not on `dev2-phase1` because `dev2-phase1` already has the same changes in `5bc7c8b`.

## New Tables (Migrations 006-009)

| Table | Columns | Migration |
|-------|---------|-----------|
| contracts | 13 (id, client_id, title, description, status, type, total_value, start_date, end_date, signed_at, created_by, created_at, updated_at) | 006 |
| projects | 10 (id, contract_id, client_id, title, description, status, sort_order, client_visible, created_at, updated_at) | 006 |
| milestones | 12 (id, project_id, title, description, status, due_date, completed_at, sort_order, client_visible, client_update_text, created_at, updated_at) | 006 |
| tasks | 16 (id, milestone_id, title, description, status, priority, assigned_to, estimated_hours, actual_hours, due_date, completed_at, sort_order, client_visible, client_update_text, created_at, updated_at) | 006 |
| task_artifacts | 7 (id, task_id, file_id, label, artifact_type, url, client_visible, created_at) | 006 |
| invoices | 17 (id, contract_id, client_id, milestone_id, invoice_number, status, issued_date, due_date, subtotal, tax, total, amount_paid, notes, client_visible, created_by, created_at, updated_at) | 007 |
| invoice_items | 7 (id, invoice_id, description, quantity, unit_price, amount, sort_order, created_at) | 007 |
| payments | 8 (id, invoice_id, amount, payment_method, reference, paid_at, recorded_by, notes, created_at) | 007 |
| approvals | 13 (id, contract_id, milestone_id, title, description, status, requested_by, responded_by, requested_at, responded_at, response_note, created_at, updated_at) | 008 |
| change_orders | 12 (id, contract_id, title, description, status, cost_impact, time_impact_days, requested_by, approved_by, approved_at, created_at, updated_at) | 008 |
| notifications | 10 (id, user_id, type, title, body, entity_type, entity_id, read, read_at, created_at) | 009 |

## New Endpoints

### Admin CRUD (`/portal/api/admin/`)

| Entity | GET list | POST create | GET :id | PUT :id | DELETE :id |
|--------|----------|-------------|---------|---------|------------|
| contracts | `?client_id=` or `?status=` or all | yes | yes | yes | yes (cascades) |
| projects | `?contract_id=` or `?client_id=` | yes | yes | yes | yes (cascades) |
| milestones | `?project_id=` | yes | yes | yes (auto completed_at) | yes (cascades) |
| tasks | `?milestone_id=` or `?assigned_to=` | yes | yes | yes (auto completed_at) | yes (cascades) |
| invoices | `?client_id=` or `?contract_id=` | yes (auto-number) | yes (includes items) | yes (also add/update/delete items) | yes (cascades items+payments) |
| payments | -- | POST `/record` | -- | -- | -- |
| approvals | `?pending=true` or `?contract_id=` | yes | yes | yes (respond, 409 if resolved) | -- |
| change-orders | `?contract_id=` | yes | yes | yes (approve action, 409 if already approved) | -- |

### Client Read-Only (`/portal/api/client/`)

| Endpoint | Method | What it returns |
|----------|--------|-----------------|
| `/projects` | GET | Visible projects with milestones + tasks, stripped of hours/costs/internal fields |
| `/approvals` | GET, POST | Pending approvals for response; POST to approve/reject (409 if resolved) |
| `/invoices` | GET | Visible invoices with items + payment history, stripped of admin context |

### Notifications (`/portal/api/notifications/`)

| Method | What it does |
|--------|--------------|
| GET | List notifications (or `?count=true` for unread count) |
| POST | Mark as read (`{ id }`) or mark all read (`{ all: true }`) |

## Helper Modules

| File | Entities | Key features |
|------|----------|--------------|
| `src/lib/contracts.ts` | contracts, projects, milestones, tasks, artifacts | Runtime column allowlists, cascade deletes, client-safe SELECT queries |
| `src/lib/invoices.ts` | invoices, items, payments, approvals, change orders | Auto-recalculate totals, payment status transitions, idempotency guards, runtime column allowlists |
| `src/lib/notifications.ts` | notifications | User-scoped queries, bulk mark-read |

## Test Results

| Suite | Tests | Pass | Fail |
|-------|-------|------|------|
| `tests/run-phase1-tests.mjs` (happy-path) | 69 | 69 | 0 |
| `tests/run-phase1-negative-tests.mjs` (negative/security) | 113 | 113 | 0 |
| **Total** | **182** | **182** | **0** |

### Negative test coverage includes:
- 34 unauthenticated request tests (all endpoints, all methods)
- 34 client-role on admin endpoint tests
- 5 CSRF missing/invalid tests (POST, PUT, DELETE)
- 4 cross-tenant isolation tests (Client B vs Client A)
- 4 idempotency guards (double-respond approval, double-approve change order)
- 3 invoice edge cases (deleted invoice items, overpayment)
- 7 cascade delete tests (contract tree, milestone tree)
- 11 SQL injection probes (5 payloads x 2 surfaces + integrity check)
- 10 malicious column name tests (6 direct allowlist + 4 HTTP route)
- 1 oversized payload test (2MB body, 413 rejection)

## Helper Audit Findings and Resolution

| Finding | File:Line | Resolution |
|---------|-----------|------------|
| No cascade on delete (contract, project, milestone, task) | contracts.ts:103-365 | Fixed: recursive cascade deletes |
| Client-facing SELECT * leaks admin fields | contracts.ts:157-413 | Fixed: explicit column lists |
| Client-facing invoice SELECT * leaks admin fields | invoices.ts:95-99 | Fixed: explicit column list |
| recalculateInvoiceTotals is non-atomic | invoices.ts:122-128 | Documented: acceptable for single-admin |
| respondToApproval no idempotency guard | invoices.ts:341-350 | Fixed: checks pending status, returns bool |
| approveChangeOrder no idempotency guard | invoices.ts:421-426 | Fixed: checks not-already-approved, returns bool |
| Overpayment not blocked | invoices.ts:230-260 | Documented: explicitly allowed (credit/prepayment) |
| CSRF only on POST, not PUT/DELETE/PATCH | middleware.ts:68-69 | Fixed: all mutating methods |
| No request body size limit | middleware.ts | Fixed: 1MB limit, 413 response |
| Dynamic UPDATE ${key} vulnerable at runtime | contracts.ts, invoices.ts | Fixed: per-table column allowlists with throw on invalid |

## Open Risks (Accepted)

| Risk | Reason accepted | Mitigation |
|------|----------------|------------|
| Shared R2 bucket with `dev2/` prefix isolation | Dev2 and production share the same R2 bucket, separated only by key prefix. A misconfigured STORAGE_KEY_PREFIX could read/write production files. | `.env.local` sets `STORAGE_KEY_PREFIX=dev2/` explicitly. Production uses no prefix. Never run dev2 against production DB. |
| recalculateInvoiceTotals non-atomic | Three separate queries (read items, read invoice, write totals). Concurrent item writes could produce stale totals. | Single-admin portal. Only one user creates invoices. If multi-admin is added, wrap in transaction. |
| Silent overpayment on invoices | recordPayment accepts any amount, even exceeding invoice total. Status becomes "paid" at totalPaid >= total. | Documented as intentional. Admin may record credits or prepayments. UI should display a warning. |
| phase0-clean middleware backport not on dev2-phase1 | The `4ced90e` commit on phase0-clean has the same middleware changes as `5bc7c8b` on dev2-phase1, but they are separate commits. | Both branches have identical middleware code. When merging to master, either path carries the fix. |
| Remote Turso Phase 0 re-test limited to unauthenticated | Admin credentials for remote Turso are unknown. Phase 0 re-test covered unauthenticated paths (6/6 pass) and build verification. | Authenticated middleware behavior is identical code to what passed 182/182 on dev2. |

## Not Yet Built

Per the original Phase 1/Phase 2 plan, the following remain:

1. **Admin UI pages** -- Contract management, project/milestone/task management, invoice generation/editing, payment recording, approval/change order workflows
2. **Client UI pages** -- Project status view, approval response view, invoice view, dashboard redesign
3. **Event triggers** -- Automatic notifications on status changes (milestone completed, invoice sent, approval requested, etc.)
4. **Email notifications via Brevo** -- Send email when notifications are created (approval requests, invoice ready, milestone completed)
5. **Task artifact management UI** -- Upload/attach files to tasks, client-visible artifact display

## Test Users in dev2.db

| Email | Role | Client | Password |
|-------|------|--------|----------|
| admin@dev2.test | admin | (none) | testpass123 |
| testuser@dev2.test | client | DEV2 TEST Client (Client A) | testpass123 |
| clientb@dev2.test | client | DEV2 TEST Client B (Client B) | testpass123 |
