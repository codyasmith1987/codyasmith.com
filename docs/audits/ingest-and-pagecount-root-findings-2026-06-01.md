# Ingest integrity + page-count + parse-everything — consolidated findings

Date: 2026-06-01
Status: investigation complete (3 read-only workflows + first-hand code reads). NO code changed. Findings before code, per Cody.

Supersedes the narrower `f3-ingest-format-collision-findings-2026-06-01.md` (same bug, fuller scope).

## The data model (Cody's, corrected against code) — THREE distinct things, stored separately

A "URL" and a "page" are not the same thing. There are three layers and they must each be captured/derived distinctly:

1. **All URLs** — everything crawled: HTML, assets (CSS/JS/images), PDFs, feeds, archives, taxonomy. F3 ≈ 94 (`internal_all.csv`). Must be captured: domain detection, link graph, redirects, response-code health all depend on identifying every URL.
2. **HTML pages** — the `text/html` subset. F3 = 13 (`internal_html.csv`). An intermediate filter, NOT "pages."
3. **Real user pages** — published destinations a human navigates to: `page` + `post` content types, EXCLUDING taxonomy/archives (category/tag/author/date), utility (`/wp-*`, `/feed`, pagination), and noindexed. **F3 = 6, ZKH = 70** (Yoast-sitemap verified). **This is what "page" means in the system and what WM ecosystem routing / pricing MUST use.** Cleanest source = Yoast `post-sitemap` + `page-sitemap` `<loc>` count; crawl-derived count must reconcile to it.

Everything below serves this model: capture all URLs, derive real user pages correctly, never discard.

## Three layered problems (all proven)

### Problem 1 — Ingest collision corrupts captured data (data integrity)
`clearPreviousData` (`src/lib/csv/index.ts:78-110`) supersedes by `(client_id, month, detected_format)`. The detector legitimately maps many physical files to one format, and the UI invites whole-folder uploads. So same-format sibling files delete each other's rows; the alphabetically-last-processed file wins. Proven by detector replay over the F3 bundle: 61 files → `accessibility`, 13 → `content_urls`, 12 → `structured_data_urls`, 2 → `crawl_internal`. For crawl, `internal_html.csv` (13 rows) processes after `internal_all.csv` (94) and wins → `crawl_urls` ends at 13 → **the full URL inventory (assets, etc.) is lost.** This violates "parse everything, never discard." Already worked-around for `crawl_internal` (incomplete guard), `issue_urls`, `links` — three per-URL formats never got the fix.

### Problem 2 — Page-count definition regression (MONEY)
There are TWO live page-count formulas and **neither is the real-user-page definition:**
- `getNavigablePageCount` (`crawl-read.ts:137`) — strict: HTML + excludes `/tag/`,`/category/`,`/feed/`,`/page/N`. Used by **dashboard + client report**.
- `syncPerSitePageCounts` (`client-sites.ts:283`) — loose: `content_type LIKE 'text/html'`, **no exclusions, overcounts**. This is the one that writes `client_sites.page_count` — **the pricing input.**

Neither uses `page`+`post` content type. So pricing uses the loose count, the dashboard uses a different (strict-but-not-real-page) count, and your verified real-user-page numbers (F3=6, ZKH=70) are used by nothing. This is the single-source regression your `reference_real_user_page_count` work was meant to close.

**Proven money chain** (file:line confirmed): `crawl_urls` → `syncPerSitePageCounts` → `client_sites.page_count` → `buildPerSiteBases` → `routeWebManagementEcosystem` (bands <30=A / ≤150=B / >150=C, `web-management.ts:232`) → per-site monthly/onboarding → `computePricing` → **contract line items → invoice.** A wrong page count puts a site in the wrong band → wrong price on a real proposal/contract. Highest-stakes of the three.

