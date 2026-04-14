# Handoff — clean stop after Slice 18d

## Project truth

This repo is a **contract-driven client operating system** for a consulting
practice. It is not a CMS, not a portal theme, not a styled database. Every
slice moves the "one intake creates honest downstream infrastructure and honest
client truth" spine forward.

Framing rules that the last several sessions operated under are captured in:

- `C:\Users\codya\.claude\projects\C--WINDOWS-system32\memory\project_client_portal_os.md`
- `C:\Users\codya\.claude\projects\C--WINDOWS-system32\memory\feedback_destructive_test_isolation.md`
- `C:\Users\codya\.claude\projects\C--WINDOWS-system32\memory\feedback_no_dead_fields.md`

Read those before starting new work. They override drift.

## Current checkpoint

**Clean stop after Slice 18d.** All test suites green. `astro build` clean.
Manual Google sync (GSC + GA4) is code-real end to end. Dashboard narrator is
traffic-aware.

## Exact landed slices in this run

- **Slice 15** — multi-contract intake (`provisionClientIntake`, envelope POST
  with `contracts: [...]`, wizard block staging + "save & add another")
- **Slice 16** — `periods.locked_at` enforcement (`isPeriodLocked`, lock/unlock
  endpoints, admin-queue `locked_periods` section, ingest-v2 lock guard)
- **Slice 16b** — reject quick action for `needs_approval` expenses
  (`QueueRow.quickActions[]` pivot, red-accent buttons in admin template)
- **Slice 17** — client plain-language summaries for keywords / health / files /
  invoices (`buildKeywordsSummary`, `buildHealthSummary`, `buildFilesSummary`,
  `buildInvoicesSummary` + `ClientSummary` shared component)
- **Slice 18** — Google OAuth foundation + Google Search Console end to end
  (encryption, oauth helpers, connections, gsc api client, sync handler, 5
  admin endpoints, admin page, CSRF exemption for callback)
- **Slice 18b** — Google Analytics 4 sync on the same foundation (`ga4.ts`,
  `syncGa4ForBinding`, `traffic-metrics.ts` with `TRAFFIC_METRIC_KEYS`, scope
  expansion in connect, dispatch in sync endpoint, dashboard tile card)
- **Slice 18c** — plain-language traffic summary (`buildTrafficSummary` with
  no-data / first-month / compare branches, dashboard ClientSummary render,
  5% meaningful threshold, engagement callout)
- **Slice 18d** — traffic-aware narrator (extracted `compareTraffic` shared
  helper, extended `FactKind` with `'traffic'`, `Fact.traffic_driver` field,
  `buildFacts` traffic branch, `renderFactSentence` + `renderNegativeRankingSentence`
  templates for visits/people/page_views, `'traffic_drop'` slice 3 source,
  6 new narrator test cases)

## Exact files touched in Slice 18d

### Edited

- `src/lib/traffic-metrics.ts` — extracted `compareTraffic(current, prior): TrafficCompare`
  + `TRAFFIC_MEANINGFUL_PCT = 5` + `TrafficDirection`/`TrafficDriver` types.
  Single source of truth for the 5% threshold + driver-selection order
  (sessions → users → page_views) + divide-by-zero guards.
- `src/lib/client-page-summary.ts` — `buildTrafficSummary` now calls
  `compareTraffic` instead of inlining the pct/direction math. Zero behavior
  change (Slice 17 test still passes untouched).
- `src/lib/client-narrator.ts`:
  - `FactKind` extended from `'top3' | 'page1' | 'health'` to
    `'top3' | 'page1' | 'health' | 'traffic'`
  - `Fact` interface gained optional
    `traffic_driver?: 'sessions' | 'users' | 'page_views'`
  - `buildFacts` signature grew a `traffic: TrafficMetrics | null` input on
    both `cur` and `prior`. Traffic fact built via shared `compareTraffic`.
  - `pickWinner` kind-order tiebreak extended:
    `{ health: 0, top3: 1, page1: 2, traffic: 3 }`
  - `renderFactSentence` traffic case with 3 sub-cases by driver
    (visits / people / page views) for positive + negative directions
  - `renderNegativeRankingSentence` matching traffic case for slice 3
  - `SlowdownResult['source']` union extended with `'traffic_drop'`
  - `generateOverviewVerdict` + `generateSlowdownVerdict` both now load
    traffic in their `Promise.all` and pass through to `buildFacts`
  - New `loadNarratorTraffic(clientId, periodId)` helper with strict
    "all 5 keys or null" partial rejection (matches Slice 18c)
- `scripts/phase1-test-client-narrator.ts` — 6 new cases
  (`Test 18d.1` through `Test 18d.6`) + defensive `toNullableInt` /
  `toNullableStr` helpers for copying keyword_snapshots rows into synthetic
  prior periods. `SLICE18D_PRIOR_START = '1999-01-01'` so the far-past date
  correctly places the synthetic prior under `ORDER BY period_start DESC`.

