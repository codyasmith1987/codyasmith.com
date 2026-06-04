# Invoice System Overhaul: Canonical Design + Implementation Spec

codyasmith.com portal. Repo root: `C:\Users\codya\projects-clean\codyasmith.com`. Status: discovery complete (read-only). This document is the build spec for the full effort.

Source: read-only discovery workflow (2026-06-03), five parallel code maps verified against live code: `src/lib/invoices.ts`, `src/lib/pdf.ts`, `src/lib/billing.ts`, `src/lib/contract-emails.ts`, `src/lib/migrations/019-client-metadata.ts`, `src/pages/portal/api/admin/invoices/[id].ts`, `src/lib/triggers.ts`. Quality bar = the hand-made ZKH invoices (INV-002 April .docx, INV-003 May .pdf).

---

## 1. GAP ANALYSIS

The portal has a real billing spine (invoices, invoice_items, payments, recurring auto-generation, daily cron, on-the-fly PDF, client-visible list, activity logging, due reminders). It is far below the gold-standard hand invoice and is missing all four feature asks.

### 1a. Data model cannot represent the gold layout

- **No line-item NAME vs SUB-DESCRIPTION split.** `invoice_items` has a single flat `description` (`invoices.ts:231-240`, `addInvoiceItem` at `:242-258`). Gold needs a bold NAME ("Web Management - ZipKit Homes") and a lighter sub-line ("zipkithomes.com service"). MISSING.
- **No FREQUENCY tag** (MONTHLY/ANNUAL/ONE-TIME). No column; not in the `invoice_items` allowlist (`invoices.ts:9`). MISSING.
- **No CATEGORY** (Services vs Reimbursements). `recalculateInvoiceTotals` (`invoices.ts:213-219`) sums one flat subtotal; gold renders two tables, each with its own subtotal, plus a TOTAL DUE = sum of both. MISSING.
- **No invoice TITLE/SUBJECT.** Only `notes` free text. MISSING.
- **No structured BILL-TO.** `invoices` carries only `client_id`. The bill-to data EXISTS in `client_metadata` (mig 019: `primary_contact_name/email/phone`, `principal_address`, `notice_address`, `legal_entity_name`) but is never read by the invoice path. The PDF prints only `client?.name` (`pdf.ts:43-44`). PARTIAL (data exists, unwired) + no per-invoice snapshot.
- **No REIMBURSEMENT data source anywhere.** No expenses/license ledger in any of the 61 migrations. Only pass-through concept is a hardcoded `$15/site` MONTHLY clause in `products/web-management.ts:1150-1154`. MISSING.
- **No terms label.** Only `due_date` and `contracts.payment_terms_days` (default 30). No "Due: Upon Receipt." MISSING.
- **Letterhead/footer not data-driven.** `pdf.ts:32-33` hardcodes "Cody A Smith LLC" + email only. No street, phone, footer, payable-to line. PARTIAL/MISSING.

### 1b. The four feature asks

1. **DUPLICATE** — no `clone`/`duplicate` helper, no API action, no button. The #1 ask, biggest monthly-pain gap. MISSING.
2. **EDIT THE NAME = ALL editable.** `invoice_number` set at creation, absent from allowlist (`invoices.ts:8`) so not editable; `buildSafeUpdate` throws on it. Line items have no name field. No invoice title. Bill-to name from `clients.name`, not per-invoice editable. MISSING/PARTIAL.
3. **SEND button.** Manual draft->sent fires `onInvoiceSent`, which sends ONLY an in-app notification, no email/PDF (`triggers.ts:264-279`). Only PDF-email path is at-signing via `sendAtSigningInvoiceEmail` (`contract-emails.ts:172-201`, attachments via `sendBrevo` `:21-56`). Greenfield but clean copy-from path. MISSING.
4. **AUTOMATIC OVERDUE NOTICES.** `markOverdueInvoices` (`billing.ts:343-349`) only flips DB status; no email. **LIVE BUG:** flipping to `overdue` kills reminders because `getDueInvoices` filters `status='sent' AND due_date >= today` (`billing.ts:330-337`), so overdue invoices get zero client contact. Daily cron is real + idempotent with `?dry=1`. No overdue-notice function exists. MISSING + bug.