### Problem 3 — Parse-everything gap (unknown_stored backlog)
~259 files (Raised Bar) + ~96 (ZKH) sit in `raw_csv_data` as `unknown_stored` — captured raw but not parsed into queryable tables, so unavailable to scoring/widgets/analysis. This is the portal failing its purpose. Backlog by value (from detector replay + headers):
- **Tier 1:** PageSpeed/Core-Web-Vitals (`pagespeed_*`, the open ClickUp 86ba36v3y), Google Rich Results features, schema validation detail.
- **Tier 2:** third-party/console impact, outlink/anchor-text detail (extends `link_graph`), mobile optimization.
- **Tier 3:** content duplicates/grammar detail, metadata extraction, JS-rendering deltas.

## Downstream blast radius (what reads the affected tables)

- **Money/critical:** `crawl_urls`→page_count→pricing (Problem 2); `keyword_rankings`→domain detection→multi-site structure→pricing; both also feed dashboard score components.
- **Client-facing:** `site_issues`→Technical Health score; `ga4_*`/`gsc_*`→score + monthly reports; `crawl_urls`→client report navigable-page count.
- **Internal/diagnostic (the 3 new widgets + others):** `accessibility_urls`/`content_urls`/`structured_data_urls`/`image_urls`/`redirect_chains`/`link_graph` feed only the `/portal/health` per-URL widgets today — so the collision emptying them is a UI/analysis loss, not a money loss. (But under parse-everything they should feed scoring too — see Problem 3 + scoring below.)

## The fix (capture-everything, preserves all data)

**Root data-integrity fix (Problem 1):** change `clearPreviousData`'s supersession key from `(client,month,format)` to `(client,month,format,original_name)` — a re-upload of the *same filename* replaces; distinct sibling files coexist. Mirrors the proven `issue_urls` (dedup by `issue_name`) / `links` (by `source_file`) patterns. Three-line change in `csv/index.ts` (signature + WHERE + two call sites), backward-compatible. **No filename guards that route data to unknown_stored** — that would discard, against principle. `crawl_urls` then holds the **superset** (all URLs from internal_all); HTML and real-user views are filters/derivations at read time.

**Page-count correctness fix (Problem 2):** make ONE real-user-page definition (`page`+`post` minus taxonomy/utility/noindex, reconciled to Yoast sitemap) the single source feeding `client_sites.page_count` and therefore pricing — replacing the loose `syncPerSitePageCounts` count. Reconcile crawl-derived vs sitemap-derived; warn the admin when a site's page_count is null/unreconciled rather than silently falling back to the primary ecosystem (current silent fallback can mis-price). Benchmarks to validate: F3=6, ZKH=70.

**Parse-everything (Problem 3):** add table + parser per unknown group (Tier 1 first), then retroactively re-parse the already-captured `raw_csv_data` rows (zero data loss — the raw text is already stored). Each new table becomes available to scoring + future widgets.

## Scoring opportunity (dashboard-hub lens)
Score's Technical Health today = `site_issues` aggregate counts only; it ignores the 8 per-URL tables the portal already captures. A site can show 100 health while 50 pages have real violations. Once Problem 1 makes per-URL data reliable and Problem 3 adds PageSpeed/mobile/rich-results, Technical Health can become a real per-URL-violation ratio, and new components (Performance/Core-Web-Vitals, Mobile UX, Rich-Results eligibility) become possible. Capture first, score second.

## Recommended sequence
1. **Problem 2 (page-count/pricing correctness)** — highest stakes (live money on every multi-site proposal). Depends on clean crawl data, so pair with #2.
2. **Problem 1 (supersession key)** — the data-integrity root; unblocks reliable per-URL data and a clean crawl superset. (1 and 2 are tightly coupled; likely one combined slice: fix the key, then fix the page-count definition on the now-trustworthy data.)
3. **Repopulation** — SOP-COMPLIANT, no manual SQL: re-ingest the F3 bundle via the existing `force=true` ingest, re-sync domains/page-counts via existing admin endpoints, spot-check pricing. Confirm the CASCADE constraint (per-URL tables → csv_uploads) before relying on delete-driven cleanup; it was flagged unverified.
4. **Problem 3 (parser backlog)** — Tier 1 first (PageSpeed closes ClickUp 86ba36v3y), then retro-parse raw_csv_data.
5. **Scoring enrichment** — after the data it depends on is reliably captured.