### Untouched

- No schema changes.
- No migration file added.
- No new API endpoint.
- No new page.

## Exact bugs fixed during Slice 18d

1. **Prior period date ordering.** Initially used `'2099-02-01'` for the
   synthetic prior period. `recentPeriodsWithData` orders by
   `period_start DESC`, and 2099 sorts before 2026, which flipped the
   current/prior mapping in the test. Fixed by switching to `'1999-01-01'`
   which correctly sorts after `'2026-04-01'` in DESC order, placing it as
   the prior slot.
2. **libsql NaN rejection on keyword row copy.** The helper that copied
   ZipKit's current keyword_snapshots into the synthetic prior period was
   passing row values directly into `db.execute`, which for some int columns
   yielded NaN and libsql rejected the INSERT with
   `RangeError: Only finite numbers...`. Fixed by adding defensive
   `toNullableInt(val)` / `toNullableStr(val)` wrappers that coerce any
   non-finite value to `null`.
3. **Top-3 demotion moved keywords INTO the `page1` bucket.** The narrator's
   `loadKeywordSlice` buckets are disjoint (`top3 = positions 1-3`,
   `page1 = positions 4-10`). The test originally demoted top-3 keywords to
   position 5 (inside page 1), which pulled them from the `top3` bucket and
   dropped them into the `page1` bucket in the prior period, creating a
   spurious `page1` negative delta strong enough to beat the traffic fact
   under `pickWinner`'s no-spin rule. Fixed by demoting to position 15
   (outside page 1 entirely), which yields a clean `top3`-only positive
   delta.

## What is now true in the product

1. **Narrator slice 1 can cite traffic as the primary "what's getting better"
   fact** when the MoM traffic move is ≥5% and the raw-count magnitude
   exceeds existing ranking/health deltas. Plain-language headline:
   `"80 more visits came to your site this month."`
2. **Narrator slice 1 also leads with traffic-negative** when that's the
   honest no-spin biggest loss. `"200 fewer visits came to your site this month."`
3. **Narrator slice 3 has a `'traffic_drop'` source tag.** When slice 1 picks
   a different fact but traffic is also down meaningfully, slice 3 surfaces
   traffic: `"The biggest drop this month: 200 fewer visits came to your site."`
4. **Slice 3 exclusion works.** When slice 1 picks traffic, the dashboard
   passes `excludeFactKind='traffic'` and slice 3 falls through cleanly.
5. **Flat traffic is ignored.** Moves under 5% never become candidate facts.
6. **Zero-GA4 clients see zero narrator change.** `Promise.all` loads
   `curTraffic`/`priorTraffic` as `null`, `buildFacts` skips the traffic
   branch, narrator behaves byte-for-byte identically to pre-18d.
7. **Plain-language voice is preserved.** Every new sentence uses "visits",
   "people", "page views" — never "sessions", "users", "GA4", "analytics".
8. **Dashboard stack** (top to bottom): existing narrator slices 1-5 →
   Slice 18c ClientSummary traffic block (when GA4 data) → Slice 18b tile
   card (when GA4 data) → legacy score ring / issue blocks.
9. **Google sync path is code-real end to end.** `POST /portal/api/admin/google/sync`
   dispatches on `binding.source` and calls `syncGscForBinding` or
   `syncGa4ForBinding`. Both honor the Slice 16 period lock guard and the
   Slice 9 binding heartbeat rule.

## What is still not done

**Production-dependent gaps** (can't be closed from a shell; need Cody's
action):

1. **Real OAuth consent** against Google's servers with Cody's Google Cloud
   OAuth client. Produces the first real refresh token.
2. **Real GSC + GA4 API round-trips** with that token against a real
   Search Console / GA4 property. Produces the first real
   `keyword_snapshots` / `metric_snapshots` rows.
3. **Real token refresh** edge cases (revocation, rotation, insufficient
   scope errors).

**Code gaps that are honestly queued:**

4. **Scheduler automation.** `sync_gsc` and `sync_ga4` `scheduled_jobs` job
   types are not wired into the runner. Manual sync is the only path today.
5. **GA4 property picker endpoint.** Cody pastes the numeric property ID
   manually. A small `POST /portal/api/admin/google/ga4-properties` that
   calls `analyticsadmin.googleapis.com` would enable a dropdown.
6. **Source/medium/channel-grouping breakdowns** in GA4. Totals only for now.
7. **Brand accent beyond the sidebar strip.** Column exists, only one render
   surface reads it.
8. **Preview-mode brand accent for admins.**
9. **Admin queue "missing billing contact" hygiene signal.** Adjacent to
   Slice 13b's missing-approval flag.
10. **Wizard "edit staged block".** Staged contract blocks can only be
    removed, not edited.
11. **Traffic summary surfaces beyond the dashboard.** No
    `buildTrafficSummary` render on `/portal/keywords` or in the narrator
    beyond slice 1/3 fact selection.

