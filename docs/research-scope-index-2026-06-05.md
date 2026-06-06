# Research scope index — billing, contracts, pricing, ingest (chat of 2026-06-01 → 06-05)

> **Why this file exists.** This one chat ran for days and compacted several times.
> The work was far broader than "late-payment emails" — it spanned six distinct
> research areas. This index is the map: every area, what was concluded, and where
> the full record lives (committed docs, memory, or PR history). It re-derives
> nothing; it points. If a thread ever looks "lost," start here.
>
> Recovered 2026-06-05 by a full re-read of the raw transcript (~27k lines) plus all
> six billing/contract design docs. Nothing of substance was found to be missing from
> the record — the threads below are all captured somewhere; this file just connects them.

---

## 1. Utah contract law (the legal research behind the contract teeth)

Public-law research done in lieu of an attorney retainer (per the attorney's own
advice), to confirm which contract terms are actually enforceable in Utah B2B.

- **No proration / whole-month-owed** — ENFORCEABLE. Frame as price for reserved
  capacity / liquidated damages, not a penalty. *Comcast 2012 UT 49*, *Sosa v. Paulos*.
- **Late interest 1.5%/mo (18%/yr) simple, from invoice date** — ENFORCEABLE. Utah has
  no commercial usury cap (Utah Code 15-1-1(1)). Collection costs recoverable.
- **Attorneys' fees** — a fee clause is made reciprocal by statute (Utah Code 78B-5-826):
  if Cody sues and loses, the client recovers fees too. *Dixie State Bank v. Bracken*
  (reasonableness).
- **Suspension / taking a live site or server offline for non-payment** — ENFORCEABLE
  WITH GUARDRAILS: notice + cure, trigger only on past-due AND undisputed, downtime
  restated as a bargained foreseen consequence, preserve-data covenant, good-faith
  recital. *CCD v. Millsap 2005 UT 42*, *Vander Veur 2019 UT 64*; gross negligence
  can't be disclaimed (*Berry 2007 UT 87*, *Daniels v. Gamma West*).
- **Credential / account possessory hold (withholding the client's own logins until
  paid)** — **NOT ENFORCEABLE. The standout risk. Rewritten.** Conversion exposure,
  good-faith is no defense, no statutory lien on digital credentials (*Fibro Trust 1999
  UT 13*, *Allred v. Hinkley 1958*). v7 never withholds client property; defers only the
  Practice's own offboarding. A licensed attorney should confirm before relying on it.
- **Cumulative remedies** — ENFORCEABLE; anti-double-recovery only (*Helf v. Chevron
  2015 UT 81*).
- Supporting: B2B posture is the load-bearing strategy (strips Title 70C, auto-renewal,
  CSPA); governing law Utah / venue Iron County; force majeure does not excuse
  prospectively-billed recurring fees.

**Where it lives:** `docs/utah-contract-law-research-2026-06-04.md` (full),
`docs/contract-v6-hardening-2026-06-04.md` (v6→v7 changes),
`docs/billing-model-design-2026-06-04.md`. Source agent run: workflow `wf_9f52b88f`.
Shipped: contract template v7, PR #297. ClickUp 86baatm2m.

## 2. Sales tax

- Cody's four core services (WM retainer, MC, custom build, plugin management) are
  **NOT** Utah-taxable professional services.
- The one real exposure: prewritten-software licenses bought and passed through to a
  Utah client = **taxable resale** ("at cost" does not exempt) — a CPA call.
- In-state Cedar City seller gets no remote-seller-threshold shelter; buy resold
  software tax-free on TC-721. SB 162 (2026) codifies SaaS prewritten-software tax
  effective 7/1/2026.
- Invoices show **no tax line by default**; the tax column stays inert in schema, not
  removed.
- Sources: Utah Code 59-12-103; USTC Pub 64, Pub 25; Adv. Ops. 96-008, 99-017, 01-030.

**Where it lives:** memory `reference_utah_service_sales_tax`,
`docs/invoice-system-overhaul-design-2026-06-03.md`,
`docs/session-log-2026-06-04-portal-billing-and-contracts.md`.

## 3. Business / pricing

- **$15/site plugin fee** diagnosed as two things under one label: plugin *management*
  (already part of WM — folded into base for new clients) and plugin *license cost*
  (passes through as a Reimbursement). ZipKit grandfathered on its signed schedule.
- **Reimbursements** modeled as a cadence-aware recurring-expense template
  (`client_expenses`, migration 064), not a one-off ledger.
- **Page-count "money chain"** mapped end to end: real-user pages → ecosystem band
  (A <30 / B ≤150 / C >150) → per-site price on the contract → invoice.
