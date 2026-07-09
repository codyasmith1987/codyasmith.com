# Security audit 2026-05-12, Round 2

Branch: seo-security-improvements
Scope: server-side code and client-side auth/input handling (same surfaces as round 1: middleware, src/lib/*, all API routes, all portal pages, postbuild script, astro.config.mjs, package.json/package-lock.json, public-facing pages that post to forms, .env.example).
Auditor: Claude Code (Opus 4.7, 1M context) sub-agent
Prior round: docs/audits/security-audit-2026-05-12.md (28 findings)

## Summary

Total findings: 13 (critical: 1, high: 1, medium: 4, low: 5, info: 2)

Top themes:
- A process-wide TLS verification kill switch was introduced in the scraper that disables certificate validation for every outbound HTTPS call from the Node process (Brevo, Gemini, Serper, S3, Turso). This is the single most serious finding in round 2 and likely a regression from a one-time local debugging session.
- The unlock-email report URL embeds a token with no expiry baked into the signature, while the report itself expires after 30 days; an attacker who scrapes one valid URL retains access until that scan's 30-day clock runs out.
- The scraper has no SSRF allowlist; URLs come from third-party search results and are fetched server-side with no IP, hostname, or scheme filtering.
- Several dashboard endpoints accept unbounded numeric query parameters that translate directly into SQL `LIMIT` values, opening a small DoS / memory amplification surface.
- A handful of admin-facing routes still echo `err.message` to clients; minor recon leak.
- CSP still uses `'unsafe-inline'` for script-src and style-src; SRI still missing on Google Fonts and the jsDelivr Chart.js script. Long-standing; defensible but not closed.

## Round 1 fixes verified in code

- First-round SEC-001 resolved: `/api/report` now requires an HMAC token validated by `validateReportToken` before returning Tier 2 fields (`src/pages/api/report.ts:6-31`, `src/lib/report-token.ts:25-40`). Sample mentions remain in Tier 1 but Tier 2 phrase lists and full mention list are gated.
- First-round SEC-002 resolved: `csrf.ts` now throws in production when `CSRF_SECRET` is missing, no longer falls back to `TURSO_AUTH_TOKEN`, and `.env.example` documents the requirement (`src/lib/csrf.ts:9-19`, `.env.example:9-12`).
- First-round SEC-003 resolved: `markAsRead` and `deleteNotification` both scope the UPDATE/DELETE to `id = ? AND user_id = ?` (`src/lib/notifications.ts:91-113`), and the `/portal/api/notifications` POST passes `locals.user.id` (`src/pages/portal/api/notifications/index.ts:44`).
- First-round SEC-004 resolved: `/portal/api/admin/approvals/[id]` PUT now requires `locals.user?.role !== 'admin'` to short-circuit with 403, client responses go through `/portal/api/client/approvals` which scopes by `contract.client_id` (`src/pages/portal/api/admin/approvals/[id].ts:30`, `src/pages/portal/api/client/approvals.ts:59-61`).
- First-round SEC-005 resolved: listener.astro defines a shared `escapeHtml` and a `isSafeHttpUrl` helper; every `innerHTML +=` and template-literal interpolation passes user-controlled fields through escaping (`src/pages/listener.astro:282-295, 344-359, 410-505`).
- First-round SEC-006 resolved: dashboard.astro, health.astro, keywords.astro, notifications.astro, and admin/notifications.astro all define a local `escapeHtml` and apply it at every user-data interpolation point.
- First-round SEC-007 resolved: a shared `src/lib/email-safety.ts` exports `escapeHtml` and `stripCRLF`; unlock.ts, contact.ts, quiz.ts, create-user.ts, send-link.ts use both consistently. Brevo subjects are uniformly wrapped in `stripCRLF()` and HTML bodies escape interpolated values.
- First-round SEC-008 resolved: `/portal/auth/logout` validates a CSRF token via header or hidden form field before invalidating the session (`src/pages/portal/auth/logout.ts:20-34`), and the layout includes `csrfToken` in both desktop and mobile logout forms (`src/layouts/Portal.astro:134-139, 193-196`).
- First-round SEC-009 partially addressed, see SEC2-009 below: `userHasPassword(user.id)` short-circuits magic-link issuance for users who already have a password set (`src/pages/portal/auth/send-link.ts:37-39`, `src/lib/auth.ts:290-297`); onboarding (no password yet) still auto-creates a full session on first magic-link visit rather than landing on a set-password page.
- First-round SEC-010 resolved: `PASSWORD_MIN_LENGTH = 12`, `PASSWORD_MAX_LENGTH = 72`, `assertPasswordPolicy` rejects too-short and too-long inputs with a typed `PasswordPolicyError` (`src/lib/auth.ts:63-86`). `setPassword` calls it; `/portal/api/admin/set-password` surfaces the policy error message to the caller (`src/pages/portal/api/admin/set-password.ts:33-35`). HIBP / breached-password check is still absent but the 12-character floor matches NIST SP 800-63B-4 for memorable passphrases.
- First-round SEC-011 partially addressed, see SEC2-008 below: login.ts now imposes both a per-IP and a per-email throttle (`src/pages/portal/auth/login.ts:14-32`); both are fail-closed via `rateLimit(..., true)`. No account-level lockout counter; throttles still recover after a 15-minute window.
- First-round SEC-012 not addressed: CSP still ships `'unsafe-inline'` for `script-src` and `style-src` in both middleware and postbuild (`src/middleware.ts:47-48`, `scripts/postbuild-security-headers.mjs:36`). Documented in round 1 as effort: large.
- First-round SEC-014 partially addressed: `setPassword` now revokes all existing sessions for the user (`src/lib/auth.ts:97-101`); `sameSite: 'lax'` retained on the session cookie. Trade-off is documented in round 1.
- First-round SEC-015 resolved: `SESSION_ABSOLUTE_MAX_MS = 90 days` is enforced in `validateSession`; sessions older than 90 days from `created_at` are deleted and rejected regardless of rolling refresh (`src/lib/auth.ts:10, 181-188`).
- First-round SEC-016 resolved: `rateLimit` accepts a `failClosed` flag; login and per-email throttle both pass `true`; cleanup runs at most once per 5 minutes instead of on every request (`src/lib/rate-limit.ts:24-71`). Login route uses fail-closed (`src/pages/portal/auth/login.ts:16, 30`).
- First-round SEC-017 resolved: download endpoint returns an explicit 302 with `Referrer-Policy: no-referrer` and `Cache-Control: private, no-store` to prevent the signed S3 URL leaking via Referer (`src/pages/portal/api/files/download.ts:32-39`).
- First-round SEC-018 resolved: `src/lib/storage.ts` adds `detectMimeFromMagic` (PDF, PNG, JPEG, WEBP, Office-zip, XLS-OLE), `isMimeConsistent` enforces a match between claimed and detected MIME, file extensions are sanitized to a short alphanumeric whitelist, and uploads carry `Content-Disposition: attachment; filename="..."` with CR/LF/quote stripped from the filename (`src/lib/storage.ts:46-153`).
- First-round SEC-019 resolved: CSV upload route counts newlines and rejects files with more than 50,000 rows before invoking the parser (`src/pages/portal/api/csv/upload.ts:35-40`).
- First-round SEC-020 resolved: a throttled middleware-driven `maybeSweepRetention` deletes `request_log` rows older than 90 days, `rate_limits` rows older than 30 days, and `portal_rate_limits` rows older than 1 hour (`src/lib/retention.ts`, `src/middleware.ts:74`).
- First-round SEC-022 resolved: `npm audit --json` reports zero vulnerabilities across 671 dependencies (verified in-session, May 12 2026); commit 3ad0db9 lifted Astro to 6.1.10+, @astrojs/node, Vite, postcss, fast-xml-parser, and @aws-sdk/xml-builder past their advisory thresholds.
- First-round SEC-024 resolved: SSE error events on `/api/scan` and `/api/unlock` now emit a generic user-facing message ("Scan failed. Please try again in a few minutes." / "Failed to unlock report. Please try again.") and log full detail server-side (`src/pages/api/scan.ts:162-167`, `src/pages/api/unlock.ts:73-77`).
- First-round SEC-027 resolved: `.env.example` documents `CSRF_SECRET`, `REPORT_SECRET`, all Turso / Brevo / Serper / Gemini / DO Spaces / SITE variables with placeholder values (`.env.example:1-31`).
- First-round SEC-028 partially addressed: an explicit hourly per-IP rate limit (`scan:hour:${ip}`, 2/hr, fail-closed) was added on top of the daily 3-scan cap; the request still has no overall wall-clock timeout and no global concurrency limiter (`src/pages/api/scan.ts:43-48`).

## Findings

### [SEC2-001] Scraper disables TLS certificate verification process-wide
**Severity**: critical
**OWASP category**: A02:2021 Cryptographic Failures / A08:2021 Software and Data Integrity Failures
**Files**: `src/lib/scraper.ts:53`
**Observation**: `scrapeSinglePage` mutates `process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'` on every call. Node honors this environment variable globally and permanently for the lifetime of the process; the assignment is never reverted. Once the first scrape runs, every subsequent HTTPS call in the same Node process (Brevo, Gemini, Serper, Turso, DigitalOcean Spaces, fontsource font fetches in og.ts) executes with certificate verification disabled. Standalone Astro runs as a single long-lived Node process, so a single brand scan poisons TLS for the whole pod until restart.
**Attack scenario**: A network attacker positioned between the codyasmith.com server and any upstream (Brevo API, Gemini, S3) presents a self-signed or attacker-controlled certificate. Without TLS verification, the Node process accepts it, allowing the attacker to read or rewrite request bodies and response bodies. Brevo credentials in the `api-key` header are exposed on every outbound transactional email call. S3 PUT/GET signatures are exposed. Gemini API keys are exposed. Turso auth tokens are exposed if Turso uses HTTPS (it does). The breach radius covers every secret the application sends over the wire.
**Recommendation**: Delete the line outright. The scraper does not need to bypass cert verification. If a small set of well-known sites with broken certs has to be tolerated, scope it: do not mutate `process.env`; pass an `agent` per-request with a custom TLS context that overrides only that request. Better, refuse to scrape pages with invalid certs and rely on the Serper-snippet fallback already in `scrapeAll`. Add a runtime assertion early in app startup that throws if `process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0'`, so this regression cannot return silently.
**Effort**: trivial
**Verification**: Boot the server, run a scan, assert `process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0'` post-scan. Optionally point the scraper at a site with a deliberately invalid cert and confirm the fetch rejects.

### [SEC2-002] Scraper has no SSRF allowlist or scheme/IP filter on URLs from third-party search results
**Severity**: high
**OWASP category**: A10:2021 Server-Side Request Forgery
**Files**: `src/lib/scraper.ts:51-82`, `src/lib/search.ts` (Serper integration)
**Observation**: `scrapeSinglePage(url)` receives URLs returned by Serper for a brand search and feeds them straight into `fetch(url, ...)`. There is no validation that the URL uses http/https, no allowlist of public TLDs or IP ranges, no rejection of RFC 1918 ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16), no rejection of 169.254.169.254 (cloud metadata), no rejection of localhost / 127.0.0.0/8, and no rejection of file:// or other non-http schemes. Serper has filtered for public web content historically, but an attacker who can plant a low-volume search result for a target brand (typosquat domain that redirects 302 to an internal URL, or a page that the server fetches with `Location:` to an internal host) can pivot the scraper into the internal network or the cloud metadata endpoint.
**Attack scenario**: Attacker submits brand X to /api/scan. Serper returns one of their planted pages as a result for X. The page returns a 302 redirect to `http://169.254.169.254/latest/meta-data/iam/security-credentials/<role>`. The fetch in scrapeSinglePage follows redirects by default in Node's fetch and reads the response body. The response text is then stored in `mentions.snippet` and `mentions.full_text` in Turso. Attacker re-runs the scan as a separate user, calls `/api/report?id=...&token=...` (after unlock), and reads the IAM credentials from the mention body.
**Recommendation**: Add a URL validator at the top of scrapeSinglePage: parse with `new URL(url)`, reject anything that is not `http:` or `https:`, reject any hostname that resolves to a private/loopback IP via `dns.lookup`. Pass `redirect: 'manual'` to fetch and inspect the Location header. As a faster bandage, refuse to fetch URLs whose host is in a deny list (localhost, 169.254.169.254, 0.0.0.0, ::1) and require https scheme. The full SSRF defense pattern is well-documented: lookup IP, reject private ranges, then re-fetch with the resolved IP and Host header to avoid TOCTOU.
**Effort**: small
**Verification**: Stub Serper to return `https://attacker.example/redirect-to-169-254-169-254` and confirm scrapeSinglePage returns null without making the second hop.

### [SEC2-003] Report-token URL has no expiry inside the signature; URL stays valid for the entire 30-day report lifetime
**Severity**: medium
**OWASP category**: A07:2021 Identification and Authentication Failures
**Files**: `src/lib/report-token.ts:25-26`, `src/pages/api/unlock.ts:89-90`, `src/pages/api/report.ts:28-29`
**Observation**: `generateReportToken(scanId)` returns `hmac("report:" + scanId)`. The HMAC input is just the scan ID and the secret; there is no timestamp, no expiry, no nonce. The token is then embedded in the email URL `?report=<id>&token=<hmac>` and returned by `validateReportToken` as valid forever, with the only effective lifetime coming from `getScan(...)` returning the report and the application-level 30-day age check on `scan.created_at` (`src/pages/api/report.ts:20-24`). Any party who ever sees the URL (mail forwarding, screenshots, customer support tickets, browser history sync, a shared family computer, a parser in a shared inbox plugin) retains access for the remainder of those 30 days. There is no revocation path.
**Attack scenario**: A user forwards the report email to a colleague for review. The colleague clicks through, sees the report. Three weeks later, the colleague (now hostile, or compromised) re-clicks the link from their archived inbox. The report is still available. Also, if `REPORT_SECRET` is ever leaked (logs, source repo, exfiltrated container), the attacker can forge a valid token for any scan ID by knowing only the numeric ID (1, 2, 3, ...). Auto-increment scan IDs make this trivial. Token rotation requires changing `REPORT_SECRET`, which immediately invalidates every outstanding unlock email; no graceful overlap.
**Recommendation**: Include a timestamp in both the signed payload and the URL. Token = `${timestamp}.${hmac("report:" + scanId + ":" + timestamp)}`. Verify timestamp is within an acceptable window (e.g. 30 days, matching the report TTL). Optionally tie the token to the email address on the lead row by including it in the HMAC: `hmac("report:" + scanId + ":" + emailLower + ":" + timestamp)` and require the email in the URL. Switching scan IDs to nanoid would also harden against forgery if the secret leaks.
**Effort**: small
**Verification**: Issue a token, wait beyond the validity window, confirm `validateReportToken` returns false.

### [SEC2-004] Dashboard query endpoints accept unbounded `limit` and `months` from URL params
**Severity**: medium
**OWASP category**: A05:2021 Security Misconfiguration / DoS surface
**Files**: `src/pages/portal/api/dashboard/keywords.ts:21, 44`, `src/pages/portal/api/dashboard/trends.ts:19, 27`
**Observation**: `keywords.ts` does `parseInt(url.searchParams.get('limit') || '100')` with no upper bound and passes the result straight to a SQL `LIMIT ?`. `trends.ts` does `parseInt(url.searchParams.get('months') || '6')` and uses `months * 20` as the LIMIT. An authenticated client can pass `?limit=99999999` or `?months=99999999` and force the server to allocate a very large result set in memory before returning it as JSON. Combined with the 1MB request body cap, this is a small but real amplification factor: cheap GET, expensive response. No per-route concurrency cap.
**Attack scenario**: A compromised client account sends 50 concurrent GETs to `/portal/api/dashboard/keywords?client_id=...&limit=99999999`. Each request reads 50M rows from Turso, allocates them in Node, and JSON-stringifies. Memory pressure on the standalone Node process, plus Turso egress cost.
**Recommendation**: Clamp `limit` to `Math.min(500, Math.max(1, parseInt(...) || 100))`; same for `months` (e.g. 1..36). Apply the same pattern to any other endpoint that accepts a count param (search the codebase for `parseInt(url.searchParams.get`).
**Effort**: trivial
**Verification**: GET with `?limit=99999999`, observe the response is bounded at the clamp ceiling.

### [SEC2-005] Several admin endpoints still echo `err.message` to clients
**Severity**: medium
**OWASP category**: A05:2021 Security Misconfiguration
**Files**: `src/pages/portal/api/files/upload.ts:64`, `src/pages/portal/api/csv/upload.ts:70`, `src/pages/portal/api/metrics/manual.ts:42`, `src/pages/portal/api/admin/toggle-client.ts:32`
**Observation**: After centralizing generic messaging on `/api/scan` and `/api/unlock` (SEC-024 resolved), several admin-side endpoints still pattern-match `err.message || 'Failed'` in their catch blocks. These can leak Turso SQL errors, S3 SDK error messages with bucket and key names, or internal stack details. Admin scope reduces blast radius, but a malicious or compromised admin is exactly the threat model audit logging is supposed to constrain.
**Attack scenario**: A compromised admin account uploads a deliberately malformed file and reads the S3 error response from the JSON body to enumerate bucket names and key prefixes. Same with CSV upload to surface Turso schema mismatches.
**Recommendation**: Replace `err.message || 'Failed'` with a generic string per endpoint ("Upload failed", "CSV upload failed", "Failed to update metric", "Failed to toggle client"); keep `logger.error` server-side. For policy errors that the user needs to see (PasswordPolicyError, validation errors), throw a typed error class that the handler can switch on and surface only the safe `.message`.
**Effort**: trivial
**Verification**: Trigger an upload error and confirm the response does not include internal field names or SDK error chains.

### [SEC2-006] Magic-link onboarding auto-creates a full 30-day session instead of prompting for a password
**Severity**: medium
**OWASP category**: A07:2021 Identification and Authentication Failures
**Files**: `src/pages/portal/auth/verify.ts:14-37`, `src/pages/portal/api/admin/create-user.ts:48-89`, `src/lib/auth.ts:290-297`
**Observation**: `send-link` now refuses to mail a magic link to a user who already has a password (`userHasPassword(user.id)` check), so steady-state auth is password-only. However, the initial-onboarding flow still uses `/portal/auth/verify` which calls `createSession(userId)` directly and redirects to `/portal/dashboard`. The user is logged in for 30 days without ever setting a password. They can keep using the portal indefinitely as long as the rolling session refresh hits the 15-day window, and a fresh password-less magic-link session is the only credential. If they ever log out, they need another admin-triggered magic link.
**Attack scenario**: Attacker compromises a new user's inbox during onboarding (the highest-risk window because the user has not yet established account security habits). Magic link used by attacker, full 30-day session created. User assumes they were "logged in once" and never sets a password. Attacker retains 30-day access on a session the rightful user cannot see or revoke. There is no UI for users to view their active sessions.
**Recommendation**: After magic-link verification, redirect to a `/portal/auth/set-password` page that requires the user to set a password before establishing a long-lived session. Or, issue a short-lived setup session (e.g. 30 minutes) that only allows access to the set-password page until a password is set. Track `password_set_at` on the users table so admins can audit which users have completed onboarding.
**Effort**: small
**Verification**: Issue a magic link to a brand-new user, click it, confirm landing on a set-password page rather than the dashboard.

### [SEC2-007] Naming preview endpoint does not fail-closed on rate-limit DB errors
**Severity**: low
**OWASP category**: A05:2021 Security Misconfiguration
**Files**: `src/pages/api/naming/preview.ts:101, 108`
**Observation**: `/api/naming/preview` calls both `rateLimit('naming-preview:hour:${ip}', 10, HOUR_MS)` and `rateLimit('naming-preview:day:${ip}', 50, DAY_MS)` without passing `failClosed: true`. The route invokes Gemini on every cache miss (paid per-token), so a Turso outage that makes rate-limit fail-open would let an attacker burn the Gemini quota. The login route and /api/scan hourly throttle are correctly fail-closed; this newer route was not updated.
**Attack scenario**: During a Turso replica reshuffle, attacker scripts 1000 calls to /api/naming/preview from one IP. All rate-limit DB calls error and return `true` (allow). Gemini sees 1000 requests; budget burned.
**Recommendation**: Pass `failClosed: true` to both `rl()` calls inside `handlePreview`. Same posture as login and the scan hourly cap.
**Effort**: trivial
**Verification**: Simulate Turso error and confirm /api/naming/preview returns 429 or 500 instead of executing the Gemini call.

### [SEC2-008] Per-email login throttle still uses sliding 15-minute window; no persistent lockout counter
**Severity**: low
**OWASP category**: A07:2021 Identification and Authentication Failures
**Files**: `src/pages/portal/auth/login.ts:29-32`, `src/lib/rate-limit.ts:24-50`
**Observation**: SEC-011 from round 1 was partially addressed by adding `login:email:${emailLower}` as a separate rate-limit key. This caps 10 attempts per 15-minute window per email. A patient attacker waits out the window: 10 attempts every 15 minutes is 960 attempts per day per email. With bcrypt cost 12 (~250ms per hash) the per-server throughput limits this further, but a distributed attack still gets meaningful coverage of a small candidate set per week. There is no persistent failed-attempt counter on the users table and no escalating lockout (e.g. permanent lock after 50 lifetime failures pending admin reset).
**Recommendation**: Add `failed_login_attempts INTEGER DEFAULT 0` and `locked_until TEXT` columns on `users`. Increment on each failed `verifyPassword`, reset on success. Lock the account (return 423) when `failed_login_attempts > 20` or beyond a threshold. Optionally email the user with a "suspicious activity, password reset link" link.
**Effort**: small
**Verification**: Simulate 25 failed logins for one email across rolling windows; the account should auto-lock and reject even valid passwords until the lock clears.

### [SEC2-009] Activity log lookup still leaks counts to clients without rate limit
**Severity**: low
**OWASP category**: A09:2021 Security Logging and Monitoring Failures
**Files**: `src/lib/activity.ts:62-83` (no callers identified; route not in this scope but worth flagging)
**Observation**: `getRecentActivity` returns both entries and a `COUNT(*)` total. If exposed via `/portal/admin/activity` (and similar routes), the COUNT() runs on every page load and is unbounded. Not exploitable in the current product because the route is admin-only, but the `COUNT(*) FROM activity_log` pattern is a known scaling foot-gun once the log grows past 100k entries (Turso has to count every row). Worth bounding now while the log is small.
**Recommendation**: Drop the unconditional COUNT(*). For pagination, use opaque cursor (created_at + id) and let the UI request "older entries" without needing a total count. If a total must be shown, cache it and refresh on a slow cadence.
**Effort**: small
**Verification**: Insert 100k rows, observe activity page load time before and after the change.

### [SEC2-010] Funnel-email `escapeHtml` does not escape single quotes; inconsistent with the canonical helper
**Severity**: low
**OWASP category**: A03:2021 Injection
**Files**: `src/lib/funnel-emails.ts:18-24`
**Observation**: `funnel-emails.ts` defines its own local `escapeHtml` that omits the `&#39;` substitution present in `src/lib/email-safety.ts:15-23`. Quotes inside `name` (e.g. `O'Brien`) render as-is in the email body, which is safe in a text-content context but inconsistent with the centralized helper. If a future template ever interpolates `name` into an HTML attribute (`alt="${safeName}"`), the single quote becomes attribute-injection-relevant.
**Recommendation**: Delete the local `escapeHtml` in `funnel-emails.ts` and import from `src/lib/email-safety.ts`. One source of truth.
**Effort**: trivial
**Verification**: Build and run; confirm both helpers are identical.

### [SEC2-011] Subresource integrity still missing on Google Fonts CSS and the Chart.js CDN script
**Severity**: low
**OWASP category**: A08:2021 Software and Data Integrity Failures
**Files**: `src/layouts/Base.astro:111-128`, `src/layouts/Portal.astro:69-71`, `src/pages/portal/login.astro:22-24`, `src/pages/portal/dashboard.astro:102`
**Observation**: First-round SEC-026 unchanged. The Google Fonts stylesheet links and the Chart.js script (`https://cdn.jsdelivr.net/npm/chart.js@4.4.8/dist/chart.umd.min.js`) load without `integrity=` attributes. The Chart.js URL pins a major.minor.patch version (4.4.8), so an SRI hash is feasible. Google Fonts CSS returns version-varying content per user-agent, so SRI on it is impractical, and the right fix is to self-host the few fonts actually used. The privacy page (`src/pages/privacy.astro:62-65`) already documents that Google Fonts and jsDelivr are loaded, which is honest.
**Recommendation**: Add `integrity="sha384-..."` and `crossorigin="anonymous"` to the Chart.js script. Self-host the four Google Fonts used (Instrument Serif, Inter, Lora, JetBrains Mono); the assets are small and you remove a cross-origin dependency, an inflight performance dependency, and a privacy footprint (Google logs every font request to Google's IP).
**Effort**: medium
**Verification**: Tampered CDN response should fail SRI check and the browser should refuse to execute the script.

### [SEC2-012] CSP `'unsafe-inline'` for script-src and style-src still in place
**Severity**: info
**OWASP category**: A05:2021 Security Misconfiguration
**Files**: `src/middleware.ts:47-48`, `scripts/postbuild-security-headers.mjs:36`
**Observation**: First-round SEC-012 unchanged; documented in round 1 as effort: large. Astro 5+ supports nonce-based CSP but adoption requires touching every `<script is:inline>` and `define:vars` block. Worth tracking, not a regression.
**Recommendation**: When time permits, plan a separate PR to migrate to nonce-based CSP. Until then, the round-1 XSS fixes (SEC-005, SEC-006, SEC-007) carry the bulk of the defense.
**Effort**: large
**Verification**: Inspect response Content-Security-Policy and confirm no `'unsafe-inline'` for script-src.

### [SEC2-013] Cross-Origin-Embedder-Policy not set; COOP and CORP are present
**Severity**: info
**OWASP category**: A05:2021 Security Misconfiguration
**Files**: `scripts/postbuild-security-headers.mjs:41-42`, `src/middleware.ts:19-34`
**Observation**: The postbuild wrapper sets `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Resource-Policy: same-origin`, which is a good baseline. Cross-Origin-Embedder-Policy is not set. COEP would tighten cross-origin isolation but breaks third-party assets (Google Fonts, Chart.js CDN), so unsetting it is currently the right call. Worth documenting the trade-off so a future contributor does not enable it without first self-hosting the externals.
**Recommendation**: Add a code comment in postbuild-security-headers.mjs explaining why COEP is intentionally omitted. If Chart.js and Google Fonts are ever self-hosted (see SEC2-011), revisit COEP.
**Effort**: trivial
**Verification**: n/a

## Strengths

- TLS verification regression aside (SEC2-001), the cryptographic primitives in the stack remain sound: bcryptjs with cost 12, HMAC-SHA-256 for CSRF and report tokens with constant-time comparison, SHA-256 hashes for session tokens at rest, nanoid CSPRNG for all generated IDs except the legacy auto-increment scans table.
- Origin verification via Astro `security.checkOrigin: true` plus the middleware HMAC CSRF check on `/portal/api/*` is defense in depth. Logout now honors CSRF explicitly via a form-encoded token.
- Centralized email-safety helpers (`escapeHtml`, `stripCRLF`) are used consistently across `unlock.ts`, `contact.ts`, `quiz.ts`, `create-user.ts`, `send-link.ts`. Brevo subjects no longer carry raw user input.
- All SQL queries inspected use parameterized statements; dynamic column updates go through allowlists in `contracts.ts` and `invoices.ts`.
- File uploads now verify magic bytes against the claimed MIME and force `Content-Disposition: attachment` on the S3 object, neutralizing the round-1 HTML-in-image risk.
- CSV uploads have a 50,000-row cap and a 10MB size cap.
- Rate-limit module supports per-route fail-closed semantics, with the auth-critical paths (login per-IP, login per-email, scan hourly) wired up correctly.
- Privacy policy and retention sweep are now consistent: `request_log` keeps 90 days, `rate_limits` (raw IP) keeps 30 days, `portal_rate_limits` expires within an hour.
- `.env.example` documents all required secrets including the new `CSRF_SECRET` and `REPORT_SECRET`.
- `npm audit --json` reports zero vulnerabilities across the dependency tree.
- Session lifetime is now bounded by an absolute 90-day cap from `created_at`, on top of the rolling 30-day expiry. Password changes revoke all sessions.
- Portal pages emit `X-Robots-Tag: noindex, nofollow` at the HTTP layer in addition to the `<meta name="robots">` tag. Postbuild wrapper guarantees HSTS, COOP, CORP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, and Permissions-Policy on every response (prerendered HTML, static assets, SSR alike).