### 1c. Table stakes

- No inline line-item edit in the editor UI (lib/API support `update_item`, editor renders only add + delete). PARTIAL.
- No reorder UI (`sort_order` honored on read, no control). PARTIAL.
- Tax field exists in schema/PDF/API but editor never sends it, no input. PARTIAL.
- PDF generated every request, never stored to DO Spaces. No stable sent artifact. MISSING.
- Invoice numbering hardcoded `INV-YYYY-NNNN`; gold wants short `INV-002`. MISSING.
- No discount line, currency hardcoded `$`, no online pay. (Out of scope; noted.)

---

## 2. DATA-MODEL CHANGES

All additions are **additive and nullable / defaulted** so every existing prod invoice (ZKH live) keeps working unchanged. Existing flat invoices render in the new PDF by treating NULL `category` as `services`, NULL `name` by falling back to `description`, NULL `frequency` as an absent tag.

### Migration 062 — invoice line-item structure
`src/lib/migrations/062-invoice-line-item-structure.ts`
```
ALTER TABLE invoice_items ADD COLUMN name TEXT;            -- bold service name; NULL => use description
ALTER TABLE invoice_items ADD COLUMN sub_description TEXT; -- lighter line under the name
ALTER TABLE invoice_items ADD COLUMN frequency TEXT;       -- 'monthly'|'annual'|'one_time'|NULL
ALTER TABLE invoice_items ADD COLUMN category TEXT NOT NULL DEFAULT 'services'; -- 'services'|'reimbursements'
```
Keep `description` as legacy/fallback (no destructive rename). New rows write `name` + `sub_description`. `frequency`/`category` validated at the app layer.

### Migration 063 — invoice header fields
`src/lib/migrations/063-invoice-header-fields.ts`
```
ALTER TABLE invoices ADD COLUMN title TEXT;              -- invoice subject/title, optional
ALTER TABLE invoices ADD COLUMN terms_label TEXT;        -- 'Upon Receipt' | 'Net 30' | free text; NULL => derive from due_date
ALTER TABLE invoices ADD COLUMN bill_to_snapshot TEXT;   -- JSON {company,contact,address,email,phone} frozen at send time
ALTER TABLE invoices ADD COLUMN reminders_paused INTEGER NOT NULL DEFAULT 0;
```
`bill_to_snapshot` NULL on draft (renders live from `client_metadata`); populated at SEND so a sent invoice never silently changes if the client record is edited later (snapshot vs live boundary for a financial document).

`invoice_number` editability: just add it to `UPDATABLE_COLUMNS.invoices` (`invoices.ts:8`) + a uniqueness guard. No migration needed.

### Migration 064 — recurring expense templates (genuinely new table)
**DECISION (Cody 2026-06-03): recurring-expense TEMPLATE model, not a one-off ledger.** Define each plugin/tool once with a cadence; it auto-recurs onto invoices (cadence-aware) until removed. Each is editable/removable per invoice (override).

`src/lib/migrations/064-client-expenses.ts`
```
CREATE TABLE IF NOT EXISTS client_expenses (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                 -- "Kadence Ultimate (25 sites)"
  amount REAL NOT NULL,
  frequency TEXT NOT NULL,            -- 'monthly'|'annual'|'one_time'
  active INTEGER NOT NULL DEFAULT 1,  -- template on/off (soft remove)
  last_billed_on TEXT,                -- date last added to an invoice (drives annual/one_time cadence)
  notes TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_client_expenses_active ON client_expenses(client_id, active);
```
Source for the Reimbursements section. Cadence-aware auto-include when an invoice is created/duplicated: `monthly` active -> every invoice; `annual` active -> include if `last_billed_on` is NULL or ~11+ months old; `one_time` active -> include if `last_billed_on` is NULL. Adding an expense as a reimbursement line stamps `last_billed_on` (and a `one_time` may auto-deactivate). Cody can toggle `active`, edit `amount`/`name`, or remove any reimbursement line on a given invoice (override).