- **Independent-oracle validation** corrected two benchmarks: F3 = **5** real user
  pages (memory's "6" was a `/projects/#testimonial` in-page anchor — memory fixed);
  ZKH June scrape = **62** (vs memory ~70, benign older-sitemap gap).
- **Re-pricing risk timing:** merging the page-count fix does not re-price anyone until
  `syncPerSitePageCounts` runs — HOLD all client re-syncs and review before/after,
  because Raised Bar is the live Jason/Kevin deal already sent.
- **ZipKit re-paper pricing:** $1,360/cycle (WM both sites $830 = ZKH $500 + MVP $330 /
  9 pooled hours; MC $500; plugin ~$30; onboarding waived).

**Where it lives:** memory `project_codyasmith_pricing`,
`reference_codyasmith_multi_site_pricing`, `reference_real_user_page_count`;
`docs/billing-model-design-2026-06-04.md`; canonical `business-design-v2.docx`.

## 4. Multi-site pricing (canonical formula)

- Additional sites at **0.90** (10% off) of base monthly AND 0.90 of base onboarding,
  with **FULL** pooled hours, per-site routing, no compounding. This **overruled** the
  saved 0.80/proportional model (Cody, verbally, in this chat).
- Stale 0.80 references swept across ~10 code files + the Gemini AI prompt + three
  memory docs (dated correction notes, roots preserved). Legacy `raised_bar_v1` left
  frozen at 0.80 as a deprecated reference only.
- Page-count corrections did not move any band (F3 stayed A, ZKH stayed B) — no price
  disruption.

**Where it lives:** memory `reference_codyasmith_multi_site_pricing` (CANONICAL),
`project_codyasmith_pricing`; set by PR #242 (May 31). *(This was the most
transcript-bound thread — the 0.90 overrule and sweep; now pinned in memory.)*

## 5. Billing mechanics (the invoice + dunning engine)

- **Overdue model:** Cody chose roll-forward — unpaid overdue principal + accrued
  interest carry onto the next recurring invoice as itemized lines; the old invoice
  closes as a terminal `carried_forward` status (excluded from all collection queries,
  stays client-visible). Naive "second open invoice" rejected as a double-count trap.
- **Interest math:** 1.5%/mo simple, from each invoice's issue date, principal-only (no
  interest-on-interest); segments sum to simple-from-origin by linearity. 9 passing tests.
- **Three dunning message types:** manual-billing client (zero automation) / non-standard
  client (plain past-due + faint 30-day-notice subtext, no interest/suspension) /
  portal-contract client (firm <30d → §5.8 final ≥30d naming interest). PR #301
  over-correction (gating all dunning to portal contracts) was reverted.
- **Manual-billing flag** (`clients.manual_billing`, migration 068); ZipKit set manual
  via migration 069 to close a deploy race that would have dunned a live invoice.
- **Account-statement / AR hub:** per-client + portfolio open balance, oldest-past-due
  age, accrued-interest chip; finance deliberately NOT in the health score.
- **Always-itemized invoices** (per WM site + MC + pass-through), reconcile-or-halt vs
  the signed schedule.
- **CRITICAL live catch:** a dry-run found the newly-live overdue automation would have
  auto-emailed ZipKit an unauthorized **$1,360** overdue notice (INV-2026-0003);
  reminders paused, escalated before any send.

**Where it lives:** `docs/billing-rollforward-interest-design-2026-06-05.md`,
`docs/invoice-system-overhaul-design-2026-06-03.md`, memory
`project_codyasmith_pipeline_finish_line`. Shipped: PRs #281–306. Dual + whole-system
audits (workflows wnvhkw62c, wwxxw207q) — every finding adversarially verified.

## 6. Data pipeline / technical architecture (the plumbing that feeds pricing)

The largest engineering block — repairs to stop uploaded site-audit data from being
silently lost, timed out, or misread.

- **CSV ingest format-collision:** supersession key too coarse → alphabetically-last
  sibling file overwrote the real data (13-row file beat 94-row file). Fixed: partial
  unique index + atomic supersede-before-insert. PR #252.
- **Duplicate-basename collapse:** same filename in two folders collapsed distinct
  files → fixed to pass full relative path. PR #253.
- **524 timeout:** per-row network round-trips → batched via `turso.batch`. PR #258.
- **Missing-vs-measured-zero:** free Screaming Frog skips axe-core, blanks were coerced
  to a false "0 violations, all clear" → explicit `data_coverage` table. PRs #256/#258.
- **Parse-everything:** universal `sf_export_rows` floor + `sf_generic`, retired
  "unknown" (still_unknown 333→0). Migrations 060/061.
- **Portal-wide classification-bug audit (13–15 findings):** 404 assets counted as
  pages, crawler-blocked externals (YouTube/social/Cloudflare email-protection) counted
  as broken links, benign "missing security header" Lows depressing the score, intentional
  noindex counted as "pages blocked." PRs #271–279.
- Plus: contract internal-path comment leak hardened; Brevo empty-name / malformed-CC
  400s fixed; stored immutable PDF artifact at send; duplicate-invoice feature;
  seller-profile letterhead config (migration 065).

**Where it lives:** `docs/audits/f3-ingest-format-collision-findings-2026-06-01.md`,
`docs/audits/ingest-and-pagecount-root-findings-2026-06-01.md`,
`docs/superpowers/specs/2026-06-02-ingest-batch-and-atomicity-design.md` (+ plan),
`docs/superpowers/specs/2026-06-02-data-coverage-tracking-design.md`,
`docs/superpowers/plans/2026-06-02-unique-data-parsers.md`,
`docs/audits/portal-audit-engine-design-guidance-2026-06-02.md`. Classification audit:
PR history #271–279.

---

### Confidence note

All six areas are captured in committed docs and/or memory and/or PR descriptions; the
raw transcript re-read surfaced no substantive research thread absent from the record.
The threads most bound to the transcript (now pinned in memory) were: the multi-site
0.90 overrule, the page-count money-chain regression, the re-pricing hold decision, the
ZipKit legacy-contract review, and the live $1,360 auto-dun catch.