## Open decisions for Cody
1. **Page-count source of truth:** Yoast sitemap parse as primary with crawl reconciliation, or crawl-derived real-user-page filter as primary? (Memory says sitemap is cleanest for WP; crawl must agree.)
2. **Sequence:** combined Problem-1+2 slice first (recommended), or Problem 1 alone first?
3. **Repopulation gating:** manual admin "re-sync all" action (recommended, safer on live clients) vs automatic on deploy.
4. **Null page_count in pricing:** add an admin warning badge on proposals when a site's page_count is missing/unreconciled (recommended) instead of silent primary-ecosystem fallback.
5. **Concurrency hardening** (UNIQUE constraint + INSERT OR IGNORE for the race on identical concurrent filenames): now, or deferred follow-on?

## CSV upload endpoint audit (`src/pages/portal/api/csv/upload.ts`, 2026-06-01)

Audited the entry point that calls `ingestCSV`. Mostly solid; one real finding.

**Solid:** admin-gated; caps (10MB/file, 50k rows, 50 files/batch, 25MB/100-CSV ZIP); ZIP fan-out with basename stripping so filename routing matches standalone uploads; folder-picker path-prefix stripping; fail-open `client_sites` sync (a sync error never fails the upload); clean JSON 400s on malformed multipart (avoids CF 520s).

**Finding (real, affects the Task 1 fix):** the batch is processed **concurrently** — `Promise.allSettled(files.map(processOne))` (line 211). The code comment (196-205) justifies this (sequential caused CF 524 timeouts on big SF batches) and assumes "supersede operates per-filename per-client per-month (no contention between different filenames)." The per-filename supersession key (Task 1) makes that assumption mostly true — different filenames no longer collide — BUT `clearPreviousData` is a non-transactional SELECT→DELETE→INSERT. Concurrent writers for the SAME (format, original_name) (e.g. the same filename twice in one batch, or a re-ingest overlapping a prior) can still interleave. The F3 bundle's 60+ same-format/different-filename files are FIXED by the key; the residual race is only same-filename-concurrent.

**Options (Cody decision):**
1. DB-enforced: UNIQUE index on `csv_uploads(client_id, month, detected_format, original_name)` + idempotent insert, so supersession is enforced by the DB, not read-then-write app logic. Most correct; small migration.
2. Group-sequential: process concurrently ACROSS (format, original_name) groups but sequentially WITHIN a group. Keeps the CF-timeout fix, removes the intra-group race. App-only.
3. Document + accept: the residual same-filename-concurrent race is rare (admins don't upload the same file twice at once); F3 repopulation is a single controlled re-ingest. Defer to hardening. (This is what the investigation recommended.)

The per-filename key (Task 1) is correct and necessary regardless; this decision is only about the residual concurrency race on top of it.

## Verification trail
- Detector replay over real F3 bundle: 61/13/12/2 file→format collisions with row counts (proven, local).
- `clearPreviousData` semantics + alphabetical processing order quoted from `csv/index.ts` + `raised-bar-f3-ingest.ts:59` (proven).
- `crawl_urls=13` prod diagnostic = `internal_html.csv` row count (collision fingerprint).
- Two divergent page-count formulas: `crawl-read.ts:137` (strict) vs `client-sites.ts:283` (loose, feeds pricing) (proven, first-hand read).
- Money chain `crawl_urls`→pricing→contract traced file:line (proven).
- Rejected the workflow's "3-client 66-95% loss" claim (compared crawl_urls vs all-URL metric; KelseyVerse has only 1 crawl upload so cannot collide).