### Migration 065 — seller profile config (single-row business constants)
`src/lib/migrations/065-seller-profile.ts`
```
CREATE TABLE IF NOT EXISTS seller_profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  display_name TEXT, street TEXT, city_state_zip TEXT,
  email TEXT, phone TEXT, legal_footer TEXT, payable_to TEXT
);
-- seed: 'Cody Smith','604 Morningside Cir','Cedar City, UT 84720',
--       'cody@codyasmith.com','435-868-7133',
--       'Operating as Cody A Smith LLC (Utah)','Cody A Smith LLC'
```
One-row table keeps the renderer data-driven and editable without a deploy.

**Backward-compat:** 062/063 are pure ALTER ADD (nullable/defaulted) — zero impact on existing rows. 064/065 new tables. No existing invoice's grand total changes.

---

## 3. AUTOMATE-WITH-OVERRIDE MAP

| Invoice field | Auto-populate source | Override |
|---|---|---|
| Invoice number | `generateInvoiceNumber()` (`invoices.ts:74-90`) | Editable text once in allowlist |
| Invoice title/subject | Default `"Invoice for {client.name}"` (em-dash-free) | Editable text |
| Bill-to company | `clients.name` | Editable; frozen at send |
| Bill-to contact | `client_metadata.primary_contact_name` (mig 019:23) | Editable |
| Bill-to address | `client_metadata.notice_address` ?? `principal_address` | Editable |
| Bill-to email | `client_metadata.primary_contact_email` ?? first `users.email` | Editable |
| Bill-to phone | `client_metadata.primary_contact_phone` | Editable |
| Billing period | `getCurrentBillingPeriod` from `contracts.billing_day` / `billing_anchor_day` | Editable dates |
| Due date | `now + contracts.payment_terms_days` | Editable date |
| Terms label | `payment_terms_days===0` -> "Upon Receipt", else "Net {N}" | Editable `terms_label` |
| Service lines + amounts | Parse `client_agreements.schedule_a` JSON (WM per-site, MC retainer, pass_through); per-site $ from `client_sites.monthly_override`. Fallback: single `contracts.recurring_amount` line | Add/edit/delete/reorder |
| Line-item name | Composed from schedule_a | Editable |
| Line-item sub-description | Composed (e.g. `"{domain} service"`) | Editable |
| Line-item frequency | `monthly` default | Editable dropdown |
| Line-item category | `services` contract-derived; `reimbursements` ledger-derived | Editable dropdown |
| Plugin management fee | `pass_through_items[].monthly_cost` x managed site count | Editable |
| **Reimbursement rows** | **[NEW]** `client_expenses` active recurring templates, cadence-aware (monthly every invoice; annual ~yearly; one_time once) | Toggle active, edit amount/name, add/edit/delete per invoice |
| Overage/change-order charges | `getPendingChargesForContract` (`billing.ts:116-121`) | Editable |
| Notes block | Generated em-dash-free template from hours/rate + signed date + payable-to | Full free-text override |
| Letterhead | **[NEW]** `seller_profile` | Editable |
| Footer/payable-to | **[NEW]** `seller_profile.legal_footer` / `.payable_to` | Editable |

---

## 4. PDF + EDITOR REDESIGN

### 4a. PDF (`src/lib/pdf.ts` rewrite) — gold parity
1. Letterhead from `seller_profile` (replaces hardcoded `pdf.ts:32-33`).
2. INVOICE block: `Invoice #`, `Date`, `Due: {terms_label || due_date}`, `Period` (long-form, hyphen separator).
3. BILL TO: contact / company / address / email from snapshot (or live metadata on draft).
4. SERVICES section: bold `name` + uppercase `frequency` tag + lighter `sub_description` + right-aligned amount; "Services Subtotal".
5. REIMBURSEMENTS section (always rendered, even at $0.00): `name` + `frequency` + amount; "Reimbursements Subtotal".
6. TOTAL DUE bar = services + reimbursements subtotals. Use portal amber `#f59e0b`, not orange.
7. NOTES (multi-paragraph, split on blank lines).
8. FOOTER: `{display_name} | {email} | {phone} | Thank you for your business.` + `legal_footer`.
Extend the existing PDFKit primitives; don't rewrite the harness.

