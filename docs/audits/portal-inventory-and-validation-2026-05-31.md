# Portal Inventory and State Validation — 2026-05-31

Read-only audit of the codyasmith.com portal across three sources: files (the repo), ClickUp, and GitHub. Goal: list everything, then validate each item's real state. No prod calls, no mutations, no edits, no pushes were made to produce this.

## Method and ground truth

- 11 read-only agents (Explore type, cannot mutate). Sources walked: repo at `C:\Users\codya\projects-clean\codyasmith.com`, the ClickUp build/ops + client lists, GitHub (`codyasmith1987/codyasmith.com`).
- Ground truth confirmed directly this session: `main` HEAD = `64bf935` (PR #247), working tree clean except 4 intentional untracked items (`.claude/`, the 2026-05-28 session record, `standard-v6.md`, `053-seed-standard-v6.ts`). GitHub: 0 open PRs, 0 open issues. 40 remote branches.

**Confidence rules used (so nothing reads as more certain than it is):**
- "Code present" = verified by reading the file. High confidence.
- "NOT IMPLEMENTED / NOT FOUND" = an absence claim from searching. Lower confidence than a presence claim; treat as "the audit found no code, worth a confirm" not "proven absent."
- "Prod-verified" cannot be established by reading code. Where the handoff claims it, this doc records "code present, claimed prod-verified, NOT re-verified live."

---

## 1. What exists (inventory)

### 1.1 Portal pages and surfaces — 43 routes (all under `src/pages/portal/`, SSR, auth-gated)

**Public (pre-auth):** `/portal/login`, `/portal/set-password`.

**Client-facing:** `/portal/dashboard`, `/projects`, `/approvals`, `/invoices`, `/keywords`, `/traffic`, `/health`, `/search`, `/security`, `/documents`, `/files`, `/notifications`, `/proposals/[slug]`, `/contracts/[slug]`, `/contracts/[slug]/print`, `/contracts/preview/[proposalSlug]`. (Client-facing pages allow admin override via a ClientSelector component.)

**Admin-gated:** `/admin/activity`, `/admin/approvals`, `/admin/contracts` (+ `/[id]`), `/admin/invoices` (+ `/[id]`), `/admin/users`, `/admin/clients`, `/admin/proposals` (+ `/new`, `/snippets`, `/raised-bar`), `/admin/agreements` (+ `/[id]`, `/new`), `/admin/milestones/[id]`, `/admin/tasks/[id]`, `/admin/projects/[id]`, `/admin/change-orders`, `/admin/csv`, `/admin/at-signing-awaiting`, `/admin/notifications`.

Out of scope (personal site, untouched): `Quiz.astro`, quiz engine, `_backup/quiz-bg-*`, blog collection + `/blog/*`.

### 1.2 API endpoints — 77 catalogued, plus ~20 found later by the coverage critic (~97 total)

Catalogued breakdown: 6 public marketing, 9 auth/self-service, 9 contracts/agreements, 7 billing/invoices, 6 projects/milestones/tasks, 9 users/clients, 8 Cloudflare, 6 client-facing, 9 dashboard/metrics, 2 cron/batch.

**Endpoints the first pass MISSED (coverage critic found, confirmed present):**
- `POST /portal/api/admin/agreements/backfill-billing-contracts` (one-shot backfill, dry-run default)
- `GET /portal/api/admin/backfill-client-sites` (one-shot site/page-count backfill)
- 5 CSV admin utilities: `csv/clear-all-for-client`, `clear-failed`, `clear-garbage-issues`, `clear-superseded`, `delete-upload`
- `GET` list variants: `admin/invoices` (index), `admin/milestones` (index)
- `DELETE` on `admin/proposals/[slug]`
- `GET /portal/api/admin/schema-diagnostic` (purpose unread)
- `GET /portal/api/admin/test-fixtures/cody-test/reset` — **a fixture-reset endpoint live on the production app; flag for a security/scope confirm**
- Contract execution: `POST /contracts/[slug]/intake`, `POST /contracts/[slug]/sign`
- Dashboard: `dashboard/ga4`, `dashboard/gsc`, `dashboard/issues`, `dashboard/score`
- Files: `files/download`, `files/issue`
- `POST /portal/api/request-data-update`

### 1.3 Library subsystems (`src/lib`, ~55 modules)

- **Billing/invoicing:** `billing.ts`, `billing-proration.ts`, `invoices.ts`
- **Contracts/agreements:** `contracts.ts`, `contract-schedule.ts`, `contract-templates.ts`, `contract-render.ts`, `contract-pdf.ts`, `contract-emails.ts`, `contract-handoff.ts`, `agreements.ts`
- **Proposals/pricing/products:** `proposal-pricing.ts`, `proposal-drafts.ts`, `products/*` (registry + composer + web-management/build/marketing-consulting/training/other-sow), `narrative-snippets.ts`, `proposal-configs/raised-bar.ts`
- **Proposal AI (Gemini):** `proposal-ai/` (gemini-client, cache, voice-lint, research/, build/ description+option-pitch+phase-body), `naming/*`, `scraper.ts`
- **Ingestion (CSV):** `csv/` framework + detector + 30+ format parsers (Screaming Frog, GA4, GSC, position-tracking, keyword-research/suggestions, content/security/structured-data/accessibility, issues-overview, raw fallback, `_bulk-insert`, `_url-parser-helpers`), `raised-bar-f3-ingest.ts`
- **Read layers:** `ga4-read.ts`, `gsc-read.ts`, `crawl-read.ts`
- **Reports:** `reports/performance-summary.ts`, `windows.ts`, `deltas.ts`, `site-health.ts`, `_shared.ts`, `report-pdf.ts`
- **Clients/sites/CF:** `client-domains.ts`, `client-sites.ts`, `cloudflare.ts`, `data-update-requests.ts`
- **Platform:** `turso.ts`, `db.ts`, `migrate.ts`, `migrations/*`, `auth.ts`, `notifications.ts`, `triggers.ts`, `activity.ts`, `email.ts`/`email-safety.ts`, `funnel-emails.ts`, `rate-limit.ts`, `security-headers.ts`, `csrf.ts`, `storage.ts`, `pdf.ts`, `logger.ts`, `request-log.ts`, `retention.ts`, `url-classifier.ts`, `admin-status-styling.ts`, `middleware.ts`
- **Legacy/public-funnel:** `sentiment.ts`/`sentiment-gemini.ts`, `growth-field.ts`, `recommend.ts`

### 1.4 Migrations — 53 files, two issues

`001` through `053`, race-safe runner (`migrate.ts`) ordered by id. Span: initial schema → invoices/payments/approvals → naming/listener → proposals/contracts/agreements → per-URL crawl/GA4/GSC/Cloudflare tables → site pricing overrides → issued-reports + data-update-requests.

- **ID COLLISION:** two files share id `053` — `053-issued-reports-and-update-requests.ts` (committed) and `053-seed-standard-v6.ts` (UNTRACKED). The runner orders by id; a duplicate id is a real sequencing hazard. Fix before committing v6: rename the untracked one to `054-seed-standard-v6.ts`. (No `054` exists yet, so the rename is clean.)
- **SEQUENCE GAP:** `048` → `050`. No `049` present. Confirm whether intentionally skipped/removed.

### 1.5 Config, scripts, docs

- `package.json` scripts: dev/build/preview/astro, migrate:naming, migrate:listener, test, test:integration. `build` runs postbuild security-headers wrap + sitemap assert.
- `astro.config.mjs` (Node SSR, sitemap filter excludes /portal/ /api/), `.github/workflows/daily-cron.yml` (POST /api/cron/daily at 13:00 UTC, manual dispatch defaults dry-run).
- `scripts/`: postbuild-security-headers, postbuild-assert-sitemap, seed-admin, seed-dev2-fixtures, set-password, dev-login, find-duplicates, list-uploads, check-rb-domains, migrate-naming, migrate-listener, test-og.
- `docs/`: BUGFIX-LOG, naming specs, session handoffs, 14 security/SEO audit rounds (2026-05-12), proposal-chain audits (05-24/05-25), the untracked 05-28 session record. `.claude/plans/phase-4-monthly-report-pipeline.md`.

### 1.6 ClickUp tasks

**Portal / build / ops lists:**
- `codyasmith.com` (901416702172): 45 tasks, 37 open, 8 complete.
- `Admin — Operations, IP, Business Dev` (901415063425): 25 tasks, 18 open, 7 complete.
- `Go-forward actions from May validation` (901416702174): 3 tasks, all open.
- `n8n automation` (901416702173): 1 task, open.

**Client-engagement lists (deliverables, not portal code):** 129 tasks total — A1 ZKH WM (43), A2 Marketing Consulting (38), A3 MVP WM (26), Admin Billing/Comms ZKH (17), Raised Bar Admin (3), Pro Bono (2). Status mix: 109 complete, 15 to-do, 5 in-progress.

### 1.7 GitHub branches — 40 remote, ALL merged into main

0 active/unmerged remote branches. 28 map to PRs #220-247 (recent portal work). 12 are orphans with no PR record (older Apr-May checkpoints: `checkpoint/slice-18d`, `dev2-isolated`, `dev2-phase1`, `docs-listener-gemini-migration-spec`, `phase0-clean`, `phase1-delivery`, `phase3-naming`, `proposals-phase2/3/4-*`, `raised-bar-proposal`, `wip-visual-changes`). Local stale branches: `redesign-ritual-restart` (worktree at `codyasmith.com-ritual`, behind 27), `dev2-phase1-wm-hours-repricing` (gone), `fix-contract-pdf-passthrough-and-msa-title` (gone), `dev2-phase1-bundled-tier-mode` (no upstream).

---

## 2. Validation — discrepancies and state

### 2.1 Feature claims (handoff "built + prod-verified") — all code-present, none re-verified live

| Claim | Code state | Evidence |
|---|---|---|
| Proposal → contract → billing pipeline | code present | `contract-handoff.ts`, pricing `atSigning`, proposals schema/renderer, contract templates, signing |
| Monthly report pipeline (Phase 4) | code present | `reports/performance-summary.ts`, `site-health.ts`, migration 053 issued-reports + `data-update-requests.ts` (MONTHLY_REQUEST_LIMIT=2), documents surface |
| CSV ingestion parsers (SF/GA4/GSC/Ubersuggest/rank) | code present | `csv/detector.ts` 30+ formats, all parsers present, batched inserts |
| Gemini proposal builder | code present | `proposal-ai/*` + admin AI endpoints |
| Multi-site pricing (10% off / 0.90 + full pooled hours) | code present, canonical | `web-management.ts` MULTI_SITE_DISCOUNT = 0.90 (PR #242). Live `raised-bar-group` proposal is `product_driven_v1` and quotes 0.90. Legacy `raised_bar_v1` (0.80) is frozen/unused. |
| Billing cron (daily 13:00 UTC) | code present | `api/cron/daily.ts` + `daily-cron.yml` |

**Every one of these is "code present, claimed prod-verified, NOT re-verified live."** Confirming they actually work end-to-end in prod needs either a read-only prod call or your eyes — it is not something this audit established.

### 2.2 Status drift (ClickUp vs reality) — low; ClickUp is mostly accurate

Most open portal tasks are genuinely not-built or partial (status is honest). True drift found:
- `Sign the LLC operating agreement` (86ba35afr) and `Legalize the business` (86b96bkxu): likely DONE — `standard-v6.md` names Cody A Smith LLC, Utah entity 14680380-0160, effective April 4, 2026. Confirm and close.
- `Q1 2026 safe-harbor confirmation` (86b9ag6x0): likely OBSOLETE — Q1 ended 2026-03-31.
- Client-side: a couple tasks marked "complete" are worded as pending a Sven decision (`Cookie consent banner — pending Sven Gate #4`, `Privacy Policy — pending Sven Gate #4`). Worth a glance to confirm they're truly closed.

### 2.3 Contract template vs proposal pricing inconsistency (live-portal risk) — RESOLVED 2026-05-31

The live contract template was **v5** (highest seeded version; `getLatestContractTemplate` serves it), and v5 section 3.1 states the old **eighty percent (80%)** additional-site discount with proportional hours. The canonical model is now **10% off (0.90) with full pooled hours** (PR #242), which is what the live `raised-bar-group` proposal (`product_driven_v1`) quotes. So a contract generated on v5 would have stated 80% in its prose while its own Schedule A showed the 90% numbers from the proposal — the contract contradicting the price the client was quoted. The leaked-comment issue compounded it: the renderer stripped only `internal:` blocks, so v5's line-27 HTML comment (an internal audit file path) survived into the rendered client HTML.

Resolution (branch `fix/seed-v6-and-stale-80pct-cleanup`): seeded **v6** (migration `054-seed-standard-v6.ts` + `standard-v6.md`), which states 90% / full pooled hours and removes the leaked comment; hardened `contract-render.ts` to strip ALL HTML comments in client/preview/PDF modes; corrected the stale `0.80` references in the active `product_driven_v1` code path and the AI research prompt. The legacy `raised_bar_v1` formula and the Raised Bar sample config were intentionally left untouched (frozen reference, not used by any live proposal).

**Correction to an earlier draft of this doc:** a prior version of section 2.3 said "v5 states 20%/80%" framed as a stale-template bug and implied the live Raised Bar deal ran on `raised_bar_v1`. The live deal runs `product_driven_v1` (already 90%); `raised_bar_v1` is dead code. The real issue was the template version lag, now closed by seeding v6.

### 2.4 Coverage gaps

~20 endpoints existed outside the first inventory pass (see 1.2), notably the `test-fixtures/cody-test/reset` and `schema-diagnostic` admin endpoints. Several lib files (`scraper.ts`, `admin-status-styling.ts`, `proposal-configs/raised-bar.ts`, `csv` helper files, `reports/_shared.ts`, `middleware.ts`, `content.config.ts`, `env.d.ts`) were not in the first lib pass. All now folded into section 1.

### 2.5 Branch hygiene

40 merged remote branches are prunable; the 28 PR-mapped ones are unambiguously safe to delete, the 12 orphans deserve a 60-second look before deletion. Local stale branches and the `codyasmith.com-ritual` worktree (branch behind 27) can be cleaned. This is housekeeping, not risk.

---

## 3. Improvement opportunities (for "improving existing functions")

Ranked by leverage. The dominant theme: **data is ingested but not surfaced.**

1. **Surface the data already in the DB.** Parsers + tables exist for crawl/redirects/images/content/security headers/structured data/accessibility, but the client health dashboard shows generic counts, not per-issue reading surfaces. ~10 open ClickUp "Surface:" / "Parser:" tasks (86ba36v3e and children) are exactly this. Highest leverage: the ingest cost is already paid; only the read surface is missing. Directly serves the "connect to data, manual entry is the fallback" thesis.
2. **Multi-site Phase 1/2** (86ba3rx5m, 86ba3rx71): site picker on dashboard surfaces + per-site GA4/GSC. `client_sites` infra exists; read layers query by month only, not site_id. Needed before any multi-site client.
3. **Pooled-hours feature** (epic 86ba3vq3q): admin task CRUD exists; missing client `/portal/tasks` + assign UI, overage approval modal/endpoint, low-hours/overage notification emails, and a confirmed period-rollover. Partly built — finishing it closes a billing-integrity loop.
4. **Cloudflare v2 + external cron** (86ba3rx8n/98/9q): scheduled CF sync via a shared-secret endpoint (current sync-all needs admin login), Free-plan firewall-data handling, bot/WAF breakdown.
5. **Contract template v6** — DONE 2026-05-31 (see 2.3). Seeded as migration `054-seed-standard-v6.ts`. NOTE: the "053 migration ID collision" flagged in an earlier draft was NOT a real hazard — the runner (`migrate.ts`) keys on the full `id` string (distinct: `053-issued-reports-and-update-requests` vs the old `053-seed-standard-v6`) and sorts deterministically by id. Renaming to `054` was readability hygiene, not a bug fix.
6. **Branch + worktree cleanup** (2.5).

---

## 4. Recommended immediate actions (none taken without your go)

1. Decide on contract v6 (2.3) — the only item with live client-facing exposure.
2. Confirm/close the drifted ClickUp tasks (2.2).
3. Confirm scope of `test-fixtures/cody-test/reset` on prod (2.4).
4. Pick the first "improve existing function" target — recommend the data-surfacing vein (3.1), highest leverage for least new infra.

Raw structured output of all 11 agents preserved in the workflow task output for this session.
