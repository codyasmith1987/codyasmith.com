# standard-v6 hardening review (2026-06-04)

Status: REVIEW done. v7 DRAFT STARTED at src/contracts/templates/standard-v7.md (copy of v6;
NOT seeded/live - no migration imports it yet, so getLatestContractTemplate still returns v6).

**Done in v7 draft (research-independent "known" revisions):** consolidated invoicing (s2 + s5.3),
pause escape-hatch close (s4), multi-site re-banding + clean site-removal (s3.1), $15/site relabel
to a Practice fee not a pass-through (s5.6), force-majeure no-excuse for prospective fees (s21).

**Pending in v7 (still v6 text; finalize from the Utah-law research wf_9f52b88f, then seed):**
proration / no-proration clause (s17.3), late-payment+suspension+site-offline+interest+resumption
(s5.8), termination cumulative-remedies construction (s17.2), credential-handover-conditioned-on-
payment (s17.3). DECISIONS still open: resumption fee number, auto-charge authorization (s5.3),
indemnity carve-out (s12/13), s10.1 license-scope tidy (LOW, deferred to final pass).

To go live: after research + Cody approval, finalize the pending clauses in standard-v7.md, review the
whole doc for coherence, THEN write migration 055-seed-standard-v7 (import standard-v7.md ?raw) so
getLatestContractTemplate('standard') returns v7. Build ZipKit's re-paper on v7 via the contract tool.

Redlines below are PROPOSALS for Cody + [LAWYER] items being resolved via the Utah-law research. Roll approved changes into a NEW template version (standard-v7;
templates are immutable+versioned). Build ZipKit's re-paper on v7 via the contract tool (no one-offs).
§14 internal insurance comment: NOT a live leak — contract-render.ts strips internal blocks + all
HTML comments on every client-facing/PDF render. (Binding real E&O/cyber is a separate business gap.)

## CRITICAL / HIGH holes (close these)
1. **Proration not airtight (§17.3)** — only bars refunds; never says "no proration / full month."
   Cody's locked decision. See verbatim clause below.
2. **Server-going-dark not clearly authorized (§5.8)** — "suspend the affected product" reads as
   "stop our management," not "let the client's live site go offline / stop funding hosting."
   Redline: suspension of a WM product expressly includes the right to discontinue funding/maintaining
   hosting, backups, monitoring, and any third-party service paid on the client's behalf (site/server
   may go offline); no obligation to keep anything live during a non-payment suspension; not liable
   for lost revenue/data from a non-payment suspension or vendor lapse. PLUS: during past-due, no
   obligation to advance pass-through costs (may require client pay vendor directly, cease advancing,
   or add advanced cost to past-due balance w/ interest). [LAWYER: gross-negligence carve-out §12(b)]
3. **Suspension ladder vs termination clock not sequenced (§5.8 vs §17.2)** — 15-day cure (17.2a) vs
   30+10 suspension ladder; unclear when you can terminate. Redline: non-payment terminable for cause
   if unpaid >30 days after invoice + not cured within 10 days of notice-of-intent-to-terminate;
   suspension and termination are INDEPENDENT remedies, cure periods run concurrently, suspension does
   not gate termination.
4. **Consolidated cross-product invoicing not authorized / arguably prohibited (§2, §5.3)** — §2 says
   products "never bundled into a single combined fee"; §5.3 "a verified billing period" (singular).
   The new always-itemized CONSOLIDATED invoice is off-contract. Redline: §2 -> "never combined into a
   single blended price; each product's fee set+shown separately, even on one consolidated invoice."
   §5.3 -> may issue ONE consolidated invoice across products+charges (or separate), each line itemized
   w/ its own fee+period; may combine prospective recurring + arrears; payments applied oldest-first.
   Change "single...billing period" -> "unique invoice number; recurring charges state their period."
   (Confirm "oldest-first" matches the billing code.)
5. **Credential handover not conditioned on payment (§17.3, vs §7.3)** — must hand over creds + remove
   access within 7 biz days of termination, no payment condition -> surrenders leverage on a non-payer.
   Redline: handover/access-removal timeline runs from the date past-due is paid in full (preserve
   accounts unaltered meanwhile); never claim ownership of client creds (still client property §7.3).
   [LAWYER: REQUIRED — possessory hold on client's own property = conversion/lien risk; the draft
   delays OUR timeline rather than affirmatively withholding, but confirm.]

