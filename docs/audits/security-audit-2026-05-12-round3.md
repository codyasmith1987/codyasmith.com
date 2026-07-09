# Security audit 2026-05-12, Round 3

Branch: seo-security-improvements
Scope: server-side code and client-side auth/input handling (same surfaces as rounds 1 and 2: middleware, src/lib/*, all API routes, all portal pages, postbuild script, astro.config.mjs, package.json/package-lock.json, public-facing pages that post to forms, .env.example).
Auditor: Claude Code (Opus 4.7, 1M context) sub-agent
Prior rounds:
- docs/audits/security-audit-2026-05-12.md (28 findings)
- docs/audits/security-audit-2026-05-12-round2.md (13 findings)

## Summary

Total findings: 11 (critical: 0, high: 1, medium: 3, low: 5, info: 2)

Top themes:
- The new SSRF guard in scraper.ts is a meaningful improvement, but it validates URL hostnames literally rather than resolving them. A public hostname whose DNS A record points to a private IP (a deliberately misconfigured attacker domain) still gets fetched, defeating the guard. The check rejects literal `127.0.0.1` but accepts `attacker.example.com` even when that name resolves to `127.0.0.1`.
- The new report-token format embeds an issued-at timestamp and enforces a 30-day TTL, closing SEC2-003 cleanly. The underlying hash construction is `sha256(SECRET + ':' + data)`, the "secret-prefix" pattern technically susceptible to length-extension on Merkle-Damgard hashes. It is not exploitable as written (the verifier reconstructs the canonical message; the attacker cannot inject padding into the data the server signs over) but it deviates from standard HMAC and re-using `@oslojs/crypto`'s actual HMAC implementation costs nothing.
- One unbounded `limit` parameter survived the round 2 sweep (`/portal/api/notifications` GET). Same DoS amplification surface as SEC2-004, smaller blast radius because it is bounded by row count per user.
- One magic-link issuance endpoint (`/portal/auth/send-link`) still uses fail-open rate limiting, while the rest of the auth-critical paths are fail-closed.
- The legacy SHA256 verify path in `verifyPassword` short-circuits with a non-constant-time string compare and runs orders of magnitude faster than the bcrypt path, creating a small timing oracle that distinguishes "user with legacy hash" from "user with bcrypt hash" or "no user at all."
- Round-2 carryovers (CSP `'unsafe-inline'`, SRI on Chart.js, magic-link onboarding flow, account lockout counter, funnel-emails escapeHtml inconsistency) remain as previously documented; not re-counted, just reaffirmed.

## Round 2 fixes verified in code

- SEC2-001 resolved: `NODE_TLS_REJECT_UNAUTHORIZED = '0'` is gone from `src/lib/scraper.ts`. A comment at lines 174-180 documents the removal and explains the MITM exposure it created. The fallback path now uses search snippets when scraping fails, without any TLS override.
- SEC2-002 resolved (with caveat documented as SEC3-001 below): `isAllowedFetchUrl` (`src/lib/scraper.ts:55-100`) checks the URL scheme (http/https only), rejects credentialed URLs, blocks `localhost` and a list of internal-use TLDs, and rejects IPv4 literals in private/loopback/link-local/CGNAT/multicast ranges as well as IPv6 loopback, ULA, link-local, multicast, and v4-mapped variants. `scrapeSinglePage` invokes the guard before the first fetch and re-runs it on every redirect target with `redirect: 'manual'` and a 3-hop cap (`src/lib/scraper.ts:106-130`). The remaining gap (DNS resolution) is captured in SEC3-001.
- SEC2-003 resolved: `generateReportToken` now returns `${issuedAt}.${hmac(...)}` where the HMAC binds `REPORT_SECRET`, scan ID, and the issued-at second (`src/lib/report-token.ts:33-37`). `validateReportToken` rejects malformed tokens, future timestamps, and tokens older than 30 days, and falls through to a constant-time HMAC comparison (`src/lib/report-token.ts:39-60`). Construction note: SEC3-005 below.
- SEC2-004 resolved: `parseInt` on `limit` and `months` in `dashboard/keywords.ts:24-25` and `dashboard/trends.ts:21-22` is now clamped via `Math.min(Math.max(...), ceiling)` to 1..500 and 1..36 respectively. SEC3-002 below flags the only remaining unbounded `limit` (notifications).
- SEC2-005 resolved: `files/upload.ts:64`, `csv/upload.ts:70`, `metrics/manual.ts:42`, and `admin/toggle-client.ts:32` now return fixed strings ("Upload failed", "Failed to save metric", "Failed to toggle client") instead of `err.message`. The corresponding `logger.error` calls preserve full server-side detail.
- SEC2-007 resolved: `/api/naming/preview` now passes `failClosed: true` to both the hourly and daily `rateLimit` calls (`src/pages/api/naming/preview.ts:105-116`). Comment cites SEC2-007 directly.

## Round 1 carryover items still unchanged (not re-counted, documented for tracking)

- SEC-012 / SEC2-012: CSP `'unsafe-inline'` for `script-src` and `style-src` still in place in both middleware (`src/middleware.ts:47-48`) and postbuild wrapper (`scripts/postbuild-security-headers.mjs:36`). Round 2 marked effort: large.
- SEC2-008: per-account login throttle still uses sliding 15-minute window; no persistent failed-login counter. Round 2 effort: small. Not re-counted.
- SEC2-010: `src/lib/funnel-emails.ts:18-24` still defines a local `escapeHtml` that omits single-quote replacement. The canonical helper in `src/lib/email-safety.ts:15-23` includes `&#39;`. Round 2 effort: trivial.
- SEC2-011: Chart.js CDN script (`src/pages/portal/dashboard.astro:102`) still lacks `integrity=`. Google Fonts CSS still loaded cross-origin from the Portal layout. Round 2 effort: medium.
- SEC2-013: Cross-Origin-Embedder-Policy still intentionally omitted to preserve cross-origin asset loading. Round 2 effort: trivial (document the decision).

## Findings

### [SEC3-001] SSRF guard does not resolve DNS; an attacker domain pointing to a private IP still bypasses the check

**Severity**: high
**OWASP category**: A10:2021 Server-Side Request Forgery
**Files**: `src/lib/scraper.ts:55-100, 106-130`
**Observation**: `isAllowedFetchUrl` validates `parsed.hostname` against literal IPv4/IPv6 ranges and a small set of bad-name suffixes. It never calls `dns.lookup` to resolve the hostname before deciding whether to fetch. An attacker who controls a public hostname (a domain they registered, or a subdomain they got delegated) can set its DNS A record to `127.0.0.1`, `169.254.169.254` (cloud metadata), or any RFC 1918 address. The guard's hostname check passes because the literal string is, for example, `attacker.example.com`, not a numeric IP. The fetch then resolves and connects to the private IP, sending the request to the internal target. Cheerio parses whatever HTML the metadata service or internal admin endpoint returns and stuffs it into the mention's `full_text` and `snippet`, which then become readable to anyone with a valid report token for that scan.

The IPv4-literal check also misses non-decimal representations. `new URL('http://2130706433/')` produces `parsed.hostname === '2130706433'` (some Node versions normalize, some don't); the dotted-quad regex on line 74 fails to match, so the IP-literal branch never runs. `http://0177.0.0.1/` and `http://0x7f.0.0.1/` are similarly potentially under-handled depending on URL parser behavior across Node versions. Worth specifically asserting on the resolved IP rather than the literal string.

The redirect-revalidation loop at lines 112-130 inherits the same limitation: the Location header from a 302 is re-passed through `isAllowedFetchUrl`, which checks the hostname literally and again does not perform DNS resolution.

**Attack scenario**: Attacker registers `metadata-proxy.attacker.example`, points its A record at `169.254.169.254`. They plant a page that ranks for some target brand on a Serper-indexed site, then submit that brand to `/api/scan`. The scan returns `metadata-proxy.attacker.example` among results. `isAllowedFetchUrl` passes (the hostname is not localhost, not in the IPv4 private range, has no IPv6 colon, does not end in `.local`/`.internal`/etc.). `fetch()` resolves the hostname to `169.254.169.254`. On AWS this is the IMDS endpoint. The response body, including IAM credentials if IMDSv1 is enabled, gets stored as the mention body. Attacker re-runs the scan as themselves, unlocks the report with a real email, and reads the credentials from the mention list.

**Recommendation**: Before fetching, do `dns.lookup(parsed.hostname, { all: true })` and reject if any returned address is in a private/loopback/link-local/CGNAT/multicast range. Connect using the resolved IP rather than the hostname (set the `Host` header to preserve virtual-host routing) to defeat DNS rebinding. The Node ecosystem has the `ssrf-req-filter` and `request-filtering-agent` packages that do exactly this; alternatively, write 20 lines of `dns` + `net.isIP` + custom `Agent`. Also normalize IPv4 representations through `net.isIPv4` against the post-parsed hostname, not the raw literal.

**Effort**: small
**Verification**: Stub Serper to return `https://attacker.example/` where attacker.example resolves to 127.0.0.1 in the test resolver; confirm `scrapeSinglePage` returns null without making the connection.

### [SEC3-002] `/portal/api/notifications` GET accepts unbounded `limit` from URL params

**Severity**: medium
**OWASP category**: A05:2021 Security Misconfiguration / DoS surface
**Files**: `src/pages/portal/api/notifications/index.ts:22`
**Observation**: After SEC2-004 clamped `limit` and `months` on the dashboard endpoints, one limit-bearing endpoint slipped through: `getNotifications(locals.user.id, limit)` reads `parseInt(url.searchParams.get('limit') || '50', 10)` with no upper bound. The value flows directly into `SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?` (`src/lib/notifications.ts:69-74`). Notifications grow with portal usage; a long-running portal account with months of history could produce a multi-megabyte JSON response per request. Per-user scope reduces blast radius compared to the dashboard surface, but a single compromised client account can still amplify cheap GETs into expensive Turso reads and Node serialization.

**Attack scenario**: A compromised client account scripts 50 concurrent GETs to `/portal/api/notifications?limit=999999999`. Turso pulls every notification row for that user, Node JSON-stringifies, and the response goes out. Memory pressure on the standalone Node process.

**Recommendation**: Same fix as SEC2-004. Clamp with `Math.min(Math.max(parseInt(...) || 50, 1), 200)`. The existing UI never requests more than 50.

**Effort**: trivial
**Verification**: GET with `?limit=99999999`, confirm response bounded to the clamp ceiling.

### [SEC3-003] Magic-link issuance route is fail-open on rate-limit DB error

**Severity**: medium
**OWASP category**: A05:2021 Security Misconfiguration
**Files**: `src/pages/portal/auth/send-link.ts:15`
**Observation**: `/portal/auth/send-link` calls `rateLimit(`login:${ip}`, 10, 15 * 60 * 1000)` without the fail-closed flag. SEC-016 retrofitted fail-closed throttling onto the password login endpoints; this magic-link issuance endpoint was missed. Send-link triggers a Brevo API call (paid per email) and a Turso write. A Turso outage that drops the rate-limit DB into the fail-open branch lets one attacker fire unlimited magic-link emails from one IP, burning Brevo credits and spamming the targeted inboxes.

Also note a key-naming inconsistency that splits the counter: `send-link.ts` keys on `login:${ip}` while `login.ts` keys on `login:ip:${ip}`. The throttle windows are separate. An attacker hitting both endpoints uses two independent 10-request windows instead of one shared 10-request window.

**Attack scenario**: During a Turso brownout, an attacker scripts 500 send-link requests against a known target email. The DB rate-limit calls error and return `true` (allow). Brevo sends 500 emails; 500 magic links queue in the database. Even though `userHasPassword` early-exits for users who already have a password, the rate-limit gate is the only thing that stops a script from probing one IP against a list of email addresses to enumerate which ones don't yet have a password set.

**Recommendation**: Pass `failClosed: true` to the `rateLimit` call. Unify the key with `login.ts` (use `login:ip:${ip}` everywhere). Optionally also add a per-email throttle (`magic-link:${emailLower}`) so a rotating-IP botnet cannot drain magic-link issuance for one target.

**Effort**: trivial
**Verification**: Simulate a Turso error and confirm send-link returns 429 or 500 rather than emailing.

### [SEC3-004] `verifyPassword` legacy SHA256 path leaks user-bucket timing and uses non-constant-time compare

**Severity**: medium
**OWASP category**: A07:2021 Identification and Authentication Failures
**Files**: `src/lib/auth.ts:104-132`
**Observation**: `verifyPassword` branches on `isLegacySha256(storedHash)`. The legacy branch runs `legacySha256Hash(password)` (one SHA-256, microseconds) plus a `storedHash !== inputHash` string compare. The bcrypt branch runs `bcrypt.compare` at cost 12 (~250ms). For a stranger hitting the login endpoint, three response-time buckets are externally distinguishable:

1. Email not found: ~1ms (DB miss).
2. Email exists, legacy SHA256 hash: ~5ms (SHA + compare).
3. Email exists, bcrypt hash: ~250ms (bcrypt compare).

The `===` on line 117 is also not constant-time; a length mismatch returns in nanoseconds, and the JS engine can short-circuit on the first differing character. SHA-256 outputs are fixed length so the length-equal path always runs, but byte-level branching still leaks a small amount of information.

Round 2 documented user enumeration as a known issue in SEC-024's resolution comments but did not address the legacy-path timing. With every successful legacy login, the user migrates to bcrypt, so the leak shrinks over time. In the meantime, anyone scraping the public-facing /portal/login can rate-limit-around the per-IP cap and harvest a candidate list of valid emails and which subset is still on legacy hashes.

**Attack scenario**: Attacker scripts login attempts for a list of guessed emails, measuring response time. Emails in bucket (2) and (3) are "real users." Bucket (2) users are higher-priority targets because their password is locked behind one SHA-256 hash, vulnerable to offline brute force if the DB ever leaks. Per-email throttle slows the attack but does not make the buckets indistinguishable.

**Recommendation**: To close the user-existence leak entirely, run a synthetic bcrypt verification when no row matches (and one when the row matches but has no hash). To close the legacy-vs-bcrypt leak, drop the legacy path: it has been in place since round 1 and any user who has logged in once is already on bcrypt. Either drop the legacy branch outright (force a password reset for the remaining legacy users) or rehash legacy users with bcrypt on every read regardless of password match (one bcrypt cost on every login). The `storedHash !== inputHash` compare should also be a constant-time comparison via `crypto.timingSafeEqual` or `@oslojs/crypto`'s comparator, even though the practical exploit is small.

**Effort**: small
**Verification**: Measure login response times for nonexistent, legacy-hashed, and bcrypt-hashed users; confirm they all fall within one bucket (typically the bcrypt cost ~250ms).

### [SEC3-005] Report-token and CSRF tokens use `sha256(secret + ':' + data)` instead of HMAC

**Severity**: low
**OWASP category**: A02:2021 Cryptographic Failures
**Files**: `src/lib/report-token.ts:28-31`, `src/lib/csrf.ts:21-24`
**Observation**: Both signing helpers compute their MAC as `sha256(SECRET + ':' + data)`. SHA-256 is a Merkle-Damgard hash and the "secret-prefix" MAC construction is theoretically susceptible to length-extension attacks: given a valid (data, MAC) pair, an attacker can compute MAC for `data + padding + extension` without knowing the secret. Neither construction is exploitable as written because the verifier reconstructs the canonical message string from server-controlled inputs (scan ID, session ID, timestamp) and does not honor attacker-supplied trailing bytes. The signed payload an attacker recovers is bound to the inputs the server reproduces; there is no place to splice in attacker-controlled extension data that the verifier would happen to re-derive.

Still, "secret-prefix MAC" is on the OWASP cheat sheet of patterns to avoid, and `@oslojs/crypto` already exports a proper HMAC implementation (the same library both files already import). The fix is one line per file: import `hmac` and `SHA256` from `@oslojs/crypto/hmac` and `@oslojs/crypto/sha2`, replace the `encoded = new TextEncoder().encode(SECRET + ':' + data); sha256(encoded)` with `hmac(SHA256, secretBytes, dataBytes)`. The output is the same length so the constant-time-comparison loop downstream needs no change.

This is filed low rather than info because the same hash construction appears in two security-critical places and the cost to use proper HMAC is genuinely zero.

**Attack scenario**: No practical exploit against the codebase as written. If a future change ever lets attacker-controlled bytes flow into the data string the verifier reconstructs, length extension becomes exploitable; preempting that with proper HMAC is cheaper than re-auditing every change for the trap.

**Recommendation**: Replace both `hmac()` helper functions with `@oslojs/crypto/hmac.hmac(SHA256, secretBytes, dataBytes)`. Both modules already depend on `@oslojs/crypto`; no new dependency required. Note that the secret in `import.meta.env` is a string; encode to bytes via `TextEncoder` once at module load and reuse the byte array.

**Effort**: trivial
**Verification**: Tokens generated before the fix should validate identically post-fix only if both sides agree on the construction. Plan: rotate `REPORT_SECRET` and `CSRF_SECRET` at the same time as the construction change so any tokens in flight expire cleanly; users sign in again.

### [SEC3-006] `/api/quiz` accepts arbitrary-length name and email with no format validation

**Severity**: low
**OWASP category**: A03:2021 Injection / A05:2021 Security Misconfiguration
**Files**: `src/pages/api/quiz.ts:18-24`
**Observation**: `/api/quiz` validates `!name || !email` but performs no email format check (unlike `/api/contact.ts:35` which has `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`), no length cap on `name` or `email`, and no input sanitization beyond what `escapeHtml` and `stripCRLF` provide downstream. The `email` value is passed directly to Brevo's `to` field. Brevo will reject obviously malformed addresses but a syntactically-loose address that passes Brevo's parser could route to an unintended mailbox; a very long `name` (megabytes) could OOM the JSON serialization. The form is rate-limited per IP at 5/hour, which bounds abuse but not abuse per request.

The `answers` object is also forwarded into the email subject as `${q1} / ${q2} / ${q3} / ${q4}` after looking up labels; the lookup defaults to `?` for unknown keys so this is safe, but the original `theme` value goes through `escapeHtml(theme || '')` in the body. That is safe.

**Attack scenario**: Attacker submits a quiz with `name = "a".repeat(10_000_000)`. Server stringifies the body into the Brevo POST. Memory spike per request. With a single IP and 5/hour, the practical impact is small; with a botnet rotating IPs, the request body size cap in middleware (1MB on `/portal/api/*`) does not apply because this is a public endpoint, and the request body cap on public endpoints is only Astro's default (no explicit limit).

**Recommendation**: Add length caps on `name` (e.g. 200 chars) and `email` (e.g. 254 chars per RFC 5321). Add the same email regex as `/api/contact.ts`. Optionally tighten the rate limit to fail-closed.

**Effort**: trivial
**Verification**: POST with a 10MB `name` and confirm the server rejects with 400 before invoking Brevo.

### [SEC3-007] Activity-log page interpolates `clientFilter` into URLs without `encodeURIComponent`

**Severity**: low
**OWASP category**: A03:2021 Injection
**Files**: `src/pages/portal/admin/activity.astro:113, 124`
**Observation**: The pagination links interpolate `clientFilter` (from `Astro.url.searchParams.get('client')`) directly into `href` attribute strings: `?page=${page - 1}${clientFilter ? `&client=${clientFilter}` : ''}`. Astro escapes the value in the attribute output so XSS is not exploitable, but the parameter never goes through `encodeURIComponent`. A client ID containing `&`, `#`, `=`, or a stray space would break URL parsing on the next request (the parameter would be split or truncated). Client IDs are nanoids in practice (alphanumeric, URL-safe), so this is not currently exploitable, but the pattern is fragile.

The same param flows directly into `getRecentActivity({ clientId })` which uses parameterized SQL, so SQL injection is not in scope.

**Attack scenario**: Today's nanoid alphabet contains `_` and `-` and is URL-safe, so no live exploit. If the ID schema ever changes to UUID-with-dashes or a slug, the pagination URLs break silently.

**Recommendation**: Wrap with `encodeURIComponent(clientFilter)` in both interpolations. Two-character fix.

**Effort**: trivial
**Verification**: Set `?client=abc%26def` (encoded ampersand), follow the pagination link, confirm the query roundtrips.

### [SEC3-008] Magic-link onboarding still establishes a 30-day session without a password (SEC2-006 carryover)

**Severity**: low
**OWASP category**: A07:2021 Identification and Authentication Failures
**Files**: `src/pages/portal/auth/verify.ts:14-37`
**Observation**: Round 2 flagged SEC2-006 (onboarding flow auto-creates a 30-day session via `createSession` on first magic-link visit, no password setup gate). This audit confirms the flow is unchanged: `verify.ts` calls `createSession(userId)` directly and redirects to `/portal/dashboard`. The path documented in round 2 (redirect to a set-password page, issue a short-lived setup session until a password is set) remains a future improvement. Flagged again at the same severity as round 2 because the threat model has not changed and the round-2 entry was effort: small.

**Attack scenario**: Same as SEC2-006.
**Recommendation**: Same as SEC2-006.
**Effort**: small
**Verification**: Same as SEC2-006.

### [SEC3-009] Cookie `path=/portal` lets a public-side XSS (today: unlikely) leak the session cookie

**Severity**: info
**OWASP category**: A05:2021 Security Misconfiguration
**Files**: `src/pages/portal/auth/login.ts:49-55`, `src/pages/portal/auth/verify.ts:31-37`
**Observation**: The session cookie is set with `path: '/portal'`, which scopes the cookie to portal routes only. That is the correct default. The cookie is also `httpOnly: true`, `secure: true`, and `sameSite: 'lax'`. Defensible. The reason this is flagged at info is that `sameSite: 'lax'` allows the cookie to ride along on top-level navigations. If a future feature added a portal-side endpoint that performed a GET-triggered state mutation (e.g. a confirm-action GET URL), a cross-site link to it would carry the cookie. The portal currently uses POST for every mutation and gates them all with HMAC CSRF, so the exposure is theoretical.

Worth tracking in case a future contributor adds a GET-triggered action.

**Recommendation**: Continue the current discipline: no GET-triggered mutations on `/portal/*`. Optionally consider `sameSite: 'strict'` for the session cookie if cross-site links into the portal are rare; the trade-off is that following a link to a portal page from an external referrer (email link, Slack share) would require a re-login. The magic-link flow specifically uses GET, so `strict` would break it. Document the trade-off in code.
**Effort**: n/a
**Verification**: n/a

### [SEC3-010] `escapeHtml` duplication in `funnel-emails.ts` still missing single-quote escape (SEC2-010 carryover)

**Severity**: info
**OWASP category**: A03:2021 Injection
**Files**: `src/lib/funnel-emails.ts:18-24`
**Observation**: Confirmed unchanged from round 2. The canonical helper in `src/lib/email-safety.ts` escapes single quote to `&#39;`; the local helper in `funnel-emails.ts` does not. Both helpers escape `&`, `<`, `>`, and `"`. Not exploitable as written because the rendered context is HTML text content, not attribute. Flagged info because round 2 listed it as effort: trivial and it has not been touched.

**Recommendation**: Same as SEC2-010. Delete the local helper, import from `email-safety.ts`.
**Effort**: trivial
**Verification**: Diff the two files; confirm only one `escapeHtml` exists in `src/lib`.

### [SEC3-011] Account lockout, CSP nonces, and Chart.js SRI remain unaddressed (round-2 carryovers)

**Severity**: info
**OWASP category**: A05:2021 Security Misconfiguration / A08:2021 Software and Data Integrity Failures
**Files**: `src/lib/auth.ts`, `src/middleware.ts:47-48`, `scripts/postbuild-security-headers.mjs:36`, `src/pages/portal/dashboard.astro:102`
**Observation**: Confirming these are still in the state round 2 left them:
- No `failed_login_attempts` column on `users` and no `locked_until` column. Per-account throttle is the only barrier (SEC2-008).
- CSP still ships `'unsafe-inline'` for both `script-src` and `style-src` in middleware and postbuild wrapper. Astro 6 supports nonce-based CSP via `defineMiddleware` and `is:inline` updates (SEC2-012).
- Chart.js script tag at `dashboard.astro:102` still lacks `integrity=` (SEC2-011). The script is pinned to `chart.js@4.4.8` so an SRI hash is feasible.
- COEP intentionally not set (SEC2-013).

None are regressions. All four were captured in round 2 with effort estimates ranging trivial to large. Re-flagging at info purely so the round-3 doc carries the complete current state.

**Recommendation**: See round 2 entries.
**Effort**: see round 2.
**Verification**: see round 2.

## Strengths

- Round 2 critical (TLS off process-wide), high (SSRF), and the medium items called out in the task brief were all addressed in commit `a12ff08` and remain addressed at `5964421`. The SSRF guard, while it has the DNS-resolution gap noted in SEC3-001, is far better than no guard and would defeat the simplest attack (a search result that 302s straight to `http://169.254.169.254`).
- The report token now binds `REPORT_SECRET`, scan ID, and an issued-at timestamp with constant-time comparison and a 30-day TTL. Token leakage is bounded by the cryptographic clock, not just the data-retention clock.
- The new SEO/schema commit (`5964421`) introduces only static JSON-LD payloads built from literals at the top of each Astro page. `set:html` is fed `JSON.stringify(object_literal)`; no user input flows in, no injection surface created. The image-dim props on `Figure.astro` and `Gallery.astro` are typed as numbers and serialize harmlessly into HTML attributes.
- The portal login HTML changes (font preload, separator-style preload, noscript fallback) introduce no new active script; the existing inline submit handler still uses `textContent` for error display, which is safe.
- The case-studies index page now renders an ItemList JSON-LD computed from `getCaseStudies()` and a static breadcrumb list. The values fed into the JSON come from MDX frontmatter (author-controlled) and run through `JSON.stringify`; no script context injection.
- `npm audit --json` reports zero vulnerabilities across 671 dependencies, in-session verified May 13 2026.
- Origin verification (`security.checkOrigin: true`) + middleware HMAC CSRF on every state-mutating `/portal/api/*` request + the CSRF check on the logout form + the magic-link/password split is a clean three-layer auth defense.
- Fail-closed rate limits in place on login (per-IP and per-email), the hourly scan cap, and naming-preview hourly/daily caps. Send-link is the one outlier flagged in SEC3-003.
- File-upload pipeline (magic-byte detection, MIME consistency check, sanitized extension, `Content-Disposition: attachment`, signed S3 URL with `Referrer-Policy: no-referrer` on the 302) remains a high bar.
- Activity log captures every state-mutating action with user + entity + summary. The audit trail covers the threat model where a compromised admin is the attacker.
- Retention sweep runs at most once per hour and bounds the privacy-relevant data growth (request_log 90d, rate_limits 30d, portal_rate_limits 1h).
