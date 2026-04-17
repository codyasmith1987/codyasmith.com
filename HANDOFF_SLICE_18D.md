# Handoff — clean stop after Slice 25

> **File name is retained as `HANDOFF_SLICE_18D.md`** because this is the
> same living checkpoint file the 18d stop established. Slices 18e
> through 25 extended it in place. The checkpoint branch name also
> stays `checkpoint/slice-18d`. Both are canonical anchors — do not
> rename them.

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

**Clean stop after Slice 25.** All 17 test suites green. `astro build`
clean (only pre-existing blog-collection warnings, not failures). Slice
25 sits directly on top of Slice 24.

Slice 25 turns the existing `milestones` table (populated by Slice 11
at contract provisioning and written to by the admin milestone edit
surface) into a real client-facing progress narrative on the dashboard.
Three buckets — "Working on" (inProgress), "Just finished"
(justFinished, 30-day recency window), "Coming up" (comingUp) — surface
plain-language client copy (`client_update_text`) with a fall-back to
`title`. Internal milestones stay invisible via a hard three-layer
filter (`milestones.client_visible = 1 AND projects.client_visible = 1
AND contracts.status = 'active'`). Empty state renders nothing — no
placeholder. `/portal/projects` remains the deep-view surface and is
untouched.

Slice 24 (the prior stop) extended `clients.brand_accent` from the
single sidebar-strip render to every client-facing portal surface via
five `portal-accent-*` utility classes consuming
`var(--brand-accent, rgb(251 191 36))`. Admins and clients with no
brand_accent see byte-identical pre-Slice-24 styling.

Slice 23 closed the silent-failure hole in Slice 22's self-perpetuating
reminder sweep by adding the `missing_billing_contact` admin-queue
section.

