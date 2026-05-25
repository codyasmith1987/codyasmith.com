# Bug + fix log

Append-only record of non-obvious bugs and their fixes. Newest at top.

Every entry: symptom (what the user saw), root cause (what was actually wrong), fix (PR or commit), watch-for (what to check first if this symptom reappears).

When working on the portal, **check this file before guessing at any auth, redirect, session, or middleware symptom.** Several of these have recurred. The pattern is more useful than the patch.

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
