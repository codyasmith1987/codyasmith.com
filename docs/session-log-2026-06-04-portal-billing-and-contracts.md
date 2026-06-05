# Session log: portal invoicing, billing model, contract hardening (2026-06-04)

Consolidated record of work + every decision. Companion docs: billing-model-design-2026-06-04.md,
contract-v6-hardening-2026-06-04.md, utah-contract-law-research-2026-06-04.md.

## 1. Invoice email system — BUILT + PROD-VERIFIED (PRs #281-296)
Recipient model (Cody, 2026-06-04): invoices + financial notices go to the per-client PRIMARY contact
(client_metadata.primary_contact_email), with an accountant CC (billing_cc_email) on financial docs only,
and a per-invoice extra recipient. Pure resolveInvoiceRecipients (tested). Migration 067 added the two
columns. Admin setters on /portal/admin/invoices + the invoice editor.
- Send button (sendInvoiceEmail): freezes Bill To, attaches PDF, to=primary/cc=accountant+extra,
  draft->sent + client_visible=1. Prod-verified to cody@codyasmith.com (To+CC+PDF read back via M365).
- Overdue notices: first at due+7 then weekly (pure isOverdueNoticeDue, tested); cron after markOverdue.
- Partials: MARKED overdue (visible) but NOT auto-emailed (isAutoOverdueEmailEligible). [DECISION]
- Recurring invoices now AUTO-EMAIL on generation (were notification-only) -- prod-verified.
- runDailyBilling() shared by the GitHub-Actions daily cron + a new admin "Run billing now"/"Preview".
- Payment receipts auto-fire on every payment (accountant CC'd) -- prod-verified.
- Admin failure alerts (onAutomatedFailure): in-portal + email on any automated job/send failure -- it
  FIRED correctly and caught a real bad-CC send failure.
- Pre-due reminders rerouted through the recipient model (were blasting all portal users).
BUGS CAUGHT IN PROD + FIXED: (a) Brevo 400 "name is missing in to" -- sendEmail sent name:'' for
no-name contacts; fixed (toBrevoRecipient omits empty name), PR #294. (b) Brevo 400 "email is not valid
in cc" from a malformed pasted CC -- one bad CC failed the whole email; fixed (isValidEmail drops invalid
recipients so a bad CC never blocks the client's invoice; stricter save validation), PR #296.

## 2. Billing model redesign — DESIGNED, decisions locked, NOT yet built (the next build)
See billing-model-design-2026-06-04.md. DECISIONS LOCKED (Cody, 2026-06-04):
1. Overdue = read-only ACCOUNT STATEMENT (one aggregate number over immutable invoices), NOT fusing
   debts into one document (rejected -- it double-counts receivables + breaks payment application).
2. ONE consolidated, ITEMIZED invoice per client (his design intent; the 2-contracts->2-invoices output
   is a regression). Invoices ALWAYS itemized, never a single line. [HARD RULE]
3. Late fees ON -- enforce 1.5%/mo interest.
4. Automation: all client comms/notices automated, to the client AND to Cody; server SHUTOFFS always a
   manual Cody action, never automated.
5. GATING (keystone): the automated billing policy (auto-generate, escalation/dunning, interest,
   suspension-eligibility) applies ONLY to clients with an ACTIVE PORTAL (v6/v7) contract. Legacy/paper
   clients (ZipKit) are EXCLUDED and stay manual until they re-sign.
Known latent bug to fix in the build: dunning emails iterate per-INVOICE not per-CLIENT, so a client with
2 overdue invoices gets 2 emails/run (that IS the "two bills confuse Sven" problem).
PHASES (independently shippable): (1) itemized+consolidated recurring invoice from schedule_a;
(2) read-only statement summary; (3) dunning dedupe; (4) per-client config + escalation ladder mapped to
contract 5.8 + interest, gated to active-portal-contract clients.

## 3. Contract v6 -> v7 hardening — BUILT + SHIPPED (PR #297, migration 055)
Driven by the overdue/proration/suspension issues + Cody's "strengthen v6, no proration" + "build via the
contract tool, no one-offs." v7 is a new immutable template version (v6-signed agreements keep their hash).
Clauses (Utah-law-grounded, see utah-contract-law-research-2026-06-04.md):
- s2/s5.3 consolidated itemized invoicing on-contract.
- s3.1 multi-site re-banding on growth + clean single-site removal.
- s4 pause hatch closed.
- s5.6 $15/site relabeled a Practice fee.
- s5.8 interest 18%/yr from invoice date (no Utah commercial usury cap, 15-1-1); suspension may take the
  site/server offline on >30d non-payment + 10d notice/cure, with good-faith/preserve-data/no-irreversible
  guardrails (gross-negligence carve-out can't be disclaimed -> behavioral defense); resumption = past-due
  + interest + costs + $250/product.
- s17.2 non-payment terminable at >30d+10d; suspension+termination independent/cumulative/non-tolling; no
  double recovery (Helf 2015 UT 81).
- s17.3 NO-PRORATION whole-month-earned-for-reserved-capacity (Comcast 2012 UT 49), cross-reffed s4/s17.1;
  credential handover rewritten -- never withhold the client's OWN property (conversion risk, Fibro Trust
  1999 UT 13), only defer the Practice's OWN offboarding deliverables until paid.
- s21 force majeure no longer excuses prospective recurring fees.
DECISIONS: resumption $250/product; auto-charge authorization DEFERRED (no payment processor built);
indemnity left capped; s10.1 license-scope tidy deferred (LOW).
LEGAL POSTURE: the attorney advised researching public Utah law instead of a retainer. 4 of 5 flagged
clauses enforceable as drafted/with minor polish; the credential clause is the one genuinely unsettled in
Utah (conservative rewrite is safe; optional attorney spot-check). B2B status removes consumer overlays --
keep every client a business. Before any FILED lawsuit (not before signing): pull full Comcast/Helf/
Resource Management opinions from Westlaw to confirm pincites.

## 4. ZipKit (Sven) — situation + open actions
- Old PAPER contract (signed 3/9, pre-portal) has NO non-payment teeth at all (month-to-month, 30-day
  cancel, pay-at-signing; no interest/suspension/cure). Reviewed the signed PDF.
- The 30-day notice IS leverage: he owes the overdue (INV-0003, $1,360, ~1mo overdue) + the current cycle
  (INV-0004, $1,360, sent), and keeps accruing each cycle until he gives written notice; to dodge the July
  cycle he'd need notice ~by June 9 (interpretation; the thin contract leaves room).
- Billing contacts set (Cody): primary sven@zipkithomes.com, CC robbie@zipkithomes.com.
- INV-0004 was SENT (a "go" mismatch; Cody confirmed no harm; it was the correct due invoice). INV-0003
  Cody will send manually. The auto overdue-dun is gated out for ZipKit (no portal contract).
- Cleanups: removed a stray zipkithomes.com managed-site on the Cody Test client; removed a "Slice20 test"
  draft contract on the real ZipKit client.
- OPEN: re-paper Sven onto v7 via the contract TOOL (NEXT build), at his pricing -- WM both sites $830
  (ZKH $500 + MVP $330, 9 pooled hrs), MC $500, plugin pass-through ~$30, onboarding waived, total $1,360,
  consolidated + itemized. Cody to issue/sign; I build the draft via the tool.

## 5. Standing decisions/rules captured to memory this session
Recipient model; partials marked-not-dunned; no-proration/entire-month; late fees on; automation split
(comms auto, shutoffs manual); portal-contract gating; build contracts via the tool (no one-offs,
feedback_contracts_via_tool_no_oneoffs); dry-run-before-auto-dun + verify-the-auto-path lessons.

## 6. WHAT'S NEXT (in order)
1. Confirm v7 live on prod (deploy of PR #297).
2. Build ZipKit's re-paper on v7 via the contract tool (draft for Cody to issue to Sven). Needs the
   agreement-builder flow mapped; encode the consolidated $1,360 itemized Schedule A, onboarding waived,
   plugin grandfathered; signer Sven.
3. Build the billing engine phases (itemize+consolidate -> statement -> dunning dedupe -> per-client config
   + escalation ladder mapped to v7 s5.8 + interest, gated to active-portal-contract clients).

PRs this session: #281-292 (invoice overhaul slices), #293 (email system), #294 (empty-name fix),
#295 (auto-email recurring + admin run-daily), #296 (recipient validation hardening), #297 (contract v7).