The unrelated blog commit `a22ebc0` ("Add blog with articles and case
studies") sits between Slice 22 and Slice 23 in the branch log. It is
not part of any numbered portal slice, Slices 23/24/25 do not depend on
it, and it introduces only pre-existing blog-collection warnings during
`astro build` (not failures).

Manual Google sync (GSC + GA4) is code-real end to end. Dashboard
narrator is traffic-aware.

> **Post-checkpoint repair note.** The original 18d checkpoint carried a
> Tailwind scan trap: `@tailwindcss/vite` 4.2.2 auto-scanned repo-root
> `HANDOFF_SLICE_18D.md` and `SLICE_18D_CHECKPOINT.patch`, and Tailwind's CSS
> unescape helper `he()` greedy-matched the substring `\feedba` inside cited
> Windows memory-file paths as a 6-hex CSS escape, calling
> `String.fromCodePoint(0xFEEDBA)` and throwing `RangeError: Invalid code
> point 16707002`. That produced a misleading `file: src/styles/global.css`
> error even though `global.css` itself was clean. The narrow fix is two
> `@source not` directives at the top of `src/styles/global.css` that exclude
> the two repo-root artifacts from the Tailwind content scan. No product
> logic was touched. All four verification suites still pass and the build
> is green in ~3.5 s.

> **Slice 18e landed on top of the repaired 18d checkpoint.** Scheduled
> automation for the two manual Google sync paths. What 18e made real:
>
> - **Scheduled `sync_gsc` jobs.** New `JobType` in `src/lib/jobs/runner.ts`,
>   handler delegates to `runGscSyncJob` in the new orchestrator module.
>   Calls the existing `syncGscForBinding` — no second sync truth.
> - **Scheduled `sync_ga4` jobs.** Same pattern, delegates to `runGa4SyncJob`,
>   calls the existing `syncGa4ForBinding`.
> - **Initial seeding from `/portal/api/admin/google/bind`.** After a
>   successful bind (`config_json` + `enabled = 1`), `seedInitialSyncJob`
>   enqueues one sync row for `previousMonth(currentUtcMonth())` with
>   `scheduled_for = now`, so the admin gets immediate feedback on the
>   next runner tick. Re-binding a live binding is a no-op.
> - **One pending-or-running job per (binding, sync type) via idempotent
>   enqueue.** `ensureSyncJobQueued` runs a `payload_json LIKE
>   '%"binding_id":"<id>"%'` check against `status IN ('pending','running')`
>   with a self-exclude clause before inserting. Used at both the seed site
>   and the handler's next-cycle re-enqueue, so double-clicks, runner crash
>   + lease-expired re-claims, and duplicate `runDueJobs` calls all collapse
>   to one pending row.
> - **Honest halt on failure, no fake re-enqueue.** On any non-`applied`
>   sync result (locked period, missing config, disabled binding, token
>   refresh fail, API error), `last_result` records
>   `sync_{gsc,ga4} binding=<id> month=<yyyy-mm> failed: <real error>` and
>   the chain stops. Admin has to re-bind or hit `/sync` manually to restart
>   it — silent retry forever would mask the breakage.
> - **No schema changes.** No new migration, no new column, no new table.
>   All scheduling state lives in the existing `scheduled_jobs` table via
>   `payload_json`. The `(binding, sync type)` invariant is code-enforced,
>   not DB-enforced — consistent with the existing `ensureRecurringJobsQueued`
>   pattern for recurring billing.
>
> **Exact files touched by 18e:**
>
> - `src/lib/jobs/google-sync-jobs.ts` — new. Payload parsing, month
>   arithmetic (`nextMonth`, `previousMonth`, `currentUtcMonth`,
>   `syncRunDateFor`), `ensureSyncJobQueued`, `seedInitialSyncJob`,
>   `runGscSyncJob`, `runGa4SyncJob`, and a `__setGoogleClientsForJobs`
>   test seam so the runner can be exercised without real HTTP calls.
> - `src/lib/jobs/runner.ts` — edit. Extended `JobType` union, imported
>   the two handler entry points, added two tiny handler branches in the
>   `handlers` map. Claim/lease/dispatch semantics untouched.
> - `src/pages/portal/api/admin/google/bind.ts` — edit. After the
>   successful update + `logActivity`, calls `seedInitialSyncJob` and
>   returns `sync_seeded` so the admin UI can tell whether the chain started.
> - `scripts/phase1-test-slice18e-sync-jobs.ts` — new. Six test cases:
>   (0) month-arithmetic unit checks, (1) `sync_gsc` end-to-end through the
>   runner with `re_queued=1` verification, (2) `sync_ga4` mirror,
>   (3) duplicate `runDueJobs` calls do not multiply future jobs,
>   (4) locked-period failure is honest with no re-enqueue, (5)
>   missing-config failure is honest with no re-enqueue, (6)
>   `seedInitialSyncJob` is idempotent. Uses `2099-05`/`06`/`07` periods,
>   disjoint from Slice 18's `01`/`02` and Slice 18b's `03`. Preflight
>   guard + try/finally cleanup including belt-and-braces
>   `payload_json LIKE '%binding_id%'` deletes.

> **Slice 18f landed on top of Slice 18e.** Admin-queue visibility for
> unhealthy Google data-source bindings. The automated chain from 18e
> runs silently on success and halts honestly on failure; 18f is the
> truth layer that surfaces those halted, stale, never-synced, or
> misconfigured bindings in one place so Cody can see what needs
> action next. What 18f made real:
>
> - **Admin queue section `google_sync_attention`.** New entry in
>   `loadAdminQueue()`'s `sections[]` array, positioned between
>   `missing_automation` and `locked_periods` (the silent-failure canary
>   neighborhood). Label: "Google data sources needing attention".
>   Count flows into `queue.counts.google_sync_attention` automatically
>   via the existing count-assembly loop.
> - **Four health rules in strict priority order**, one row per binding:
>   1. **`misconfigured`** — `config_json` is null/invalid or lacks a
>      non-empty `connection_id` / `property`. Admin enabled the binding
>      but never completed `POST /portal/api/admin/google/bind`.
>   2. **`failed_halted`** — config is valid, no pending/running
>      `sync_gsc`/`sync_ga4` job for this binding, AND at least one
>      done/failed sync row exists whose `last_result` matches
>      `% failed:%` (the shape `handleSyncResult` writes on any non-
>      `applied` outcome). The `why` line echoes the failure tail so
>      Cody sees the real error in the queue.
>   3. **`never_synced`** — config valid, no active job, no failure-
>      shape history, `last_seen_at IS NULL`. Bound but the seed job
>      never ran and nothing is queued.
>   4. **`stale`** — config valid, no active job, no failure-shape
>      history, `last_seen_at` older than
>      `GOOGLE_STALE_THRESHOLD_DAYS`.
> - **`GOOGLE_STALE_THRESHOLD_DAYS = 45`** in
>   `src/lib/jobs/google-sync-health.ts`. Rationale: monthly cadence
>   produces ~30-day gaps between `last_seen_at` stamps; 30 would false-
>   positive on a single late runner tick, 60 would hide a full missed
>   month. 45 absorbs one late tick but surfaces a missed month.
>   Exported so future slices can dial it in one place.
> - **Healthy and disabled bindings stay silent.** A binding with ANY
>   pending/running `sync_gsc`/`sync_ga4` job is considered healthy
>   regardless of `last_seen_at` — the chain is live. Bindings with
>   `enabled = 0` are filtered out at the top-level SELECT — admin is
>   explicitly opting out of that source. CSV sources
>   (`ubersuggest_*`, `screaming_frog_issues`) are not touched.
> - **No schema changes.** No migration, no new column, no new table,
>   no new endpoint. Everything reads existing `data_source_bindings`
>   + `scheduled_jobs` state and returns one more `QueueSection` shaped
>   exactly like every other section.
>
> **Exact files touched by 18f:**
>
> - `src/lib/jobs/google-sync-health.ts` — new. Owns the four rules,
>   the priority cascade in `classifyBinding`, the `hasActiveSyncJob`
>   and `latestFailedSyncJob` scheduled-jobs lookups via
>   `payload_json LIKE '%"binding_id":"<id>"%'`, and the section-level
>   entry point `loadGoogleSyncAttentionSection(): Promise<QueueSection>`.
>   Re-uses the `QueueSection`/`QueueRow` types from `admin-queue.ts`
>   without importing anything else from that module.
> - `src/lib/admin-queue.ts` — 3-line net edit. Added the import,
>   one await call at the queue-build site between `missing_automation`
>   and `locked_periods`, and an entry in the `sections[]` assembly
>   array in the same position. Everything else in the file is
>   unchanged. Renumbered the `locked_periods` comment header from
>   `11.` to `12.` to reflect the new slot.
> - `scripts/phase1-test-slice18f-google-sync-attention.ts` — new.
>   Seven assertion blocks: (1) misconfigured gsc surfaces, (2) never-
>   synced ga4 surfaces, (3) stale gsc surfaces with day count ≥ 45,
>   (4) failed-halted ga4 surfaces with the `failed:` tail and original
>   error substring preserved, (5) healthy ga4 (pending job far in
>   future) stays silent, (6) disabled gsc stays silent, plus an
>   integration check that `loadAdminQueue()` composes the new section
>   and exposes `queue.counts.google_sync_attention`. Uses three tagged
>   synthetic contracts (A/B/C) under ZipKit to supply six bindings
>   without fighting the `UNIQUE(contract_id, source)` constraint.
>   Cleanup deletes every test scheduled_job both by tracked id and
>   via belt-and-braces `payload_json LIKE` sweeps.

> **Slice 18g landed on top of Slice 18f.** Non-Google data-source
> visibility in the admin queue. 18f gave Cody one place to see
> unhealthy GSC/GA4 bindings; 18g closes the matching blind spot for
> CSV-driven sources so every enabled data feed on the platform has
> a real health row when it needs attention. What 18g made real:
>
> - **Admin queue section `csv_source_attention`.** New entry in
>   `loadAdminQueue()`'s `sections[]` array, positioned between
>   `google_sync_attention` and `locked_periods` (the silent-failure
>   canary neighborhood). Label: "CSV data sources needing attention".
>   Count flows into `queue.counts.csv_source_attention` automatically
>   via the existing count-assembly loop. Additive to
>   `google_sync_attention` — not a rename, not a replacement.
> - **Included source kinds (three, all Ubersuggest):**
>   - `ubersuggest_position_tracking`
>   - `ubersuggest_keyword_research`
>   - `ubersuggest_site_audit`
> - **Excluded source kind: `screaming_frog_issues`.** Verified
>   directly in the repo at 18g time — still has no parser in
>   `src/lib/csv/detector.ts`, still never returned by
>   `csvFormatToDataSourceKind` in `src/lib/data-sources.ts`, still
>   never reaches `touchBindingsForClient` in
>   `src/lib/csv/ingest-v2.ts:359`, still only appears in tests with
>   `enabled: false`. Including it would force invented heuristics.
>   When a future slice adds a Screaming Frog parser and wires the
>   heartbeat, `CSV_SOURCE_KINDS` and `CSV_KIND_FORMATS` in the
>   health module are the only two constants that need to change.
> - **Three health rules in strict priority order**, one row per binding:
>   1. **`last_import_failed`** — the most recent `imports` row for
>      `(client_id, kind's format set)` has `status='failed'`. The
>      `why` line echoes the failure tail (truncated to 140 chars)
>      so Cody sees the real parse error in the queue. This is the
>      honest per-binding failure linkage — not truly per-binding
>      since `imports` has no `binding_id` column (it's keyed on
>      `(client_id, source)` where `source` is the raw format name),
>      but effectively 1:1 in production thanks to
>      `UNIQUE(contract_id, source)` + one-retainer-per-client. The
>      module docstring states the pathological two-retainers-same-
>      client case explicitly — no fake per-binding attribution.
>   2. **`never_imported`** — no import row exists at all AND
>      `last_seen_at IS NULL`. Bound but nothing ever uploaded.
>   3. **`stale`** — most recent import row is `applied` but its
>      `started_at` is older than `CSV_STALE_THRESHOLD_DAYS`. Uses
>      `imports.started_at` (transactionally written by ingest-v2)
>      as the effective heartbeat rather than
>      `data_source_bindings.last_seen_at` (best-effort post-commit
>      touch that can silently fail).
> - **`CSV_STALE_THRESHOLD_DAYS = 45`** in
>   `src/lib/jobs/csv-source-health.ts`. Same as Google's threshold.
>   CSV uploads are ad-hoc with no scheduler, so there's no natural
>   cadence in the repo to anchor a per-source number to. 45 is the
>   honest minimum for "at least one monthly cycle plus buffer has
>   passed without a fresh CSV." Single constant, single source of
>   truth — a future slice can split per-kind in one place when
>   there's real cadence evidence.
> - **Healthy and disabled bindings stay silent.** A binding whose
>   most recent import is `applied` and within the freshness window
>   returns null from `classifyBinding` and never hits the `rows[]`
>   array. Pending imports are silent because the existing
>   `stale_pending` section already owns that signal. Disabled
>   bindings (`enabled = 0`) and non-CSV bindings (`gsc`/`ga4`) are
>   filtered at the top-level SELECT. CSV sources cannot double-
>   report under the existing `stale_pending` row shape.
> - **No schema changes.** No migration, no new column, no new
>   table, no new endpoint. Everything reads existing
>   `data_source_bindings` + `imports` state and returns one more
>   `QueueSection` shaped like every other section.
>
> **Exact files touched by 18g:**
>
> - `src/lib/jobs/csv-source-health.ts` — new. Owns the three
>   rules, the priority cascade in `classifyBinding`, the
>   `latestImportForKind` SELECT keyed on `(client_id, source IN
>   format-set)`, `CSV_SOURCE_KINDS` + `CSV_KIND_FORMATS`
>   (the strict inverse of `csvFormatToDataSourceKind`), and the
>   section-level entry point
>   `loadCsvSourceAttentionSection(): Promise<QueueSection>`.
>   Re-uses the `QueueSection`/`QueueRow` types from
>   `admin-queue.ts` without importing anything else from that
>   module.
> - `src/lib/admin-queue.ts` — 4-line net edit. Added the import,
>   one await call at the queue-build site between
>   `google_sync_attention` and `locked_periods`, and an entry in
>   the `sections[]` assembly array in the same position. Renumbered
>   the `locked_periods` comment header from `12.` to `13.` to
>   reflect the new slot. Nothing else in the file changed.
> - `scripts/phase1-test-slice18g-csv-source-attention.ts` — new.
>   Six assertion blocks + constants sanity preamble: (1) never-
>   imported position_tracking surfaces, (2) stale site_audit
>   surfaces with day count ≥ 45, (3) last-import-failed keyword_
>   research surfaces with the original error substring preserved,
>   (4) healthy position_tracking on an isolated client stays
>   silent, (5) disabled site_audit stays silent, plus an
>   integration check that `loadAdminQueue()` composes the new
>   section alongside the still-present `google_sync_attention`.
>   Uses **two fully synthetic clients** (X and Y) created via
>   direct `INSERT INTO clients` — not ZipKit — because the health
>   rule is per `(client_id, kind)` and ZipKit has real production
>   CSV imports that would cross-pollinate the per-client lookup
>   and break case 1 (this bug crashed the first test run; the
>   fix was to use synthetic clients only). `insertImport` creates
>   a dedicated synthetic far-future period per import row so we
>   never stamp real period state. Cleanup in try/finally deletes
>   `imports` by tracked id + belt-and-braces
>   `original_name LIKE 'slice-18g-%'`, deletes contracts A/C/D
>   + bindings + scheduled_jobs + activity_log, then deletes all
>   `imports` and `periods` tied to clients X/Y before deleting
>   the clients themselves.

> **Slice 18h landed on top of Slice 18g.** Screaming Frog is no
> longer the missing source. 18g explicitly documented the gap
> ("`screaming_frog_issues` still has no real parser/import/
> heartbeat path in this repo"); 18h closes it with one honest
> Screaming Frog export format wired end-to-end through the
> existing CSV ingest pipeline into the existing issue truth.
> What 18h made real:
>
> - **Supported Screaming Frog format: `screaming_frog_response_codes`.**
>   The smallest honest move — one format, one parser, one
>   downstream table. Other Screaming Frog exports (Internal HTML,
>   audit sub-reports, crawl overview text report) still fall
>   through to the existing `site_audit` filename-hint fallback
>   unchanged. A future slice can lift additional sub-reports into
>   dedicated parsers the same way.
> - **Source export: Screaming Frog "Response Codes: All" CSV.**
>   Detector signature keys on four unique columns:
>   `address, content type, status code, indexability`. None of
>   those overlap with any Ubersuggest signature, so the new format
>   is matched by signature before any fallback catches it.
> - **Destination truth: `issue_snapshots`.** No new schema — the
>   existing per-issue-name-keyed shape with `affected_urls` as a
>   count, `priority`, `pct_of_total`, `description`, `how_to_fix`
>   is a perfect fit. The parser groups CSV rows by HTTP status
>   bucket and emits one `StagedIssue` per non-empty non-2xx
>   bucket. 2xx rows are counted toward the `pct_of_total`
>   denominator but never produce a row — healthy URLs are not
>   issues. Buckets:
>   - `1xx` → `"Response Codes: Informational (1xx)"`, priority low
>   - `3xx` → `"Response Codes: Redirection (3xx)"`, priority medium
>   - **`4xx` → `"Response Codes: Internal Client Error (4xx)"`, priority critical.**
>     This is byte-for-byte the string the narrator's broken-link
>     sentence template at `src/lib/client-narrator.ts:451-458`
>     looks for, so Screaming Frog data lights up the narrator's
>     "N broken links on your pages are leading visitors to dead
>     ends" sentence with zero narrator code changes.
>   - `5xx` → `"Response Codes: Server Error (5xx)"`, priority critical
>   - `0`/empty → `"Response Codes: Blocked or Unknown (no response)"`, priority medium
> - **`screaming_frog_issues` binding heartbeat is now real**
>   through `csvFormatToDataSourceKind('screaming_frog_response_codes')
>   → 'screaming_frog_issues'` → the existing post-commit
>   `touchBindingsForClient` block in `ingest-v2.ts:356-368`. Once
>   the mapping line exists, the shared ingest-v2 heartbeat path
>   fires automatically — no ingest-v2 code change was needed
>   beyond wiring the parser dispatch. Proven in 18h.5 with a
>   source-filter sanity check (the `screaming_frog_issues`
>   binding gets stamped, a co-located
>   `ubersuggest_position_tracking` binding on the same contract
>   stays `NULL`).
> - **`csv_source_attention` now honestly includes
>   `screaming_frog_issues`.** `CSV_SOURCE_KINDS` grew from three
>   to four elements, `CSV_KIND_FORMATS.screaming_frog_issues`
>   points at `['screaming_frog_response_codes']`, the
>   previously-documented exclusion note in the module header
>   was rewritten to say "covered by Slice 18h". The existing
>   three-rule priority cascade
>   (`last_import_failed` → `never_imported` → `stale`) applies
>   identically to the new kind — zero rule-logic change, zero
>   assertion changes in 18g's rule-behavior cases. 18g's
>   constants sanity preamble was updated to expect four kinds
>   instead of three.
> - **No schema changes.** No migration, no new column, no new
>   table, no new endpoint, no new `DataSourceKind` variant
>   (`'screaming_frog_issues'` was already declared but orphaned).
> - **Still only one Screaming Frog export format supported in
>   this slice.** Explicitly scoped. The other export sub-reports
>   remain routed to the `site_audit` filename-hint fallback as
>   they were pre-18h — that's a known approximation, not a
>   regression.
>
> **Exact files touched by 18h:**
>
> - `src/lib/csv/parsers/screaming-frog-response-codes.ts` — new.
>   Owns the five bucket definitions, the `bucketForStatus`
>   HTTP-code classifier (numeric range checks with defensive
>   handling of empty / non-numeric / `0` cases), the grouping
>   loop, the `pct_of_total` rounding (one decimal place), the
>   fixed emit-order cascade (`4xx, 5xx, 3xx, 1xx, none`) so
>   output is deterministic regardless of Map insertion order,
>   and the `parseScreamingFrogResponseCodesV2(raw): ParseResult`
>   entry point the dispatch switch calls.
> - `src/lib/csv/detector.ts` — added `'screaming_frog_response_codes'`
>   to the `CsvFormat` union and one `SIGNATURES` entry. No
>   change to `detectFormat`'s control flow; the new signature
>   is picked up by the existing `for (const sig of SIGNATURES)`
>   loop and the match runs before every fallback block so the
>   new format wins over the pre-existing
>   `type + source + status code` and `response_code` filename
>   heuristics that previously routed Screaming Frog CSVs to the
>   `site_audit` approximation.
> - `src/lib/csv/ingest-v2.ts` — three additive edits. Imported
>   the new parser, added the `SNAPSHOT_TARGET` entry
>   `screaming_frog_response_codes: { tables: ['issue_snapshots'] }`,
>   added one dispatch case to `dispatchParser`. The apply step,
>   period resolution, import row lifecycle, post-commit
>   `touchBindingsForClient` block, and transactional replace
>   are unchanged because the existing generic paths already
>   handle every `StagedIssue[]` shape.
> - `src/lib/data-sources.ts` — one new `switch` case in
>   `csvFormatToDataSourceKind`:
>   `'screaming_frog_response_codes' → 'screaming_frog_issues'`.
>   The `DataSourceKind` union already contained the kind, so
>   no type change. **This is the single line that activates
>   the heartbeat path** — once the mapping exists, the already-
>   present post-commit call to `touchBindingsForClient` stamps
>   `last_seen_at` on every matching binding.
> - `src/lib/jobs/csv-source-health.ts` — added
>   `'screaming_frog_issues'` to `CSV_SOURCE_KINDS` and
>   `CSV_KIND_FORMATS`, and rewrote the module header to reflect
>   that the kind is now covered. No rule-cascade change, no
>   `classifyBinding` change, no SELECT change — the existing
>   generic CSV health path picked up the new kind via the
>   `CSV_SOURCE_KINDS` IN-list and the `CSV_KIND_FORMATS` lookup.
> - `scripts/phase1-test-slice18g-csv-source-attention.ts` —
>   bumped `CSV_SOURCE_KINDS.length` from 3 to 4 and added one
>   `CSV_KIND_FORMATS.screaming_frog_issues.length === 1` sanity
>   check. The 18g rule-behavior cases were not changed because
>   they filter section rows by specific test binding ids and
>   don't interact with the new kind.
> - `scripts/phase1-test-slice18h-screaming-frog.ts` — new.
>   Seven assertion blocks: (1) detector signature match, (2)
>   parser groups 9-row fixture into 4xx/5xx/3xx/no-response
>   buckets with exact counts, priorities, and pct_of_total
>   rounded to one decimal, (3) parser skips healthy-only
>   fixtures, (4) `csvFormatToDataSourceKind` mapping, (5) full
>   `ingestCSVViaSnapshots` end-to-end — ZipKit at far-future
>   period `2099-10`, preflight guard, synthetic contract with
>   BOTH a `screaming_frog_issues` binding and a
>   `ubersuggest_position_tracking` binding (for source-filter
>   proof), null-out heartbeats before the call, assert the
>   `screaming_frog_issues` binding gets stamped within 5 minutes
>   and the PT binding stays NULL, (6) run the narrator's exact
>   `loadRankedIssues` SELECT shape against the ingested rows
>   and assert the 4xx row comes back with `priority='critical'`
>   and `affected_urls=3`, (7) spin up a second synthetic client
>   with a fresh never-imported `screaming_frog_issues` binding
>   and assert `loadCsvSourceAttentionSection()` now surfaces it
>   with the expected "never been imported" phrasing. Cleanup
>   in try/finally via tracked ids + belt-and-braces deletes,
>   plus explicit teardown of the synthetic second client.

> **Slice 18i landed on top of Slice 18h.** The client-facing
> `/portal/health` summary now reads real `issue_snapshots` rows
> (which 18h made complete for Screaming Frog) and turns them into
> sharp plain-language meaning instead of a generic count. This
> closes the gap between "we have the truth" and "the client can
> read the truth in a glance." What 18i made real:
>
> - **`/portal/health` summary now uses the top named issue as the
>   headline.** Pre-18i: `"We found 3 things to look at on your
>   site."` — a count, no named meaning. Post-18i:
>   `"6 broken links right now."` — the biggest specific story,
>   sentence-ready, translated via the existing `plainIssueLabel`
>   helper so "Response Codes: Internal Client Error (4xx)" never
>   reaches the client as audit jargon.
> - **Bullets now carry ranks 2 and 3** of the deduped current-
>   period list, each rendered via `plainIssueLabel`. Capped at
>   two named bullets. If the list has more than three entries, a
>   single `"…and N more things to look at."` overflow bullet
>   acknowledges the excess without burying the main story. For
>   single-issue states, `bullets === []`.
> - **Duplicate `issue_name` rows across sources are deduped by
>   normalized issue name.** Both `issues_overview` (Ubersuggest)
>   and `screaming_frog_response_codes` (Slice 18h) can emit a row
>   named exactly `"Response Codes: Internal Client Error (4xx)"`
>   for the same client+period — they describe the same real
>   problem, not two different problems. `rankAndDedupeIssues`
>   collapses them via `issue_name.trim().toLowerCase()` before
>   ranking so the client sees one broken-link story, not two.
> - **Dedupe keeps MAX `affected_urls` and the strictest priority.**
>   On collision: the broader-crawl source (usually Screaming Frog,
>   which crawls every URL) wins the count; the stricter
>   classification (usually `'critical'`) wins the priority tier.
>   First-seen casing wins the display string. Deterministic, no
>   source weighting.
> - **`'critical'` now outranks `'high'` in the health summary.**
>   Pre-18i the SQL-based ordering put `'high'` at tier 0 and
>   silently dropped `'critical'` into the "else" bucket at tier 3,
>   meaning Screaming Frog 4xx/5xx rows sorted BEHIND Ubersuggest
>   `'high'` rows. The new `priorityTier` helper restores the
>   honest order `critical(0) → high(1) → medium(2) → low(3) →
>   else(4)`, matching the narrator's own ranking at
>   `client-narrator.ts:544-558`. Now a Screaming Frog row wins
>   the headline when it should.
> - **Comparative callout only when honest.** `"Up from N last
>   month."` or `"Down from N last month."` appears ONLY when the
>   top current issue's normalized name exists in the prior period
>   AND the absolute count delta is ≥ 2. A 1-page delta is
>   suppressed as noise (crawler variance). No prior period → no
>   callout. Different top issue in prior period → no callout.
>   Comparative language is scoped to the top issue only; per-
>   bullet deltas are out of scope for this slice.
> - **No-issue fallback stays honest and quiet.** Zero issues in
>   the current period → `"No site problems right now."` with
>   empty bullets and `null` callout. Comparative callout is
>   suppressed on the healthy fallback even when the prior period
>   had issues — saying "down from 5 last month" would bury the
>   good news under a comparison.
> - **No schema changes, no migration, no new endpoint.** The
>   `ClientSummary` shape is byte-identical; `/portal/health.astro`
>   still destructures `{headline, bullets, callout}` without a
>   template edit.
> - **No narrator / dashboard / admin-queue / Google / scheduler
>   changes.** 18i is scoped to one function
>   (`buildHealthSummary`) and its internal helpers. Everything
>   else sits untouched.
>
> **Exact files touched by 18i:**
>
> - `src/lib/client-page-summary.ts` — replaced `loadPriorityIssues`
>   and `buildHealthSummary`. Added three internal helpers:
>   `priorityTier(p)` (narrator-matching tier map),
>   `rankAndDedupeIssues(rows)` (single-pass normalized-name
>   collapse + MAX count + strictest priority + first-seen casing,
>   then sort by tier ASC, count DESC, name ASC), and
>   `capitalizeFirst(s)` (defensive headline sentence-start
>   capitalization). Renamed the raw loader to
>   `loadIssueSnapshots(clientId, periodId)` — now returns rows
>   without any SQL ordering because all ranking logic lives in
>   the helper. `buildHealthSummary` now loads BOTH current and
>   prior periods (prior only used for the comparative callout
>   branch), constructs a headline from the top-ranked named issue
>   via `plainIssueLabel` + `" right now."`, emits up to two
>   named bullets, and appends a comparative callout only on the
>   honest-change path. `ClientSummary` shape is unchanged; every
>   other exported function in the file is untouched.
> - `scripts/phase1-test-slice18i-health-summary.ts` — new. Seven
>   assertion blocks covering the four rule paths plus the noise
>   cases plus the fallback plus a multi-issue integration check:
>   (1) Screaming Frog 4xx row becomes the top story with
>   `"5 broken links right now."`, (2) Ubersuggest
>   `Missing meta description` row becomes the top story with
>   `"7 pages missing a short description right now."`, (3) same-
>   name across sources dedupes to one story with MAX count 5 and
>   no reference to the 3-count, (4) prior period with the same
>   name and delta +3 produces `"Up from 2 last month."`, (5)
>   two noise cases — prior has a different issue → no callout,
>   delta = 1 → no callout — both suppressed, (6) empty current
>   period → healthy fallback, (7) three-issue integration:
>   critical 4xx (count 6) wins the headline, high meta
>   description (count 4) is bullet[0], medium duplicate title
>   (count 2) is bullet[1], no overflow bullet, no callout.
>   Uses ONE fully synthetic client Z (created via direct
>   `INSERT INTO clients`) plus two synthetic periods
>   (`2099-11-01` current, `2099-10-01` prior) so the test never
>   reads or mutates ZipKit's real issue state. `imports.uploaded_by`
>   FK is satisfied via a real admin user id fetched at bootstrap;
>   every inserted `imports` row is tracked and torn down in the
>   try/finally, followed by a per-client `DELETE FROM
>   issue_snapshots / imports / periods / clients` sweep.

> **Slice 19 landed on top of Slice 18i.** The admin dashboard at
> `/portal/admin` now has a three-bucket work-summary rail above
> the strip chips so Cody can see his day in a glance without
> reading every queue section. What Slice 19 made real:
>
> - **Three-bucket triage rail on `/portal/admin`.** Three columns
>   above the existing strip chips: "Act now" (red accent),
>   "Waiting on others" (amber accent), "Coming up" (neutral).
>   Each non-zero queue section becomes one summary line in its
>   assigned bucket. Each line shows count + label and links to
>   the detail section below. When a bucket has exactly one
>   underlying row, the specific detail (what + where) is shown
>   inline so Cody doesn't even have to scroll.
> - **Bucket assignment rules.** `buildWorkSummary(queue)` is a
>   pure function that classifies the existing 18 queue sections
>   into three buckets:
>   - **Act now:** failed_jobs, failed_imports, stale_pending,
>     late invoices, overdue_milestones, unbilled_needs_approval,
>     unbilled_manual_review, drafts, expired contracts,
>     missing_automation, google_sync_attention,
>     csv_source_attention, plus hard blockers.
>   - **Waiting on others:** pending_approvals, due_soon invoices,
>     plus soft blockers (known limitations).
>   - **Coming up:** upcoming_milestones, expiring contracts,
>     unbilled_auto_bill expenses.
>   - **Skipped:** locked_periods — informational, not actionable.
> - **Dedupe is by section, not by row.** 3 late invoices = one
>   "3 late invoices" line, not 3 lines. Each section maps to
>   exactly one bucket. No row appears in two buckets.
> - **Severity ordering within each bucket.** Items sort by a
>   fixed severity rank so blockers and infrastructure failures
>   always appear first in "Act now."
> - **Empty-state messages per bucket.** "Clear." / "Nothing
>   pending." / "Nothing on the horizon." — honest silence when
>   a bucket has zero items.
> - **No schema changes.** No migration, no new table, no new
>   column, no new endpoint, no new task system.
> - **No quiz changes.** The quiz commit on top of the branch is
>   untouched.
> - **Built from existing queue truth only.** No new DB queries.
>   The summary is a pure presentation-layer transformation of
>   the `AdminQueue` that `loadAdminQueue()` already produces.
>
> **Exact files touched by Slice 19:**
>
> - `src/lib/admin-work-summary.ts` — new. Owns `WorkItem` and
>   `WorkSummary` types, the `SECTION_MAP` bucket/severity/label
>   mapping for all 17 classified sections, the `buildWorkSummary`
>   pure function, and the `MAPPED_SECTION_KEYS` export for test
>   coverage verification.
> - `src/pages/portal/admin/index.astro` — edit. Added import of
>   `buildWorkSummary`, one `const summary = buildWorkSummary(queue)`
>   call in frontmatter, and a 68-line three-column grid template
>   between `</header>` and the strip chips. No other changes to
>   the page — strip, blockers, sections, quick-action script all
>   untouched.
> - `scripts/phase1-test-slice19-work-summary.ts` — new. Ten
>   assertion blocks: (1) failed_jobs → actNow, (2) pending_approvals
>   → waiting with single-row detail, (3) upcoming_milestones →
>   upcoming with null detail on multi-row, (4) 3-row section dedupes
>   to 1 summary item, (5) empty queue → all buckets clear, (6) hard
>   blocker → actNow / soft blocker → waiting, (7) locked_periods
>   excluded from all buckets, (8) severity ordering within actNow,
>   (9) full 17-section bucket assignment coverage, (10) integration
>   against live DB via loadAdminQueue → buildWorkSummary with
>   structure, anchor, count, and no-duplicate-label checks.

> **Slice 20 landed on top of Slice 19.** The admin expenses page
> at `/portal/admin/expenses` now shows billing classification
> state per expense so Cody can see what will auto-bill, what
> needs his approval, and what needs a manual decision — all from
> one surface. What Slice 20 made real:
>
> - **Classification badges per expense.** Color-coded pills:
>   `needs_approval` (red), `manual_review` (amber), `auto_bill`
>   (green). Every open expense now shows its billing state
>   inline.
> - **Classification-priority sort within each contract group.**
>   `needs_approval` rows appear first (blocked until Cody acts),
>   `manual_review` second (awareness), `auto_bill` third (will
>   attach automatically). Sort is by classification tier, not by
>   date, so the items that need action bubble to the top.
> - **Summary count strip above the list.** One-line counts:
>   `N needs approval · N manual review · N auto-bill`. Only
>   non-zero counts are shown. Gives Cody a glance triage before
>   scrolling.
> - **Client name in each contract group header.** Format:
>   `{clientName} · {contractTitle}`. Previously showed contract
>   title only.
> - **Category tag per expense.** When a category was assigned at
>   creation time (drives passthrough-rule classification), it
>   appears as a small mono tag `[category]` after the
>   description.
> - **Approve button for needs_approval AND manual_review items.**
>   Inline green button on each row whose classification is
>   `needs_approval` or `manual_review`. Calls the existing
>   `POST /portal/api/admin/expenses/{id}/approve` endpoint.
>   Page reloads on success.
> - **Approve endpoint now accepts manual_review.** Pre-Slice-20
>   the endpoint refused anything except `classification =
>   'needs_approval'` with a 409. Now it also accepts
>   `'manual_review'` and flips both to `auto_bill` with
>   `needs_approval = 0`. Auto_bill inputs still get a 409 —
>   you can't approve something that's already cleared for
>   billing.
> - **No schema changes.** No migration, no new column, no new
>   table, no new endpoint.
> - **No quiz changes.**
>
> **Exact files touched by Slice 20:**
>
> - `src/pages/portal/admin/expenses.astro` — edit. Extended the
>   `pending_charges` query with `pc.classification`,
>   `pc.needs_approval`, `pc.category`, and `cl.name` (via a
>   new `JOIN clients cl`). Added `classificationOrder`,
>   `badgeStyle`, `badgeText` helpers in frontmatter. Added
>   within-group sort by classification priority. Added summary
>   count strip, client name in group header, classification
>   badge per row, category tag, and approve button for
>   needs_approval / manual_review items. Added approve-button
>   click handler in the client script.
> - `src/pages/portal/api/admin/expenses/[id]/approve.ts` — edit.
>   Widened the classification guard from
>   `classification !== 'needs_approval'` to
>   `classification !== 'needs_approval' && classification !==
>   'manual_review'`. One line changed. Error message updated to
>   list both accepted classifications.
> - `scripts/phase1-test-slice20-billing-inputs.ts` — new. Six
>   assertion blocks: (1) classification columns present in query,
>   (2) approve flips needs_approval → auto_bill, (3) approve
>   flips manual_review → auto_bill, (4) approve refuses
>   auto_bill → 409, (5) classification grouping order
>   (needs_approval < manual_review < auto_bill < null),
>   (6) integration: loadAdminQueue + buildWorkSummary still
>   work after the endpoint change. Uses a synthetic contract
>   under ZipKit with run-tagged pending_charges, full cleanup
>   in try/finally.

> **Slice 21 landed on top of Slice 20.** Per-contract invoice
> generation via the scheduled_jobs runner is now real. The billing
> chain is self-perpetuating: provision a monthly contract, the
> first job is seeded, each run generates a draft invoice and
> queues the next cycle. What Slice 21 made real:
>
> - **Per-contract handler path.** The `generate_invoices` handler
>   now reads `contract_id` from the job payload and generates for
>   that one contract only. Legacy jobs without `contract_id` fall
>   through to the existing `generateRecurringInvoices` batch path.
> - **Classification-aware charge sweep.** `getPendingChargesForContract`
>   now filters: `classification IS NULL OR classification NOT IN
>   ('needs_approval', 'manual_review')`. Only `auto_bill` and
>   legacy/null-classified charges get swept into the draft invoice.
>   `needs_approval` and `manual_review` charges stay unbilled
>   until Cody acts on them (Slice 20 approve or delete).
> - **Locked-period guard.** `generateInvoiceForContract` now
>   queries for any client period whose date range overlaps the
>   billing period and has `locked_at IS NOT NULL`. If found, it
>   throws with the lock timestamp so the handler halts honestly.
> - **Idempotent re-enqueue.** On success or dedupe-skip, the
>   handler queues the next `generate_invoices` job for this
>   contract via `nextBillingRunIso`, checking first that no
>   pending/running job already exists for the same contract_id.
>   On failure (locked, not found, tx error), no re-enqueue —
>   the chain halts and `missing_automation` in the admin queue
>   surfaces the gap.
> - **Invoice dedupe.** One invoice per `(contract_id,
>   billing_period_start, billing_period_end)` via the existing
>   `invoiceExistsForPeriod` check + UNIQUE constraint. Running
>   the job twice for the same period returns null on the second
>   run, no duplicate invoice.
> - **Draft status only.** Invoices are created as `status='draft'`.
>   No auto-send. Cody reviews and marks sent manually (Slice 20's
>   admin queue surfaces drafts for review).
> - **Seeding already done.** `provisionContract` already enqueued
>   the first per-contract job (contracts.ts lines 344-356). No
>   provisioning code was changed.
> - **No schema changes.** No migration, no new table, no new
>   column, no new endpoint, no new job type.
> - **No quiz changes.**
>
> **Exact files touched by Slice 21:**
>
> - `src/lib/billing.ts` — edit. `getPendingChargesForContract`
>   now filters out `needs_approval` and `manual_review` charges
>   via an added `AND (classification IS NULL OR classification
>   NOT IN ('needs_approval', 'manual_review'))` clause.
>   `generateInvoiceForContract` now has a locked-period overlap
>   guard between the `invoiceExistsForPeriod` dedupe check and
>   the transaction: queries `periods` for any locked row whose
>   date range overlaps the billing period, throws if found.
> - `src/lib/jobs/runner.ts` — edit. `generate_invoices` handler
>   now checks for `contract_id` in payload. Per-contract path:
>   loads contract, validates active/monthly, calls
>   `generateInvoiceForContract`, idempotently re-enqueues next
>   cycle on success/skip, returns "failed:" string on error
>   (no re-enqueue). Added imports for `generateInvoiceForContract`
>   and `getContract`. Legacy batch path unchanged.
> - `scripts/phase1-test-slice21-invoice-gen.ts` — new. Seven
>   assertion blocks: (1) clean recurring-only invoice with correct
>   total and one line item, (2) auto_bill charge swept in +
>   needs_approval stays unbilled + correct total 1050, (3)
>   duplicate run returns null + one invoice per period, (4)
>   re-enqueue idempotency (one pending job per contract), (5)
>   locked period blocks generation with honest error, (6)
>   manual_review stays unbilled, (7) integration: admin queue
>   drafts section and work summary reflect the new draft. Uses
>   a synthetic contract under ZipKit with billing_day pegged to
>   today's UTC date, run-tagged charges, full cleanup in
>   try/finally.

> **Slice 22 landed on top of Slice 21.** The invoice reminder
> sweep is now self-perpetuating. The entire reminder pipeline
> (`planDueReminders`, `sendDueReminders`, `nextReminderTick`,
> `markReminderTickSent`, `resolveReminderRecipients`) was already
> real before this slice — Slice 22 only closed the scheduling
> loop. What Slice 22 made real:
>
> - **`ensureReminderSweepQueued` helper in `runner.ts`.**
>   Idempotent: checks for any pending/running `send_reminders`
>   job (excluding the caller's own id). If none exists, enqueues
>   one ~24h from now. One pending sweep at a time, same pattern
>   as `ensureStaleSweepQueued`.
> - **`send_reminders` handler now self-perpetuates.** Calls
>   `ensureReminderSweepQueued(job.id)` on every run, so each
>   daily sweep queues the next one. Chain is self-healing: if
>   a run fails, the runner marks the job failed, but the next
>   `generate_invoices` success will re-seed the sweep.
> - **`generate_invoices` per-contract handler seeds the sweep.**
>   On success, calls `ensureReminderSweepQueued()` so the first
>   invoice generation automatically starts the reminder chain.
>   No manual seed required.
> - **No new job type.** `send_reminders` was already a real job
>   type with a real handler. No payload needed — it's a sweep
>   that checks all sent+unpaid invoices.
> - **Tick-level idempotency already built.** Each tick (`before:3`,
>   `after:3`, `after:7`) is recorded in `reminder_ticks_sent_json`
>   on the invoice. `nextReminderTick` skips already-sent ticks.
>   Running the sweep twice on the same day sends zero duplicate
>   emails.
> - **Cancellation already built.** `planDueReminders` queries
>   `WHERE status = 'sent' AND amount_paid < total`. Paid invoices
>   (amount_paid >= total) and non-sent invoices (voided/deleted/
>   draft) are excluded automatically.
> - **Contact routing already built.** `resolveReminderRecipients`
>   — 3-layer fallback: billing-role contacts → primary_contact_email
>   → portal users.
> - **No schema changes.** No migration, no new table, no new
>   column, no new endpoint, no new job type.
> - **No dead scaffolding.** Every function in the reminder
>   pipeline was real and complete before this slice.
> - **No quiz changes.**
>
> **Exact files touched by Slice 22:**
>
> - `src/lib/jobs/runner.ts` — edit. Added exported
>   `ensureReminderSweepQueued(excludeJobId?)` helper above
>   `ensureStaleSweepQueued`. Updated `send_reminders` handler
>   signature to accept `job` and call
>   `ensureReminderSweepQueued(job.id)` after
>   `sendDueReminders()`. Updated `generate_invoices`
>   per-contract success path to call
>   `ensureReminderSweepQueued()` after the invoice re-enqueue.
> - `scripts/phase1-test-slice22-invoice-reminders.ts` — new.
>   Six assertion blocks: (1) `planDueReminders` returns expected
>   `before:3` tick for a synthetic sent invoice with due date
>   3 days out, (2) `markReminderTickSent` records the tick and
>   prevents re-planning, (3) paid invoice excluded from plan,
>   (4) `ensureReminderSweepQueued` enqueues one job and is
>   idempotent on second call, (5) default reminder rule applies
>   after tick reset, (6) integration: admin queue + work summary
>   still work. Uses a synthetic contract + sent invoice under
>   ZipKit with far-future billing period, full cleanup in
>   try/finally.

> **Slice 23 landed on top of Slice 22.** Between Slice 22 and
> Slice 23 the unrelated commit `a22ebc0` ("Add blog with articles
> and case studies") was added — it is not part of any numbered
> portal slice, Slice 23 does not depend on it, and it introduces
> only pre-existing blog-collection warnings during `astro build`
> (not failures). Slice 22 closed the reminder sweep's self-
> perpetuating loop; Slice 23 closes the matching silent-failure
> hole: a perpetual chain with zero deliverable recipients is
> strictly worse than no chain because it consumes job slots and
> looks live in logs without ever producing a delivery. What
> Slice 23 made real:
>
> - **New admin-queue section `missing_billing_contact`.**
>   Surfaces active recurring contracts whose 3-layer
>   `resolveReminderRecipients` fallback would return an empty
>   recipient array. One row per at-risk contract — multiple
>   at-risk contracts under the same client do not collapse
>   because the fix lives at the contract level (commercial
>   truth is per-contract even when contacts are per-client).
> - **Rules delegate directly to `resolveReminderRecipients`.**
>   No parallel implementation, no SQL rewrite of the fallback
>   logic. The health classifier calls the same helper
>   `billing.ts:518-521` uses with the same caller-side glue
>   (`getUsersByClientId` + `getClientProfile.primary_contact_email`).
>   Empty return from that function ⇒ all three layers produced
>   zero recipients ⇒ surface. Any future shift in how
>   recipients are assembled flows through this module with
>   zero edit.
> - **Per-client cache.** N at-risk contracts under one client
>   resolve the fallback once, not N times. `Map<clientId,
>   recipients[]>` inside `loadMissingBillingContactSection`.
> - **Candidate filter:** `contracts.status = 'active' AND
>   contracts.billing_cadence IN ('monthly', 'milestone')`.
>   One-time contracts excluded (single invoice, no perpetual
>   chain to break). Non-active statuses (`draft`, `sent`,
>   `completed`, `cancelled`) excluded (can't invoice, can't
>   produce reminders). NULL cadence excluded (no invoicing
>   path defined).
> - **Silence conditions:** any one of the three fallback layers
>   populated = silent.
>   - Layer 1: any active contact with `receives_reminders=1`
>     and `roles_json` containing `billing` or `primary`
>   - Layer 2: `clients.primary_contact_email` non-null/non-empty
>   - Layer 3: any row in `users` with `client_id` = this client
> - **Wired into `loadAdminQueue` between
>   `csv_source_attention` and `lockedPeriodsSection`.** Same
>   position in the sections[] assembly array. The existing
>   count-assembly loop exposes `queue.counts.missing_billing_contact`
>   automatically.
> - **`SECTION_MAP` entry:** `{ bucket: 'actNow', severity: 12,
>   label: 'contracts with no reminder route' }`. Slotted
>   directly after `csv_source_attention` (severity 11) to keep
>   the silent-failure canary neighborhood contiguous.
> - **Slice 19 work-summary coverage updated.** `allSections`
>   array gained `'missing_billing_contact'`; `actNow` expected
>   length 12→13; total 17→18; `MAPPED_SECTION_KEYS.length`
>   17→18. All ten Slice 19 assertions stay green.
> - **No schema changes.** No migration, no new column, no new
>   table, no new endpoint, no new job type.
> - **No quiz changes.** Blog commit was not touched.
>
> **Exact files touched by Slice 23:**
>
> - `src/lib/jobs/billing-contact-health.ts` — new. Exports
>   `loadMissingBillingContactSection(): Promise<QueueSection>`.
>   Owns the candidate SELECT (status=active AND billing_cadence
>   IN monthly/milestone, JOIN clients for name), a per-client
>   `Map<clientId, recipients[]>` cache, `resolveForClient()` that
>   mirrors the caller-site glue from `billing.ts:515-521`
>   exactly, and a single classifier: empty recipients ⇒ emit a
>   `QueueRow`, non-empty ⇒ silent. Reuses `QueueSection` and
>   `QueueRow` types from `admin-queue.ts` without importing
>   anything else from that module. Does not re-implement the
>   fallback rules — the single source of truth for reminder
>   routing remains `resolveReminderRecipients` in
>   `src/lib/clients.ts:344`.
> - `src/lib/admin-queue.ts` — 3-line additive edit. Added the
>   import, one `await loadMissingBillingContactSection()` call
>   between `csvSourceAttention` and `lockedPeriodsSection`, and
>   one entry in the `sections[]` assembly array in the same
>   position. The comment block above the new call was added and
>   the `lockedPeriodsSection` comment header renumbered from
>   `13.` to `14.`. Nothing else in the file changed.
> - `src/lib/admin-work-summary.ts` — one `SECTION_MAP` entry:
>   `missing_billing_contact: { bucket: 'actNow', severity: 12,
>   label: 'contracts with no reminder route' }`. No logic
>   change to `buildWorkSummary`. The `MAPPED_SECTION_KEYS`
>   export automatically reflects the new key.
> - `scripts/phase1-test-slice19-work-summary.ts` — coverage
>   assertion refresh. Added `'missing_billing_contact'` to the
>   `allSections` array in the 19.9 full-bucket-assignment case;
>   bumped `s.actNow.length` expected 12→13, `total` 17→18,
>   `MAPPED_SECTION_KEYS.length` 17→18. No other cases changed.
> - `scripts/phase1-test-slice23-billing-contact-health.ts` —
>   new. Eight assertion blocks: (1) bare active monthly
>   contract with no contacts, no primary_contact_email, no
>   portal users surfaces with the expected `what`/`where`/
>   `why`/`link` shape, (2) active monthly + billing-role
>   contact silences the row (layer 1 populated), (3) active
>   monthly + `primary_contact_email` silences (layer 2), (4)
>   active monthly + portal user silences (layer 3), (5) active
>   one-time contract with all three layers empty stays silent
>   via the cadence filter, (6) monthly contract with
>   `status='completed'` stays silent via the status filter,
>   (7) integration: `loadAdminQueue()` exposes the new section
>   with correct key, `queue.counts.missing_billing_contact` is
>   a number, existing `google_sync_attention` and
>   `csv_source_attention` sections still present, (8)
>   integration: `buildWorkSummary(queue)` places the item in
>   the `actNow` bucket with label "contracts with no reminder
>   route" and does NOT place it in `waiting` or `upcoming`.
>   Uses six synthetic clients (A..F) created via direct
>   `INSERT INTO clients` — not ZipKit — because ZipKit already
>   has portal users and `primary_contact_email` that would
>   suppress every at-risk case. Each scenario's contract is
>   provisioned via `provisionContract`, its auto-seeded
>   `generate_invoices` job is deleted immediately, and full
>   teardown of contracts/contacts/users/periods/clients runs
>   in try/finally.

> **Slice 24 landed on top of Slice 23.** `clients.brand_accent`
> is no longer a dead field. Pre-Slice-24 the captured intake
> value drove exactly one render surface — the thin strip at the
> top of the desktop sidebar. Slice 24 extends the accent across
> every client-facing portal page without changing the load path,
> introducing a theming system, or touching body copy. What
> Slice 24 made real:
>
> - **Five decorative utility classes in `src/styles/portal.css`.**
>   `portal-accent-text`, `portal-accent-bg-soft`,
>   `portal-accent-border`, `portal-accent-bar`, and
>   `portal-hover-accent`. Each consumes
>   `var(--brand-accent, rgb(251 191 36))` so admins and clients
>   without a brand_accent set continue to see amber (the
>   pre-Slice-24 appearance is byte-for-byte preserved).
> - **Load path is unchanged from the pre-existing sidebar
>   strip.** `clients.brand_accent` → `getClientProfile` in
>   `src/lib/clients.ts` → `middleware.ts:155-160` →
>   `Astro.locals.brandAccent` → `Portal.astro` hex re-validation
>   via `/^#[0-9a-fA-F]{6}$/` (defense-in-depth against a
>   poisoned DB value) → inline `style="--brand-accent: {hex}"`
>   on `<body>`. No new locals, no new middleware hook, no new
>   validator, no new DB call.
> - **Render surfaces extended (10):** desktop active nav pill;
>   mobile active nav pill; sidebar title ("Cody Smith") hover;
>   Notifications link active + hover; "Back to website" hover;
>   new `h-0.5` accent strip at the top of the mobile
>   `<header>`; new `h-px w-16` accent bar at the top of
>   `<main>` (inherited by every client page that uses the
>   Portal layout); dashboard "page 1" KPI card (gradient +
>   border + 3xl heading number + 10px sublabel); dashboard
>   "ALL KEYWORDS →" and "FULL REPORT →" hover links; eyebrow
>   labels on `/portal/health`, `/portal/keywords`, and
>   `/portal/files`.
> - **Null-fallback is honest.** `brandAccent === null` →
>   `<body>` has no `style` attribute → `--brand-accent` is
>   undefined → every `portal-accent-*` / `portal-hover-accent`
>   class falls through to amber-400 via the `var()` fallback
>   → the conditional strips (sidebar, mobile header, main)
>   don't render at all. Admins always have `brandAccent =
>   null` (middleware sets it only for users with `client_id`),
>   so the admin portal is byte-for-byte unchanged.
> - **Intentionally out of scope, not drift.** The solid-fill
>   upload button on `/portal/files` stays literal amber-500 —
>   a client-chosen accent would change the background but not
>   the `text-neutral-950` label, risking unreadable black text
>   on a dark brand accent. Semantic status badges (`partial`
>   invoice, `on_hold` project, medium-priority health
>   indicator, keyword-position tier badges) also stay literal
>   amber because the color there carries meaning, not
>   decoration. Both exclusions are called out in the
>   `portal.css` comment block.
> - **Known limitation.** The wizard's hex validator
>   (`parseClientProfileInput` in `src/lib/clients.ts:56-61`
>   and the re-validation in `Portal.astro:25-26`) enforces
>   shape only, not contrast against the dark portal canvas.
>   A client who picks a near-background color (`#000000`,
>   extremely dark hex) will see accent surfaces vanish —
>   the pre-Slice-24 sidebar strip had the same limitation
>   and Slice 24 inherits it. A contrast-safe clamp or a
>   palette constraint in the wizard would be a separate
>   queued follow-on if clients in practice pick accents
>   that bleed into the canvas.
> - **No test file added.** Honest call: the slice is purely
>   visual. The only pure-function logic is the hex regex
>   already enforced in two places; extracting it to write a
>   test would re-assert a regex shape without verifying the
>   render. Runtime verification is a browser click-through:
>   set `clients.brand_accent` on a test client, log in as
>   that client's portal user, confirm the 10 extended
>   surfaces light up; unset and confirm amber returns; log
>   in as admin and confirm byte-identical pre-Slice-24
>   styling.
> - **No schema changes.** No migration, no new column, no
>   new table, no new endpoint, no new job type.
> - **No quiz changes.** No blog changes.
>
> **Exact files touched by Slice 24:**
>
> - `src/styles/portal.css` — edit. Added a comment block that
>   documents the slice, the load-path reminder, the
>   intentional exclusions (solid-fill buttons, semantic
>   status badges), and the known contrast-clamp limitation.
>   Added the five utility-class rules
>   (`portal-accent-text`, `portal-accent-bg-soft`,
>   `portal-accent-border`, `portal-accent-bar`,
>   `portal-hover-accent`). No existing rule was modified or
>   removed — the file's animation keyframes and helper
>   classes from earlier slices are untouched.
> - `src/layouts/Portal.astro` — edit. `linkClass` and
>   `mobileLinkClass` helpers now return
>   `portal-accent-bg-soft portal-accent-text` for the active
>   state instead of `bg-amber-500/10 text-amber-400`. The
>   pre-existing sidebar strip (`<div class="h-0.5 w-full">`)
>   switched from an inline `style="background: ${brandAccent}"`
>   to the new `portal-accent-bar` class — one less inline
>   style, one more class reuse. The orphan `--hover-accent`
>   custom property on the sidebar title anchor was removed;
>   that anchor now uses `portal-hover-accent` which consumes
>   `--brand-accent` directly, one source of truth. The
>   Notifications link active/hover state and the
>   "Back to website" link both switched to the new classes.
>   Added one conditional
>   `<div class="md:hidden h-0.5 w-full portal-accent-bar">`
>   at the top of the mobile content column (mirror of the
>   desktop sidebar strip, for mobile users). Added one
>   conditional `<div class="h-px w-16 portal-accent-bar
>   mb-6 -mt-4">` inside `<main>`, above the `<slot />`, so
>   every client page inherits a short top-of-content accent
>   bar.
> - `src/pages/portal/dashboard.astro` — edit. The "page 1"
>   KPI card (middle of three sibling stat cards with
>   emerald / amber / neutral themes) had its amber classes
>   rewritten: container gradient and border now use
>   `portal-accent-bg-soft` + `portal-accent-border`, the
>   `text-3xl font-bold` headline uses `portal-accent-text`,
>   the 10px sublabel uses `portal-accent-text opacity-60`
>   (preserving the original 50%-opacity look). The two
>   hover-tail links ("ALL KEYWORDS →", "FULL REPORT →")
>   switched from `hover:text-amber-400` to
>   `portal-hover-accent`. The emerald top-3 card and the
>   neutral reach card on either side of the amber card were
>   deliberately not touched — they carry different semantic
>   colors.
> - `src/pages/portal/health.astro` — edit. The "Technical
>   Audit" eyebrow label's `text-amber-400` changed to
>   `portal-accent-text`. No other class on the page was
>   touched — the health-status badges (Good / Fair / Needs
>   work) and priority dots keep their semantic colors.
> - `src/pages/portal/keywords.astro` — edit. The "Search
>   Visibility" eyebrow label's `text-amber-400` changed to
>   `portal-accent-text`. The keyword-position tier badges
>   (emerald for top-3, amber for page-1, neutral for page-2+)
>   keep their semantic colors — those amber classes were
>   deliberately not touched.
> - `src/pages/portal/files.astro` — edit. The "Deliverables"
>   eyebrow label's `text-amber-400` changed to
>   `portal-accent-text`. The solid-fill upload button
>   (`bg-amber-500 text-neutral-950`) was deliberately not
>   touched — see contrast-risk note in the portal.css
>   comment block.

> **Slice 25 landed on top of Slice 24.** The original ask explicitly
> included "updates on tasks." The admin milestone edit surface
> (`PUT /portal/api/admin/milestones/[id]`), the `client_update_text`
> column (Slice 11 seed), and the `client_visible` flag were all real
> before this slice — what was missing was a top-of-dashboard read
> surface that translates that truth into plain 7th-grade-reading-
> level sentences the client sees when they log in. `/portal/projects`
> covers the deep view; the dashboard block covers glance-level state.
> What Slice 25 made real:
>
> - **Three-bucket progress summary on `/portal/dashboard`.**
>   "Now" (inProgress), "Recently" (justFinished), "Next" (comingUp)
>   — each is an optional string on the `ProgressSummary` return
>   shape with a `hasAny: boolean` flag that drives the render
>   gate. When all three are empty, the dashboard renders nothing
>   (no "no updates" placeholder). Block is wrapped in a
>   `max-w-[640px]` card and slots between the narrator section
>   and the Slice 18c traffic summary.
> - **Rules (one row per bucket):**
>   - `inProgress`: first `milestones.status = 'in_progress'`
>     row, `ORDER BY sort_order ASC, id ASC LIMIT 1`. Sentence
>     `"Working on {client_update_text || title}"`.
>   - `justFinished`: most recent
>     `milestones.status = 'completed'` row where
>     `completed_at >= datetime('now','-30 days')`,
>     `ORDER BY completed_at DESC LIMIT 1`. Sentence
>     `"Just finished {client_update_text || title}"`.
>   - `comingUp`: first `milestones.status = 'not_started'`
>     row, `ORDER BY (due_date IS NULL) ASC, due_date ASC,
>     sort_order ASC, id ASC LIMIT 1` (NULLS LAST via CASE).
>     Sentence `"Coming up: {client_update_text || title}"`.
>   - `on_hold` / `cancelled` / `draft` statuses are excluded
>     — they are not honest in-flight narrative.
> - **Three-layer client-visibility filter, hard.** Every loader
>   applies `milestones.client_visible = 1
>   AND projects.client_visible = 1
>   AND contracts.status = 'active'`. Internal-only rows never
>   reach the client. Contracts that are `draft`, `sent`,
>   `completed`, or `cancelled` never contribute milestones —
>   a post-contract milestone would create a false "coming up"
>   promise. This mirrors the access pattern used by
>   `/portal/projects` and the narrator's
>   `loadRecentCompletedMilestone`.
> - **Plain-language rules.** `client_update_text` is preferred
>   when present and non-whitespace; empty or null falls back
>   to `title`. The three sentence templates use "Working on",
>   "Just finished", "Coming up:" — no jargon, no percentages,
>   no fake statuses, no pluralization. 7th-grade reading
>   level matches the voice rule enforced across the narrator
>   and the Slice 17 summaries.
> - **No narrator rewrite.** Considered adding progress as a
>   narrator candidate fact and rejected — the narrator picks
>   one sentence by priority, and progress needs to surface
>   three buckets at once. A narrator fact would lose that
>   structural clarity. The dashboard block is additive to
>   the narrator, not a replacement.
> - **No new page.** Considered a new `/portal/progress` page
>   and rejected — `/portal/projects` already renders the
>   complete milestone detail surface (active, upcoming,
>   completed, with tasks and client_update_text) and adding
>   another page would fragment client navigation.
> - **No new admin surface.** Admin-side milestone status
>   writes already exist at `/portal/api/admin/milestones/[id]`
>   (PUT with `status`/`client_visible`/`client_update_text`/
>   `due_date`/`sort_order`/`title`/`description`, auto-stamps
>   `completed_at`, calls `onMilestoneCompleted` trigger, logs
>   activity). Slice 25 reads from that truth — it does not
>   add new writes.
> - **No schema changes.** No migration, no new column, no
>   new table, no new endpoint, no new job type.
> - **No admin-queue / SECTION_MAP / work-summary touches.**
>   This is a client-facing slice. The admin-queue
>   `overdue_milestones` and `upcoming_milestones` sections
>   are distinct concerns (admin operational pressure) and
>   were not modified.
> - **No brand-accent / blog / quiz changes.**
>
> **Exact files touched by Slice 25:**
>
> - `src/lib/client-progress-summary.ts` — new. Exports the
>   `ProgressSummary` interface and
>   `buildProgressSummary(clientId: string, contractId?: string)
>   : Promise<ProgressSummary>`. Three independent loaders
>   (`loadInProgress`, `loadJustFinished`, `loadComingUp`)
>   each run the same three-layer client_visible +
>   active-contract filter and return a single `MilestoneRow`
>   or null. The public builder runs them in parallel via
>   `Promise.all` and assembles sentences via the `copyFor`
>   helper (prefers `client_update_text.trim()` when
>   non-empty, falls back to `title`). Exports
>   `JUST_FINISHED_WINDOW_DAYS = 30` so future slices can
>   dial the recency window in one place without changing
>   rule logic. Optional `contractId` scopes each loader to
>   a single contract; omitted, the loader surveys every
>   active contract under the client.
> - `src/pages/portal/dashboard.astro` — edit. Added one
>   import (`buildProgressSummary`, `ProgressSummary`),
>   one await call gated on `selectedClientId`, one
>   `progressSummary` variable assigned only when
>   `p.hasAny === true` (so the render path reads a single
>   null-check), and a 28-line `{progressSummary && ...}`
>   `<section>` block between the narrator section
>   (closes at line ~171) and the Slice 18c traffic summary
>   (opens at line ~174 pre-edit). The block uses NOW
>   (blue), RECENTLY (emerald), NEXT (neutral) typographic
>   labels. Existing narrator / traffic / KPI blocks are
>   unchanged.
> - `scripts/phase1-test-slice25-progress-summary.ts` — new.
>   Nine assertion blocks: (1) in_progress only → inProgress
>   set, others undefined; (2) recently completed only →
>   justFinished set; (3) completed outside the 30-day window
>   → excluded, `hasAny=false`; (4) not_started only →
>   comingUp set; (5) mixed state → all three populated; (6)
>   all `client_visible=0` → `hasAny=false`; (7) contract
>   with `status='completed'` → excluded even with an
>   `in_progress` milestone; (8) `client_update_text`
>   preferred over `title` — title must not leak into the
>   sentence; (9) null / whitespace-only `client_update_text`
>   falls back to title. Uses one synthetic client per
>   scenario (9 total, direct `INSERT INTO clients` because
>   ZipKit already has real milestones that would
>   cross-pollinate), direct INSERTs for contract + project
>   + milestones (no `provisionContract` defaults to fight),
>   and full teardown in try/finally of
>   milestones/projects/activity_log/contracts/clients.

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
- **Slice 19** — admin work-summary rail (`buildWorkSummary` pure function,
  three-bucket triage on `/portal/admin`, act-now/waiting/upcoming from
  existing queue truth, no schema changes, no new task system)
- **Slice 20** — billing-input visibility on `/portal/admin/expenses`
  (classification badges, approve for needs_approval + manual_review,
  classification-priority sort, summary count strip, client context)
- **Slice 21** — per-contract invoice generation (classification-aware
  charge sweep, locked-period guard, idempotent re-enqueue, draft-only
  output, no schema changes, no new job types)
- **Slice 22** — self-perpetuating invoice reminder sweep
  (`ensureReminderSweepQueued`, `send_reminders` daily re-enqueue,
  seeded from `generate_invoices` on success, no new job types)
- **Slice 23** — admin-queue signal for contracts with no reminder
  route (`loadMissingBillingContactSection`, delegates to
  `resolveReminderRecipients`, per-client cache, `actNow` severity
  12, no new job types, no schema changes). Closes the silent-
  failure hole in Slice 22's perpetual sweep.
- **Slice 24** — brand accent extended from the sidebar strip to
  every client-facing portal surface (five `portal-accent-*`
  utility classes consuming `var(--brand-accent, rgb(251 191 36))`,
  active nav pills + hover states + eyebrow labels + dashboard
  KPI card + mobile header + top-of-main strips, null-fallback
  preserves pre-Slice-24 amber, admins and body copy untouched,
  no schema changes, no test file). Turns `clients.brand_accent`
  from a single-surface field into real portal-wide personalization.
- **Slice 25** — client-facing milestone progress summary on the
  dashboard (`buildProgressSummary`, three buckets Now / Recently /
  Next, three-layer `client_visible + active-contract` filter,
  30-day justFinished recency window, `client_update_text || title`
  sentence rule, `hasAny=false` empty state renders nothing,
  no schema changes, no new endpoints, no narrator rewrite).
  Turns the existing `milestones` table into real client-facing
  narrative about "what's being worked on" — the original ask's
  "updates on tasks" requirement.

> Between Slice 22 and Slice 23, commit `a22ebc0` ("Add blog with
> articles and case studies") landed. It is not a numbered portal
> slice, not a portal-product change, and Slices 23 and 24 do not
> depend on it. Listed here only so the branch log reads honestly.

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
7. **Preview-mode brand accent for admins.** Admins never have a
   `client_id`, so the middleware never loads an accent for them.
   Previewing a specific client's branded portal would require a
   per-request `?client_id=` override. Separate from Slice 24.
8. **Wizard "edit staged block".** Staged contract blocks can only be
   removed, not edited.
9. **Traffic summary surfaces beyond the dashboard.** No
   `buildTrafficSummary` render on `/portal/keywords` or in the narrator
   beyond slice 1/3 fact selection.

> Previously listed gaps that are now closed:
>
> - "Admin queue 'missing billing contact' hygiene signal" — closed
>   by Slice 23.
> - "Brand accent beyond the sidebar strip" — closed by Slice 24.

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
   18, 18b, 18c, 18d, 18e, 18f, 18g, 18h, 18i, 19, 20, 21, 22, 23, 24, 25 are
   closed. Reopening them requires a concrete failing assertion or a
   reproducible bug in the live product.
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

Cody determines the next slice. The admin work-summary rail is now live.
Possible next moves based on the repo's current open gaps:

1. **GA4 property picker endpoint** — small `POST /portal/api/admin/google/ga4-properties`
   so Cody doesn't have to paste the numeric property ID manually.
2. **Traffic summary on `/portal/keywords`** — `buildTrafficSummary` render
   beyond the dashboard. Zero new backend.
3. **Source/medium/channel-grouping breakdowns** in GA4 — totals only for now.
4. **Wizard "edit staged block"** — staged contract blocks can only be
   removed, not edited.
5. **Preview-mode brand accent for admins** — Slice 24 extended accent
   consumption site-wide, but admins still see default amber since the
   middleware only loads brand_accent for users with a `client_id`.

Production-dependent gaps (need Cody's action first): real OAuth consent,
real GSC + GA4 API round-trips, real token refresh edge cases.