### 4b. Auto-default copy (no em/en dash)
Default NOTES template (override-able), service names ("Web Management - {label}", hyphen with spaces is allowed), and sub-descriptions are generated em-dash-free; a regex test asserts no `–`/`—` in generated defaults.

### 4c. Admin editor (`src/pages/portal/admin/invoices/[id].astro`)
- Header fields: editable `invoice_number`, `title`, `terms_label` (select), `billing_period_start/end`, plus existing status/issued/due/client_visible/notes.
- Line items: `name`, `sub_description`, `frequency` (select), `category` (select), qty, unit_price; **inline edit** (wire the existing `update_item` action) + **reorder** (up/down -> sort_order).
- Two grouped tables mirroring the PDF, each with subtotal; TOTAL DUE row.
- Tax input wired to the Save payload.
- Bill-to preview/override panel.
- Buttons: Duplicate, Send, Download PDF (existing), Delete (existing), Pause reminders toggle.

---

## 5. SEND + OVERDUE PIPELINE

### 5a. Send invoice with PDF
REUSE: `generateInvoicePdf` -> Buffer -> base64 (pattern `sign.ts:373-374`); `sendBrevo({to,subject,html,attachments})` (the ONLY attachment-capable transport, `contract-emails.ts:21-56`; generic `email.ts sendEmail` has no attachment param and must NOT be used); signer-loop + attach pattern from `sendAtSigningInvoiceEmail`.
BUILD: `src/lib/invoice-emails.ts: sendInvoiceEmail({invoiceId, freezeBillTo:true})` -> generate PDF, freeze `bill_to_snapshot`, set status='sent', client_visible=1, issued_date if unset, attach PDF, log activity, return `{ok, sentTo[]}`. Recipients from `getUsersByClientId` + `client_metadata.primary_contact_email`. API `POST /portal/api/admin/invoices/[id]/send`. Send button. Existing `onInvoiceSent` stays as in-app notification; new path also calls it.

### 5b. Overdue auto-notice on the cron (+ fix the bug)
BUILD `sendOverdueNotices()` in `billing.ts`, mirroring `sendDueReminders` (`:351-403`) but:
- Query `status='overdue' AND amount_paid < total` (not the `due_date >= today` clause that excludes past-due).
- Cadence via `last_reminder_sent`: re-notice only if NULL OR older than N days (recommend 7). Reminders + overdue notices no longer collide (status-disjoint).
- Em-dash-free, value-first copy; links to `/portal/invoices`; attach PDF.
- On success set `last_reminder_sent = now`.
- Both `getDueInvoices` and `sendOverdueNotices` skip `reminders_paused=1`.
Wire into `/api/cron/daily` AFTER `markOverdueInvoices`. Extend `previewDailyCron` with `would_send_overdue`.

### 5c. Statuses
`draft -> sent -> (partial) -> paid`; `sent -> overdue` via cron; `overdue -> paid/partial` via `recordPayment`. `cancelled` manual. No new statuses.

### 5d. EMAIL side-effects — confirm before live, gate to Cody Test in testing
1. SEND button — direct client email + PDF.
2. `sendOverdueNotices()` on cron — automated client email; first prod run observed via `?dry=1` then one Cody-Test invoice end-to-end.
3. Any change to `sendDueReminders` cadence.
Testing protocol: Cody Test client only; verify recipient list resolves to the test mailbox; NEVER POST against a ZKH-linked contract; no prod manual DB writes; ship via PR to main.

---

## 6. SLICED IMPLEMENTATION PLAN (TDD; each its own branch + PR)

