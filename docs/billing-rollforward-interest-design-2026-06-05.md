# Billing Part B: overdue roll-forward + late interest (design)

Date: 2026-06-05. Decided by Cody across the 2026-06-04/05 session. Companion:
docs/session-log-2026-06-04-portal-billing-and-contracts.md (s5c),
docs/utah-contract-law-research-2026-06-04.md (s2, interest legality).

## Goal
When a PORTAL-contract client's overdue invoice goes unpaid, consolidate it onto
their next invoice instead of leaving multiple invoices outstanding ("keeps
things from being spread out"). The next invoice carries the unpaid balance plus
accrued late interest as ITEMIZED lines; the old invoice is closed as
carried-forward. One current bill always shows everything owed.

## Scope / gates
- PORTAL-contract clients only (executed v6+ agreement). Non-standard clients
  (default-message tier) and manual-billing clients NEVER roll forward and are
  NEVER charged interest. (Same gate the section 5.8 escalation already uses.)
- FULLY-UNPAID overdue invoices only (amount_paid = 0). This matches the
  auto-dunning eligibility (isAutoOverdueEmailEligible excludes partials); a
  partially-paid invoice is a manual situation and is left alone.
- One contract per client (confirmed 2026-06-05), so roll-forward is effectively
  per client: the contract's next recurring invoice absorbs its overdue invoices.

## Interest
- 1.5% per month (18%/yr), SIMPLE, on the principal, accruing from the invoice
  date. Enforceable B2B (no Utah commercial usury cap, Utah Code 15-1-1(1)).
- Daily rate = 0.015 * 12 / 365. accruedInterest = principalBase * dailyRate *
  max(0, whole days from issued_date to as-of).
- principalBase = sum of the invoice's line items EXCEPT late-interest lines.
  So interest never accrues on previously-charged interest (no compounding).
- WHY this stays "simple" across multiple roll-forwards: each roll-forward
  freezes the interest accrued so far as a (non-bearing) line and starts the new
  invoice's clock at its own issue date. Because simple interest is LINEAR in
  time, the sum of the per-segment charges equals simple interest on the
  principal over the full elapsed time. No interest-on-interest.

## Line items added to the next invoice (itemized -- hard rule)
For each carried overdue invoice X, on the new invoice:
- category 'past_due':      "Past due: {X.invoice_number}" = principalBase(X)
- category 'late_interest': "Late interest: {X.invoice_number} (1.5%/mo from
  {X.issued_date})" = accruedInterest(principalBase(X), X.issued_date, today)
- category 'late_interest': "Prior late interest: {X.invoice_number}" =
  sum of X's own late-interest lines (only present on a 2nd+ roll-forward;
  carried as non-bearing so it is not re-interested)
These are ON TOP of the new period's normal itemized lines (recurring + pass-
through + reimbursements), exactly like pass-through already adds lines. The
reconcile guard only checks the recurring lines vs contract.recurring_amount, so
the additions are safe.

## Closing the old invoice
- New invoice status value 'carried_forward' (terminal): not open, not overdue,
  not dunned, not counted in the account balance, not re-rolled. The client sees
  it labeled "Carried forward" with a note referencing the new invoice number.
- AS BUILT: traceability is a NOTE on the old invoice ("Carried forward to
  INV-YYYY on DATE"), NOT a carried_to_invoice_id column (the planned column was
  dropped to avoid a migration + buildSafeUpdate-whitelist change). Idempotency
  needs no column: (1) the terminal carried_forward status removes the old
  invoice from the roll-forward SELECT, so it is never carried twice; (2)
  invoiceExistsForPeriod dedups the new recurring invoice per period.
- The roll-forward SELECT also excludes reminders_paused invoices (a deliberate
  collection pause is honored) and fully-paid/partial invoices (amount_paid = 0
  only), and recordPayment/deletePayment treat carried_forward as a sticky
  terminal status so a stray payment cannot resurrect a carried invoice.
- The roll-forward runs inside generateInvoiceForContract AFTER the new invoice
  is built, so it happens once per period (invoiceExistsForPeriod dedups the
  period; carried_forward excludes already-rolled invoices).

## Presentation
- splitSubtotals gains a `past_due` bucket (past_due + late_interest categories).
- Admin invoice view, client invoice view, and the PDF gain a "Past due" section
  (mirrors the existing Reimbursements section) so carried debt + interest are
  visibly separate from current-period services. Itemization preserved.

## Fallbacks / edges
- No next invoice coming (contract ended / not monthly): nothing to roll into;
  the overdue invoice stays open and keeps getting the section 5.8 final notice.
- carried_forward invoices are excluded from getClientOpenBalance, getOverdue*,
  OVERDUE_MARK_WHERE, getOverdueNoticeCandidates, getDueInvoices (all whitelist
  sent/partial/overdue, so carried_forward drops out naturally) and from
  re-roll (the roll query excludes carried_forward).

## Tests (TDD, pure first)
- accruedInterest: zero before/at issue, simple linear accrual, rounds days down,
  null/garbage date -> 0, principalBase excludes late-interest.
- computeRollForwardLines(invoice, items, now): returns the past_due +
  late_interest line set with correct amounts; prior-interest carried non-bearing;
  multi-roll segment sum equals simple-from-original.
- Then a generator integration check (local dev2) and a dual audit before ship.