## First-step verification checklist for the next instance

Run these in order. Stop immediately on any failure and investigate before
touching new product work.

1. **Confirm repo state:**
   ```bash
   cd /c/Users/codya/projects/codyasmith.com
   git log --oneline -3
   git status --short | wc -l
   git branch --show-current
   ```
   The checkpoint branch is `checkpoint/slice-18d`. The commit message is
   `"Checkpoint: clean stop after Slice 18d"`.

2. **Verify `astro build` compiles:**
   ```bash
   npx astro build 2>&1 | tail -10
   ```
   Expected: `[build] Complete!` with `Server built in ~4s`.

3. **Run the 15 test suites in order:**
   ```bash
   npx tsx scripts/phase1-test-contract-bindings.ts
   npx tsx scripts/phase1-test-ingest-touch.ts
   npx tsx scripts/phase1-test-contract-rules.ts
   npx tsx scripts/phase1-test-milestone-seed.ts
   npx tsx scripts/phase1-test-contacts.ts
   npx tsx scripts/phase1-test-module-enforcement.ts
   npx tsx scripts/phase1-test-admin-queue.ts
   npx tsx scripts/phase1-test-expense-approve.ts
   npx tsx scripts/phase1-test-expense-reject.ts
   npx tsx scripts/phase1-test-multi-contract-intake.ts
   npx tsx scripts/phase1-test-period-locking.ts
   npx tsx scripts/phase1-test-client-page-summary.ts
   npx tsx scripts/phase1-test-slice18-gsc.ts
   npx tsx scripts/phase1-test-slice18b-ga4.ts
   npx tsx scripts/phase1-test-client-narrator.ts
   ```
   Each must print `TEST PASSED ✓`. ZipKit's April 2026 data is live; tests
   use synthetic far-future periods + synthetic tagged clients so they never
   mutate real state.

4. **Check Google env vars (only if doing Google work):**
   Required in `.env`: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
   `GOOGLE_OAUTH_REDIRECT_URI`, `GOOGLE_TOKEN_KEY`. Missing any of these =
   the connect flow shows a 503 honestly.

5. **Destructive-test isolation rule (permanent):** No destructive or
   snapshot-replace test may target a real or current production-like period.
   Use synthetic future periods (`'2099-xx-01'` or `'1999-xx-01'`) only, with
   a preflight `SELECT COUNT(*)` that refuses to run if any rows already
   exist at that target. See `feedback_destructive_test_isolation.md` and
   `scripts/phase1-test-ingest-touch.ts` for the reference pattern.

## Exact commands to run first

```bash
cd /c/Users/codya/projects/codyasmith.com
git log --oneline -5
git status --short | head -5
npx astro build 2>&1 | tail -5
```

If those three are clean, then run the 15 tests one by one and confirm each
passes before starting any new work.

## Rules for the next instance

1. **Do not drift.** This is a contract-driven operating system. Not portal
   cleanup, not polish, not decorative integrations. Every slice must move
   the spine forward.
2. **Do not reopen closed slices without evidence.** Slices 15, 16, 16b, 17,
   18, 18b, 18c, 18d are closed. Reopening them requires a concrete failing
   assertion or a reproducible bug in the live product.
3. **Source of truth:** the repo + this handoff file. Memory files are
   framing. Always verify against current code before citing file paths or
   line numbers.
4. **Destructive test isolation** is a permanent rule. See
   `feedback_destructive_test_isolation.md`.
5. **No dead fields.** Every schema column must drive downstream behavior.
   See `feedback_no_dead_fields.md`.
6. **Plain-language voice for client-facing copy.** 7th-grade reading level.
   Words like "visits", "people", "page views", "rankings", "broken links",
   "site issues", "invoices", "files". Banned: "SEO", "GSC", "GA4",
   "analytics", "sessions", "users", "impressions", "CTA", "CTR", "KPI".
7. **Do not commit or push without an explicit Cody directive.** This
   checkpoint is an exception — Cody asked for the backup.

## Likely next slice

**Slice 18e — scheduler automation for `sync_gsc` + `sync_ga4`.**

Cody has validated the code-real manual path through the admin page. The
next honest move is wiring `sync_gsc` and `sync_ga4` job types into
`src/lib/jobs/runner.ts` so a monthly cadence fires automatically when
Cody adds a new contract. `provisionContract()` already seeds scheduled
`generate_invoices` jobs for monthly cadence; the same pattern extends to
these two.

Prerequisite: Cody first needs to click through the real OAuth consent and
prove one real sync lands rows in his production Turso. Without that
proof the scheduler would run against code that hasn't been exercised
end-to-end against Google's servers. Do NOT start Slice 18e until Cody
reports the first real sync worked.

**Alternative next move:** Slice 18f — traffic summary rendered on
`/portal/keywords` in addition to the dashboard. Requires zero new
backend, just a small render add to `src/pages/portal/keywords.astro`.
Lower priority but also low risk.