- **Slice 0 — Schema + migrations** (062-065, seeded 065). Test: migrate up on fresh DB, assert new cols/tables, existing-shape invoice still selects with NULL new cols + category default 'services'. Cody Test: migrations on dev2, existing invoice still loads.
- **Slice 1 — Helpers + DUPLICATE** (#1 ask). Extend `InvoiceItem`/`addInvoiceItem`/`updateInvoiceItem` for new fields; category-aware `getInvoiceSubtotals`; `duplicateInvoice(sourceId, createdBy)`; `src/lib/client-expenses.ts` (addExpense/getUnbilledExpenses/markExpensesBilled). API `POST .../[id]/duplicate`. Test: duplicate copies all items + new number + draft + not visible; subtotals split; legacy NULL-category counts as services. Cody Test: duplicate a Cody Test invoice.
- **Slice 2 — Editable fields + line-item naming.** `invoice_number` in allowlist + uniqueness pre-check; `title`/`terms_label`/`reminders_paused`/`bill_to_snapshot` in allowlist; API accepts new header + item fields. Test: rename unique ok / dup throws; item fields round-trip. Cody Test: rename, set title, edit line name.
- **Slice 3 — PDF parity.** Rewrite `pdf.ts` per 4a; `src/lib/seller-profile.ts` reader; `src/lib/invoice-defaults.ts` (buildDefaultNotes, composeServiceLines). Test: section grouping, subtotal math, Reimbursements at $0.00 present, no en/em dash in defaults. Cody Test: download PDF, eyeball vs gold.
- **Slice 4 — Editor parity.** Rewrite `[id].astro` per 4c; real "new invoice" flow auto-populating services from schedule_a + unbilled expenses. Test: auto-populate composer; inline edit persists; reorder. Cody Test: create fresh invoice, confirm auto-fill, edit, reorder.
- **Slice 5 — SEND** (EMAIL; Cody Test gated). `src/lib/invoice-emails.ts`; API `POST .../[id]/send`; Send button. Test (mock sendBrevo): PDF attached, snapshot frozen, status->sent, visible->1, recipients resolved, logged; refuses $0/itemless. Cody Test: send to test mailbox only; confirm with Cody before any non-test send.
- **Slice 6 — OVERDUE automation** (EMAIL; cron). `sendOverdueNotices()`; honor `reminders_paused`; `previewDailyCron.would_send_overdue`; wire into cron. Test: overdue invoice picked up (bug fix); N-day cadence; paused skips; `?dry=1` sends nothing. Cody Test: backdate due_date, `?dry=1` preview, one real run to test mailbox, pause suppresses. Confirm cadence first.
- **Slice 7 — Client self-serve + stored PDF.** Send path uploads PDF to DO Spaces (`storage.ts`), stores key; client PDF route serves stored copy if present. Test: send stores key; client route returns stored bytes; access gate unchanged. Cody Test: send, confirm stored PDF + client view/download.

Independence: 3 and 4 both depend on 0-2, not each other. 5/6/7 depend on 0-2 + 3; 6 (cron) does not depend on 5 (button); 7 layers on 5.

---

## 7. DECISIONS (locked 2026-06-03)

1. **Invoice numbering scheme.** LOCKED: editable field, keep auto long-form (`INV-2026-NNNN` generated, but editable so Cody can type `INV-004`). Zero collision risk; existing prod invoices unchanged.
2. **Bill-to snapshot vs live.** LOCKED: both — live from `client_metadata` while draft, frozen to `bill_to_snapshot` at send.
3. **Reimbursements.** LOCKED: recurring-expense TEMPLATE (see mig 064) with cadence-aware auto-include, editable/removable per invoice. (NOT the one-off ledger.)
4. **Overdue cadence.** LOCKED: auto-reminder every 7 days while overdue + unpaid, per-invoice pause toggle.
5. **Store + attach PDF.** LOCKED: attach always; store immutable copy in Slice 7.
6. **Seller profile.** LOCKED: seeded `seller_profile` table; letterhead seeded from the hand invoices (Cody Smith / 604 Morningside Cir / Cedar City, UT 84720 / cody@codyasmith.com / 435-868-7133 / "Operating as Cody A Smith LLC (Utah)"). Editable later without deploy. (Flagged to Cody that the street address prints client-facing, as it does today.)
7. **"Upon Receipt" derivation.** LOCKED: per-invoice editable `terms_label` (default derived from `payment_terms_days`); leave the contract default alone until a global decision.
