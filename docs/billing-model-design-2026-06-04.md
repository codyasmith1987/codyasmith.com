# Billing model design brief (2026-06-04)

## DECISIONS LOCKED (Cody, 2026-06-04)
1. **Overdue model = C (read-only account statement).** Invoices stay separate + correctly paid;
   show one aggregate "you owe $X across N invoices" number. NOT the fuse-into-one-document (B).
2. **Consolidate WM+MC onto ONE itemized invoice per client.** Cody: "this is how i designed it and
   it should already be" — so the current 2-contracts -> 2-invoices output is a REGRESSION vs intent.
   One consolidated, itemized invoice per client is the target.
3. **Late fees = YES, enforce.** Charge the 5.8 interest (1.5%/month or Utah max) on past-due.
4. **Automation split:** all CLIENT COMMS / notices automated; notices go to the client AND to Cody
   (admin); any SHUTOFF / server suspension is ALWAYS a manual Cody action (never automated).
5. **GATING (keystone): the entire automated billing policy (auto-generate, itemized consolidated
   invoice, statement, escalation/dunning ladder, interest, suspension-eligibility) applies ONLY to
   clients with an ACTIVE PORTAL CONTRACT (a signed v6 agreement).** Legacy / paper-contract clients
   (e.g. ZipKit) are EXCLUDED from automated enforcement and stay manual until they sign the v6
   portal contract. Build it now, for future clients.
6. ZipKit (Sven) is on an OLD PAPER contract -> review it (below) + get Sven onto the v6 portal
   contract ASAP. Until then ZipKit is manual, outside the automation.
7. **NO PRORATION (Cody, 2026-06-04):** a client is responsible for the ENTIRE MONTH. No proration
   on cancellation / mid-cycle exit; a billing cycle that begins during the 30-day notice period is
   owed IN FULL. v6 17.3 is close; strengthen it to be airtight.
8. **STRENGTHEN v6 first:** review v6 for holes (informed by the overdue/proration/suspension/
   itemization issues just surfaced) -> roll fixes into a NEW template version (v7; templates are
   immutable+versioned, so new agreements pick v7). ZipKit signs the strengthened version.
9. **BUILD CONTRACTS VIA THE CONTRACT TOOL, NO ONE-OFFS (Cody, 2026-06-04):** ZipKit's re-paper, and
   all contracts, are built through the portal's proposal/agreement builder, never hand-crafted /
   manual one-off documents. The builder is the source of truth.