## THE PRORATION CLAUSE (Cody's locked decision) — replace §17.3 ¶2 with:
> **No proration.** Monthly recurring fees are billed and owed in whole-month units and are never
> prorated, split, reduced, or refunded for a partial month, for any reason, including termination,
> pause, product cancellation, suspension, or mid-cycle exit by either Party. Any billing period that
> begins on or before the effective date of termination is invoiced in full and is owed in full,
> regardless of the date within that period on which termination, notice, or cessation of work occurs,
> whether or not the Client uses any service during that period, and whether or not the period has
> been invoiced or paid at the time notice is given. To avoid being charged for a billing period, the
> Client must deliver termination notice under section 17.1 such that the full notice period ends on
> or before that period begins; notice given at any point after, or that extends into, a billing
> period obligates the Client for that entire period. A billing period that begins after the effective
> date of termination is not owed. Amounts already paid for a period that has begun are non-refundable;
> amounts owed for a period that has begun but is not yet paid remain due in full. The Client also pays
> earned but uninvoiced overage, rush and emergency hours, pass-through costs, and any approved
> change-order or Build Statement of Work amounts in progress.
Plus cross-refs in §4 and §17.1 pointing to §17.3 (the legacy ambiguity came from §4 looking like a
clean pro-rata exit). [LAWYER: confirm reads as earned/liquidated fee, not an unenforceable PENALTY;
the §2 "gym-membership / price of the seat" framing is the defense — keep it.]

## MEDIUM (close same pass)
6. Resumption (§5.8 last ¶) omits accrued interest+collection costs; resumption fee defaults $0.
   Redline: resumption requires past-due + accrued interest + collection costs + a resumption fee
   [$250/product placeholder — Cody picks].
7. Interest anchor/accrual (§5.3 vs §5.8): accrue from invoice date, daily at 1/30 monthly, independent
   of the no-proration rule; client pays collection + attorneys' fees. [LAWYER: 1.5%/mo <= Utah cap?]
8. Pause (§4) escape hatch: only a current account may pause; pause doesn't toll §5.8 clock or accrued
   amounts or prorate the period; critical work + pass-throughs continue and stay billable.
9. Multi-site re-banding (§3.1): if a site grows past its band, may re-band + adjust that site's fee +
   pooled-hour contribution on 30 days' notice (client-driven growth = scope change, not a §5.7 hike).
10. Multi-site site-drop (§3.1/§17.1): removing a site reduces pooled hours by its contribution +
    removes its fee next cycle on 30 days' notice; primary status + per-site discount recalc on add/remove.
11. Auto-charge not authorized (§5.3): add client authorization to charge ACH/card on file for all
    amounts due (needed for "automate everything" billing).

## LOW / cleanup
- §5.6 "$15/site management fee" mislabeled as at-cost pass-through (it's margin) -> move to Schedule A
  as a Practice fee; strike the parenthetical (protects the at-cost rep on real pass-throughs).
- §21 force majeure: tighten so prospectively-billed recurring fees aren't excused.
- §10.1 license -> point at "Final Deliverables (§10.2)" (license vs ownership scope mismatch).
- §12/§13 indemnity capped near-zero in month 1 (6-mo LoL cap) -> consider adding indemnity to §12
  carve-outs. [LAWYER / negotiation]

## DECISIONS FOR CODY
1. Proration reach cap = "begins on or before effective termination date" (recommended; fixes a current
   §17.3 overreach; means a day-2 notice can still owe the next whole cycle if 30-day notice spills in).
2. Resumption fee: real number ($250/product?) or Schedule-A-only.
3. Interest from invoice date once 7-day grace lapses (recommended) vs from day 8.
4. Backup-release posture on suspension/termination (release recent backup on past-due+resumption paid?
   or hold until full settlement on a terminating non-payer?).
5. Indemnity carve-out from the liability cap (uncapped / mutual / leave capped).
6. Relabel the $15/site fee (pass-through -> Schedule A Practice fee)?

## LAWYER-EYES (before relying / issuing to a real client)
Proration-as-earned-fee-not-penalty; taking a live site offline for non-payment; the non-payment
termination track construction; conditioning credential handover on payment (highest risk); interest
rate + pre-suit attorneys' fees; indemnity uncapped (if adopted). Also verify (outside v6): Schedule A
§A.13 defines page-count bands; Schedule A captures a notice email per party.
