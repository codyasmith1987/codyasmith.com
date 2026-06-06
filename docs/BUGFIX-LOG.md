# Bug + fix log

Append-only record of non-obvious bugs and their fixes. Newest at top.

Every entry: symptom (what the user saw), root cause (what was actually wrong), fix (PR or commit), watch-for (what to check first if this symptom reappears).

When working on the portal, **check this file before guessing at any auth, redirect, session, or middleware symptom.** Several of these have recurred. The pattern is more useful than the patch.

---

## 2026-06-05 — `npm run build` fails on a fresh DB: "table client_metadata has no column named billing_cc_email"

**Symptom.** `npm run build` fails against a fresh/empty database (e.g. a new contributor's local build, or CI on a clean DB) with `LibsqlError: SQLITE_ERROR: table client_metadata has no column named billing_cc_email`, thrown from `runMigrations`. Existing databases (prod, an already-migrated dev2.db) build fine — only a from-scratch DB breaks. The failing migration logged just before the error is `025-seed-cody-test`.

**Root cause.** Two things combined. (1) Migrations run inside `src/middleware.ts` (`await runMigrations()` on every request), and `astro build` prerenders the public marketing/blog/OG pages — so the migration chain executes at build time against whatever DB `.env` points at. On a fresh DB it runs the whole chain 001→069 in order. (2) `025-seed-cody-test` imported the LIVE `upsertClientMetadata` helper from `src/lib/agreements.ts`. That helper INSERTs the *current* full column set (`CLIENT_METADATA_COLS`), which gained `billing_cc_email` in migration **067** (PR #293). On a fresh DB, 025 runs long before 067 exists, so the seed INSERT references a column that isn't there yet and the chain dies. Existing DBs never hit it because 025 was already in `_migrations` and never re-runs — the bug is invisible until someone builds from zero.

**Fix.** Made 025 a self-contained snapshot: dropped the `../agreements` import and inlined an idempotent `INSERT ... ON CONFLICT(client_id) DO UPDATE` using only the columns that existed at migration 019 (when `client_metadata` was created). Added a regression guard, `tests/run-migration-imports-lint.mjs` (wired into `npm test`), that fails if any migration imports outside a tiny verified-safe allowlist — so importing a schema-bearing data helper into a migration can never silently ship again. Verified by replaying the full chain on a throwaway fresh DB: `npm run build` now exits 0 with all 69 migrations applied.

**Watch for.** If a fresh-DB build dies in `runMigrations` with "no such column" / "no column named X", the culprit is almost always a SEED or BACKFILL migration that imports app code whose column list drifted, OR a seed that hardcodes a column added by a later migration. Migrations are immutable snapshots: never import `agreements`/`invoices`/`clients`/`billing` or any helper whose SQL evolves — inline the columns valid at that migration's position. The import lint catches the import-based form; the behavioral form (hardcoded later column) is caught by actually building against a fresh DB. Note also that `astro build` exercises migrations via prerender, so a migration bug surfaces as a *build* failure, not just a runtime one.

---

## 2026-05-25 — CSV folder uploads return HTTP 524 even though data lands in DB

**Symptom.** Uploading a full Screaming Frog export folder (~150 CSVs) at `/portal/admin/csv` returns HTTP 524 on every file in most batches. The 524 response body is a Cloudflare gateway-timeout HTML page. Looking at "Recent uploads" on the same page shows many of the failed-batch files actually did land in the DB. The client UI displays the CF HTML as raw text for each file ("HTTP 524: <!DOCTYPE html>..."), making it look like total failure.

**Root cause.** Cloudflare's 100-second cap on origin response time. The CSV upload endpoint was processing each batch's files **sequentially** in a `for...of` loop. A batch of 25 mostly-small CSVs would usually finish in time, but SF folders contain 4-5 large link CSVs (e.g., `internal_success_(2xx)_inlinks.csv` at 6000+ rows) where each one takes 15-30 seconds of parsing + Turso writes + supersede sweep. Sequential processing meant batch wall time was the SUM of every file's time, easily 120+ seconds for a typical SF batch. Cloudflare gave up at 100s and returned its 524 page, even though the origin kept processing and most files did finish writing.

**Fix.** Two-part fix across two PRs. PR #156 added a 25-file count cap on top of the existing 8MB byte cap (file-count alone wasn't enough). PR #157 switched server-side processing from `for...of` to `Promise.allSettled` so batch wall time is roughly the slowest file, not the sum. Also dropped client batch to 10 files for additional headroom, and rewrote the 524 error message in the UI to say "Server response timed out at Cloudflare (524). Data likely landed — check Recent uploads below in 10-20 seconds before retrying" instead of dumping the CF block HTML.

**Watch for.** If CSV uploads start returning 524s on full SF folders again, check: (1) is the client batch size still small enough? (2) is server-side processing still parallel? (3) has Turso latency spiked making even parallel batches slow? The supersede logic dedupes on retry, so 524'd files that did land won't double-write — but the UI will show errors. Telling Cody to "just retry" creates supersede churn even when retries are safe. Better to wait for the original batch's deferred completion to show up in Recent uploads.

Related: when an upload-like endpoint must process N items, default to `Promise.allSettled` over sequential unless the items contend on the same row in Turso (rare). Cloudflare's 100s cap is hard.

---

## 2026-05-25 — Cloudflare API calls fail intermittently with "Cannot use the access token from location: <IP>"

**Symptom.** A portal endpoint that calls the Cloudflare API (via the `listZones` / `fetchTrafficDaily` / `fetchSecurityDaily` helpers in `src/lib/cloudflare.ts`) starts failing with CF API error code 9109: `Cannot use the access token from location: <some IP>`. The same code path worked moments earlier. The IP in the error message is a DigitalOcean App Platform container egress IP. May surface as a CF 504 HTML page reaching the browser because Cloudflare in front of `codyasmith.com` transforms 5xx origin responses to its own gateway-timeout page, swallowing the JSON error body. The endpoint's own logs in DO show the actual 403 from CF.

**Root cause.** Cloudflare API tokens support an optional Client IP Address Filter (Token settings → Client IP Address Filtering). Tokens with a filter only work from the allow-listed IPs. DigitalOcean App Platform does NOT guarantee a stable egress IP for a container; the IP rotates whenever the container is recycled (deploy, scaling event, health-check recovery). Adding the current egress IP to the allow list fixes the symptom until the next container restart, then it breaks again with a different IP.

**Fix.** Edit the CF API token, remove all entries from Client IP Address Filtering (leave the field empty so the filter is off entirely). The token scope (e.g. `Zone Analytics: Read on All zones from account: X`) is restriction enough. Do NOT pin to specific IPs even when "they look stable" — DO will rotate them.

**Why this took two attempts.** First incident (token initially created with filter): added IP `147.182.177.9` to allow list. Worked. Second incident (after deploys recycled the container): IP rotated to `134.122.31.25`, token rejected again. Spent ~45 minutes chasing other theories (CF WAF blocking the URL path, listZones hanging, AJAX-specific headers, browser cache, JSON parse error) before the structured error logging in PR #128 finally surfaced the actual CF response.

**Watch for.** If ANY CF API call fails after working earlier in the session, especially after a deploy or container restart, the FIRST hypothesis is the token's IP filter has rotated out of the allow list. The DO logs will show the actual CF error code 9109 with the new egress IP. Symptom in the browser may be misleading (CF 504 HTML) because CF transforms origin 5xx — return 200 with `ok: false` from API endpoints that call CF, so the JSON error body reaches the client.

Related: when adding new API endpoints that wrap CF, return 200 + `ok: false` for non-fatal errors instead of 5xx, otherwise CF in front of the portal will mask the real error with its own gateway-timeout page.

---

## 2026-05-24 — CSV upload errors with "require is not defined" on most files

**Symptom.** Uploading a folder of Screaming Frog CSVs at `/portal/admin/csv` returns the error string `require is not defined` on almost every file. Only `crawl_overview.csv` parses successfully. Affects production after the deploy of PR #109 (Slice A no-rejection) which expanded the per-issue URL filename map.

**Root cause.** `src/lib/csv/detector.ts:177` used a CommonJS `require('./parsers/issue-urls')` call to lazy-load `ISSUE_CSV_FILENAME_MAP`. The eslint-disable comment justified this as "imported lazily to avoid a circular dependency on the parser." That claim was wrong — `issue-urls.ts` only imports Papa, nanoid, and turso, not detector.ts. The `require()` shipped in the Astro standalone Node ESM bundle where `require` is not defined, so every file that fell through to the per-issue detection branch (anything that isn't crawl_overview, GA4, or GSC) crashed at that line. `crawl_overview.csv` worked because its detection happens earlier in the function and returns before reaching line 177.

**Fix.** Replace the `require()` with a static ESM import at the top of `detector.ts`. PR #120.

**Watch for.** If CSV uploads start failing with `require is not defined` after a parser-registry change, grep `src/lib/csv/` and `src/lib/proposal-ai/` for `require(` calls. The Astro standalone bundle does not shim CommonJS `require`. Any new parser added with `require()` instead of `import` will break the upload route the same way. The pattern to fix is "lazy require to dodge a circular import" — almost always there is no actual circle and a static ESM import is correct.

---

## 2026-05-23 — Portal `/portal/set-password` redirect loop

**Symptom.** Clicking a magic-link invite (or any other path to `/portal/set-password`) lands on an unstyled mostly-black page showing only the text "Redirecting from /portal/set-password to /portal/login," and the page keeps reloading. Affects incognito, fresh sessions, every browser. URL stays at `/portal/set-password` with the body showing the redirect message.

**Root cause.** `src/pages/portal/set-password.astro` was missing `export const prerender = false`. Astro 6 with the `@astrojs/node` adapter prerenders pages by default unless the directive is set. At build time, `Astro.locals` is undefined, so the page's `if (!user) return Astro.redirect("/portal/login")` branch runs and the resulting static HTML is the "Redirecting to login" Astro fallback page. Every request to `/portal/set-password` thereafter serves that static redirect regardless of cookies, session, or user state.

**Fix.** [PR #57](https://github.com/codyasmith1987/codyasmith.com/pull/57) adds `export const prerender = false` to the top of `set-password.astro`. Now matches every other portal page.

**Why this took multiple attempts.** Chased three other hypotheses before identifying the prerender issue: cookie collision between admin and magic-link sessions (PR #54), Set-Cookie ordering with the conditional cookie delete (PR #55), and Brevo click-tracking interfering with the redirect (PR #56 — reverted in PR #57). All three were plausible from the symptom but none were the cause. The bug had been diagnosed and fixed once before during the May 12 audit work, then the directive slipped off in a later edit and the regression went unnoticed.

**Watch for.** If any portal page shows the same "Redirecting from X to Y" static-feeling behavior, or seems to ignore session state, **grep for `prerender = false` directive across all `src/pages/portal/**/*.astro` files first**. Every portal page that reads `Astro.locals` must have it. A missing directive on any one page produces the same symptom for that page.

```powershell
# Quick audit:
Get-ChildItem -Recurse -Path src/pages/portal -Filter *.astro | ForEach-Object {
  if (-not (Select-String -Path $_.FullName -Pattern 'prerender = false' -Quiet)) {
    Write-Host "MISSING prerender=false: $($_.FullName)"
  }
}
```

---

<!-- Newer entries go above this line. Format:
## YYYY-MM-DD — Brief title
**Symptom.** What the user saw.
**Root cause.** What was actually wrong.
**Fix.** PR or commit link.
**Why this took N attempts.** If applicable, what other hypotheses ate time.
**Watch for.** What to check first if this symptom reappears.
-->