Status: DESIGN brief below; above decisions now LOCKED.
Original status line: DESIGN, decisions pending Cody. No code written yet. Grounded in the live engine.
Trigger: Cody set a hard rule (every invoice always itemized, never a single line) and raised
overdue carry-forward ("if a client is this far overdue, maybe the overdue amount needs to be
added to the next invoice. idk. we need to think about this"). Real case: ZipKit has INV-2026-0003
($1,360, ~1mo overdue) + INV-2026-0004 ($1,360, new cycle); Sven confuses easily.

## 1. Current reality
- Recurring invoice = ONE services line from the scalar `contract.recurring_amount`
  (`billing.ts` generateInvoiceForContract ~256-265), which `deriveBillingTerms`
  (`contract-handoff.ts:52-58`) builds as `round2(wmMonthly + mcMonthly)` — the per-site WM split
  and WM/MC split are summed away before any line exists. Plus a summed plugin line (grandfathered)
  + reimbursements + pending charges.
- The at-signing invoice IS already itemized (`contract-handoff.ts:153-157`) — so the model + PDF
  render multi-line fine; only the RECURRING path regressed.
- ZipKit = two agreements (WM, MC) = two contracts = two one-line invoices per cycle, not the
  consolidated 4-line $1,360 doc Cody hand-writes.
- Overdue is fully per-invoice: no parent_invoice_id, no ledger, no client-level total anywhere.
  Payment application is strictly per-invoice (`recordPayment` inserts against one invoice_id).

## 2. Always-itemized (recommended)
Derive recurring lines from the signed `schedule_a` at generation (NOT a new contract_line_items
table — that's a second source of truth that drifts):
- `schedule_a.web_management.sites[]` -> one line per site (ZKH $500, MVP $330)
- `schedule_a.marketing_consulting.monthly_retainer` -> MC line ($500)
- `schedule_a.pass_through_items[]` -> plugin line (ZipKit 2x$15; empty for new clients)
New pure helper `deriveRecurringLineItems(scheduleA)` next to deriveBillingTerms; swap the
single-line block in generateInvoiceForContract. Add explicit `sort_order` (addInvoiceItem never
sets it). Reconcile guard: derived lines must sum to contract.recurring_amount within a cent.
Build size: SMALL, generation-only, no migration, pdf.ts already renders grouped lines.
RISK / Phase 0 data check: confirm ZipKit's stored `schedule_a.web_management.sites[]` actually
contains BOTH ZKH and MVP. MVP was an email add-on, possibly never written into the signed JSON.
If missing, itemization under-bills.

## 3. Overdue handling — three models
Constraint: payment application is strictly per-invoice; no ledger exists.
- A (today): independent invoices, dun each separately. Accounting-perfect, but no single "you owe
  $X" number -> the Sven confusion.
- B (Cody's literal idea): add overdue balance as a "Past due" line on the next invoice. REJECT the
  naive form: the same $1,360 then lives on two docs ($4,080 receivables for $2,720 real debt); when
  Sven pays the new one, recordPayment can't mark the old one paid -> cron keeps dunning a paid debt.
  Only "works" if you also suppress the old card + pause its dunning + bolt on cross-invoice
  reconciliation (each corrupts something).
- C (recommended): read-only account/statement layer over immutable invoices. Per-client open
  balance = SUM(total - amount_paid) WHERE status IN (sent,partial,overdue), shown as one number
  with invoices itemized beneath. ZERO change to recordPayment/payments/cron/stored numbers — pure
  derive-don't-duplicate (like recalculateInvoiceTotals/splitSubtotals). No double-count possible.
The real question under it: do the two receivables APPEAR aggregated (C) or genuinely FUSE into one
collectible document (B)? Recommendation: C.

## 4. Client experience (end-state)
One concept: an account/statement layer; every touchpoint = a view of "where the account stands."
- At signing: itemized invoice (already best-built). Keep.
- Each cycle: ONE itemized invoice per client (WM-per-site + MC + plugin + reimbursements). Requires
  consolidating ZipKit's two contracts onto one invoice (per-client fork).
- Prior invoice open at new-cycle: ONE account statement showing both + the single total (not a
  merged invoice).
- Dunning: keep warm due+7-then-weekly, reference the account total.
- Receipt: state remaining ACCOUNT balance, not just that invoice's.
LATENT BUG (fix regardless): sendOverdueNotices/sendDueReminders iterate INVOICES not CLIENTS
(`billing.ts:573`,`:436`) -> a client with two overdue invoices gets two emails per run. That IS
the "two bills confusing Sven" problem, already live. Dedupe to one-email-per-client-per-run.
Per-client config (home: client_metadata): consolidate-vs-separate; dunning cadence-as-data;
hold-new-while-overdue; statement cadence. GLOBAL: warm voice, receipts always fire, invoice
immutability. SKIP: late fees (contradicts the warm voice; accounting/tax landmine).
Pitfalls: WM & MC have separate billing_day/anchor — must share an anchor to co-invoice;
invoices.astro is dark-themed against the portal's cream theme — match the rendered theme.

## 5. Decisions for Cody
1. Itemization naming (mirror hand-invoice wording, no dev jargon) + plugin as one summed line vs per-site.
2. Reconcile-guard mismatch: halt-and-alert (recommended; never a wrong invoice) vs fallback-to-single-line.
3. Overdue model: A vs B vs C (recommend C) — appear-aggregated vs fuse.
4. Consolidate WM+MC onto one invoice per client? (recommend yes, per-client setting.)
5. Late fees: confirm skip (recommended).

## 6. Phased build (once decided)
- Phase 0: data check — ZipKit schedule_a has both sites (no code).
- Phase 1: always-itemized recurring (SMALL, pure upside) — deriveRecurringLineItems + sort_order + guard.
- Phase 2: read-only statement summary on invoices.astro (one number; no schema/mutation).
- Phase 3: dunning dedupe (one email per client per run; lead with account total).
- Phase 4: per-client config (consolidate, hold-new-while-overdue, cadence-as-data) — needs #3,#4 locked.
Phases 1-3 independently shippable, each pure upside; only Phase 4 blocks on the philosophy calls.

## 7. Non-payment / suspension policy — ALREADY IN THE CONTRACT (standard-v6.md s5.8)
Cody's instinct ("at the 30-day mark we may have to get uncomfortable about the server") is
already the written policy. The portal does NOT implement or communicate it yet (dunning is just
warm due+7-then-weekly reminders). The gap is building the escalation ladder to MATCH the contract,
not inventing a policy.

standard-v6.md section 5.8 "Late payment and suspension":
- **7 days past invoice date:** unpaid balance accrues interest 1.5%/month (or Utah max, whichever
  less) + reasonable collection costs.
- **>7 days past due:** Practice MAY pause NON-CRITICAL work (strategy, advisories, new requests,
  change orders, MC deliverables, content, optimization) on written notice.
- **>30 days past due:** Practice MAY suspend CRITICAL CONTINUITY work (hosting, daily backups,
  security monitoring, uptime monitoring, contracted-cadence updates = the server) on TEN (10) days'
  ADDITIONAL written notice + cure period. So the server can lawfully go dark at ~day 40, with
  notice, not day 30.
- Suspension != termination; resumption needs past-due paid + any resumption fee in Schedule A.
- s17.2: non-payment uncured under 5.8 = material breach -> termination for cause.

DESIGN IMPLICATIONS:
- The dunning/escalation ladder + emails should map to 5.8: friendly (due / due+7), interest-begins
  notice (+7), non-critical-pause notice (+7), 30-day "service interruption" notice that starts the
  10-day cure clock, then suspension. Tone escalates; stays warm/plain until it can't.
- The earlier "skip late fees" suggestion CONFLICTS with 5.8 (the contract HAS 1.5%/mo interest).
  The contract gives the RIGHT; whether to enforce vs forbear is Cody's call, but the system should
  at least support what was signed.
- Per-client: suspension is a serious, live-site action (ZipKit's real business). Likely a
  Cody-confirmed manual step, not fully automated, with the NOTICES automated.
- ZipKit CAVEAT: ZipKit signed a PAPER contract 2026-03-09 (pre-portal). Its actual 5.8-equivalent
  terms must be read from the SIGNED PDF in OneDrive before any server action; do NOT assume it
  matches v6. ZipKit's INV-2026-0003 is ~30 days overdue NOW, so this is live.

ADDED DECISION for Cody (beyond #1-5): how much of 5.8 to AUTOMATE (notices yes; the actual
critical-suspension almost certainly a Cody-confirmed manual action) and whether to enforce the
1.5% interest.
