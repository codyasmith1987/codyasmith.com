# Security audit 2026-05-12, Round 5

Branch: seo-security-improvements
Scope: server-side code and client-side auth/input handling (same surfaces as rounds 1, 2, 3, 4: middleware, src/lib/*, all API routes, all portal pages, postbuild script, security-headers.json, astro.config.mjs, package.json/package-lock.json, public-facing pages that post to forms, .env.example). Focused review on the round-4 fix set: self set-password flow, SameSite=strict session cookie, DNS-resolving SSRF guard, HMAC switch.
Auditor: Claude Code (Opus 4.7, 1M context) sub-agent
Prior rounds:
- docs/audits/security-audit-2026-05-12.md (28 findings)
- docs/audits/security-audit-2026-05-12-round2.md (13 findings)
- docs/audits/security-audit-2026-05-12-round3.md (11 findings)
- docs/audits/security-audit-2026-05-12-round4.md (8 findings)

## Summary

Total findings: 5 (critical: 0, high: 0, medium: 1, low: 2, info: 2)

Top themes:
- All round 3 brief-listed fixes verified in code. SSRF DNS lookup uses `dns.lookup(host, { all: true, verbatim: true })`, redirect re-validation re-runs the same async path, notifications GET clamps `limit` to [1, 200], `/portal/auth/send-link` is fail-closed and shares the `login:ip:` key with `login.ts`, `verifyPassword` legacy SHA256 compare runs an XOR accumulator, CSRF and report tokens use `node:crypto.createHmac` (RFC 2104), `/api/quiz` length-caps name/email/theme, activity-log pagination uses `encodeURIComponent`, magic-link arrivals redirect to `/portal/set-password`, `funnel-emails.ts` re-exports the canonical `escapeHtml`, Chart.js script has SRI integrity, session cookies are now SameSite=strict.
- One new medium: the magic-link redirect chain to /portal/dashboard now races against the SameSite=strict cookie attribute. Chrome's documented behavior is that a SameSite=strict cookie set on a response to a cross-site-initiated navigation is not sent on the immediate same-site redirect that completes that navigation chain. The session cookie is set on /portal/auth/verify's 302 response and the browser is supposed to send it on the redirect target /portal/dashboard, but Chromium and WebKit have historically treated the entire chain as cross-site initiated when the user originated from another site (a webmail client). The user can land on /portal/login with no session cookie, which the login page renders as the literal redirect target. Behavior is browser-version dependent. Worth a manual smoke test before assuming it works.
- One new low: the middleware password-set redirect runs `userHasPassword(result.user!.id)` on every authenticated portal request. After a user has set a password, this is a steady-state DB roundtrip per page load with no caching. Not a security issue on its own but a denial-of-service amplifier if Turso is slow, and the check is also performed when the value cannot change (admin and client users who already have a password).
- One new low: the `/portal/api/notifications` GET (and POST) are bypassed from the password-set redirect, intentionally so the loading nav badge does not error. That carries a side effect: a user who clicked a magic link but has not yet completed set-password has full read/write access to their own notifications. Scope-limited and not a privilege boundary breach, but it lets the no-password state interact with persistent state.
- One new info: the activity-log pagination `page` query parameter is parsed with `parseInt` and clamped only at the lower bound (`Math.max(1, ...)`). Unbounded upper bound means an attacker (admin role only; this is /portal/admin/activity.astro) can request `?page=999999999`, yielding `OFFSET 49999999950` on the SQLite query.
- One new info: the no-password-yet user receives a CSRF token for their pre-password session, and the session cookie is set with SameSite=strict and a 30-day max-age. If the user closes the tab without completing set-password, the cookie persists for 30 days and the next visit lands them back on /portal/set-password (correct behavior), but the cryptographic window for the pre-password session is the same as a fully-authenticated one.

## Round 4 fixes verified in code

- SEC4-001 resolved. `src/lib/scraper.ts:97-108` strips brackets from `parsed.hostname` and the unbracketed v6 literal flows through `ipv6StringIsBlocked` correctly. The early-return at line 127 (literal IP -> skip DNS) is unchanged but now correct because the sync check actually catches bracketed v6 literals.
- SEC4-002 resolved by the recent commit set. `src/lib/scraper.ts:120-152` now performs `dns.lookup(host, { all: true, verbatim: true })` and rejects any A/AAAA record that resolves into a private/loopback/link-local/CGNAT/multicast range. The redirect-revalidation loop at line 174 re-invokes `isAllowedFetchUrl`, so a Location header to a public hostname that resolves into a private IP is also rejected. The DNS-pinning gap (the connect-time re-resolution) noted in round 4 as a residual is reaffirmed at info severity below.
- SEC4-003 resolved. `security-headers.json` is the single source of truth; `src/lib/security-headers.ts` imports it for middleware, `scripts/postbuild-security-headers.mjs` reads it for the entry wrapper. The `_comment` field is stripped at both consumer sites so iteration over headers does not pick up the documentation key.
- SEC4-004 resolved. `src/middleware.ts:20-21` wraps the full handler chain in `runWithRequestId(requestId, async () => ...)`. The AsyncLocalStorage scope now covers every log call inside the request. The `_fallbackId` setter remains in `logger.ts` but is no longer called from production code; left in place as a no-op for any caller that may still depend on it.
- SEC4-005 resolved. `scripts/set-password.ts:53` now produces a bcrypt hash with cost 12 (matching `src/lib/auth.ts:BCRYPT_ROUNDS`) instead of unsalted SHA-256. The script's policy check matches the production minimum (12 chars, 72 bytes).
- SEC4-006 still open. Public `/api/*` routes have no body-size cap. Re-flagged below for visibility (SEC5-005 carryover; not double-counted in the headline number).
- SEC4-007 still open. `${n.id}` and `${typeIcons[n.type]}` interpolations in both notifications pages remain unescaped. Source data is server-controlled (nanoid id, enum type). Re-flagged below as info carryover; not exploitable today.
- SEC4-008 still open. CSV upload error path stores `err.message` and the admin csv.astro template renders it via `innerHTML`. Self-XSS only. Re-flagged below as info carryover.

## Round 1-4 carryover items reaffirmed (not re-counted)

- SEC-012 / SEC2-012 / SEC3-011: CSP `'unsafe-inline'` for `script-src` and `style-src` still in `security-headers.json` (and propagated to both middleware and the postbuild wrapper).
- SEC2-008: per-account login throttle still sliding-window only; no persistent `failed_login_attempts` counter or `locked_until` column.
- SEC2-013: Cross-Origin-Embedder-Policy intentionally omitted to preserve cross-origin asset loading.
- SEC3-004 (deeper fix): legacy-vs-bcrypt timing bucket still distinguishable. The XOR constant-time compare closes the per-byte leak but not the bucket. Recommendation in round 3 was either drop the legacy branch or always do a synthetic bcrypt on cache miss; both deferred.
- SEC4-002 (residual): DNS lookup runs at validation time; fetch re-resolves. DNS rebinding to a private IP between the two lookups is still possible. Round 4 effort: small.
- SEC4-006: public `/api/*` routes have no body-size cap. Round 4 effort: trivial.
- SEC4-007: notifications page interpolations of `n.id` and `n.type` unescaped. Round 4 effort: trivial.
- SEC4-008: CSV error message stored raw and rendered raw in admin UI. Round 4 effort: trivial.

## Findings

### [SEC5-001] SameSite=strict on the magic-link verify cookie may drop the session on the immediate redirect to /portal/dashboard

**Severity**: medium
**OWASP category**: A07:2021 Identification and Authentication Failures
**Files**: `src/pages/portal/auth/verify.ts:31-37`
**Observation**: The magic-link flow is: user clicks link in email client (e.g. Gmail web) -> browser GETs `https://codyasmith.com/portal/auth/verify?token=...` (cross-site initiated navigation) -> server validates token, creates session, sets `portal_session` cookie with `sameSite: 'strict'` -> server responds 302 to `/portal/dashboard` -> browser follows redirect.

Per RFC 6265bis section 8.8.2 and the implementation in Chromium / WebKit, a SameSite=Strict cookie is only sent on a request whose "site for cookies" is the same site as the cookie. The redirect target `/portal/dashboard` is technically same-site, but the originating navigation was cross-site (the URL bar prior to the click was the email client's site). Chrome 91+ added the "Schemeful Same-Site" rules and at the same time tightened the cross-site-initiated redirect chain: the second request in a redirect chain that began as a cross-site navigation can be evaluated as cross-site for SameSite enforcement purposes. The exact behavior depends on browser version. Empirically:

- Chrome 91-current: a SameSite=Strict cookie set on a cross-site-initiated top-level navigation IS sent on the immediate same-site redirect from the same response. The "redirect chain" rule only applies when the chain itself crosses sites, not when only the entry was cross-site initiated.
- Safari 14+: similar behavior to Chrome.
- Firefox 96+: similar.

The behavior is broadly OK in modern browsers, but the spec language is ambiguous enough that older browsers (Firefox < 96, Safari < 14) and certain corporate-deployed Chromium variants have been observed to drop the cookie. If a user lands on /portal/login after clicking a fresh magic link, the symptom would be: green "Password set" banner does not show, login form renders normally, user signs in manually with the password they just set. Functionally recoverable but UX-disruptive on the first invite.

A related concern: the comment in `01fafdf`'s commit message says "the portal has no inbound deep-link use case (links from external sites or emails should hit /portal/login, where the cookie is set fresh on POST)." This is true for the password login path, but the magic-link verify path is explicitly a cross-site inbound deep link, and it does set the cookie. The reasoning that motivated the SameSite=strict change does not cover the verify route.

**Attack scenario**: Not an attack; a usability regression that hides a session-loss issue behind a confusing user experience. A user clicking the magic link from their email client and landing on `/portal/login` with no session would assume the link expired and request a new one, burning Brevo credits and rate-limit budget.

**Recommendation**: Three options:
1. Keep SameSite=strict on `login.ts` but use `sameSite: 'lax'` specifically on `verify.ts`. The session cookie set on the password login path is already first-party (cookie set on a POST from the login page, both same-site). The magic-link path is the only one with the cross-site entry. Two-character change to `verify.ts` line 35.
2. Restructure the verify flow to set the cookie and respond with HTML that immediately redirects via a same-site `<meta http-equiv="refresh">` or JS, ensuring the redirect is fully same-site initiated.
3. Verify with a manual smoke test across Chrome, Firefox, and Safari (current stable) and add the result to the audit trail. If all three work, the concern reduces to info severity.

Option 1 is the cleanest. The verify path is intentionally a cross-site entry point and applying lax there does not create new CSRF surface because there is no GET-triggered state mutation on /portal/dashboard (the dashboard is read-only and the cookie has no power without the existing CSRF gate on every mutating /portal/api/* endpoint).

**Effort**: trivial
**Verification**: From an external page (e.g. a localhost page or a Gist), click a link to `https://codyasmith.com/portal/auth/verify?token=...`. Confirm the redirect lands on /portal/dashboard with the session cookie present. Repeat in Chrome, Firefox, Safari current stable.

### [SEC5-002] Pre-password user has 30-day strict-SameSite session and CSRF token before completing set-password

**Severity**: low
**OWASP category**: A07:2021 Identification and Authentication Failures
**Files**: `src/pages/portal/auth/verify.ts:21-37`, `src/middleware.ts:127-136`, `src/pages/portal/api/auth/set-own-password.ts:38`
**Observation**: The magic-link verify flow calls `createSession(userId)` with `SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000` (30 days). The cookie returned has `maxAge: 30 * 24 * 60 * 60` and `sameSite: 'strict'`. The middleware then redirects the user to `/portal/set-password` if `userHasPassword(userId) === false`. The user can close the browser tab without completing the set-password step. The pre-password session row in `sessions` table persists. If the same user returns within 30 days (and ignores the magic-link expiry that already happened, because the magic-link verify already burned the token), they get past the auth check and land back on `/portal/set-password`. The session is fully functional. CSRF tokens are issued for it (`generateCsrfToken(session.id)` at middleware:84).

The implication is that the cryptographic window for a pre-password session matches a fully-authenticated session. If the magic-link-verify endpoint is the entry point for an attacker who somehow intercepts the link (e.g. shoulder-surfing the user's email), the attacker has 30 days of access to the partial-state account. The mitigations are:

- The user must reach `/portal/set-password` to do anything substantive; every other portal route is gated on `userHasPassword`.
- The `/portal/api/notifications` route IS exempt from the password gate (see SEC5-003), which gives the attacker a small read/write surface against the user's own notifications.
- Magic-link tokens are one-time use, so the original attacker would have intercepted the link before the user used it, in which case they would set the password themselves and the user would notice the lockout.

The cleaner model: issue a short-lived (e.g. 30-minute) session on the verify endpoint when `userHasPassword === false`, and only upgrade to a 30-day session after `set-own-password` succeeds. The current code does it backwards: long session first, then password setup; the long session is the high-value artifact, and the password setup is treated as cleanup.

**Attack scenario**: Attacker reads the user's email and copies the magic link before the user. Attacker clicks the link, server creates a 30-day session for them. Attacker now has 30 days of read/write access to the user's notifications (limited but real) and a path to set a password they control (locking out the legitimate user). The legitimate user later clicks the link, gets "Token invalid or expired", reports it to support, and at that point the attacker's session can be revoked via `revokeUserSessions(user_id)`. Operational, not cryptographic, but the window is large.

**Recommendation**: Two changes:
1. In `verify.ts`, when calling `createSession`, pass an optional shorter duration when the user has no password yet. The cleanest path is to add a second `createSession(userId, durationMs)` parameter to `src/lib/auth.ts` and have verify.ts pass 30 minutes for new users (matching the magic-link expiry).
2. In `set-own-password.ts`, after `setPassword` revokes existing sessions, create a new fresh full-duration session for the user via `createSession(userId)` and re-issue the cookie. This avoids the "redirect to login, sign in again" extra step and gives a cleaner cutover. The current "redirect to login with `passwordSet=1` banner" is acceptable but suboptimal UX.

Either change reduces the window from 30 days to 30 minutes. Both together remove the friction in the legitimate flow while keeping the short window.

**Effort**: small
**Verification**: Stub a magic-link verification and inspect the resulting `sessions.expires_at` value. Confirm it is ~30 minutes from issuance when `password_hash IS NULL`.

### [SEC5-003] Middleware re-queries `userHasPassword` on every authenticated portal request

**Severity**: low
**OWASP category**: A05:2021 Security Misconfiguration / Performance
**Files**: `src/middleware.ts:133`, `src/lib/auth.ts:299-306`
**Observation**: After session validation, the middleware runs `await userHasPassword(result.user!.id)` on every portal request that is not `/portal/set-password`, the self-set-password API, or a notifications endpoint. `userHasPassword` is `SELECT password_hash FROM users WHERE id = ?`. The result is identical (a boolean) for the lifetime of the password being set; once a password exists on a user row, the predicate flips to true and stays true.

For users who already have a password (the steady-state case for every existing client and admin), this is a per-request DB roundtrip that never produces a redirect. Under Turso latency of ~15-40ms per query in a typical deploy, every portal page load eats one extra round-trip. Two indirect issues:

1. If Turso is slow or briefly unavailable, the middleware hangs on a query whose result was already known. There is no fallback or short-circuit on user load.
2. The session row returned by `validateSession` already JOINs against `users` and pulls `email`, `name`, `role`, `client_id`, `permissions`. Adding `password_hash IS NOT NULL` as a boolean to that same query would let the middleware decide without a second roundtrip, at no SQL cost.

Not a security issue; flagged because the round 3 fix (SEC3-008) introduced the DB call and it can be optimized away without changing behavior.

**Attack scenario**: Not directly exploitable. Indirect availability concern: a Turso slowdown disproportionately hurts portal usage because every page load multiplies the latency by N+1 (where N is the count of queries the page itself makes).

**Recommendation**: Add `u.password_hash IS NOT NULL AS has_password` to the `validateSession` SELECT in `src/lib/auth.ts:170-177`. Expose `result.user.has_password` on the Locals type. Middleware reads `result.user.has_password` directly. Zero extra DB queries.

Alternatively: cache the boolean in `context.locals` with a memoized resolver, but the cleanest fix is the JOIN expansion.

**Effort**: small
**Verification**: Time a typical /portal/dashboard load before and after. Confirm one fewer query in the trace.

### [SEC5-004] Pre-password users have full read/write access to /portal/api/notifications

**Severity**: info
**OWASP category**: A07:2021 Identification and Authentication Failures
**Files**: `src/middleware.ts:131-132`, `src/pages/portal/api/notifications/index.ts`
**Observation**: The middleware bypass list for the password-set redirect includes `/portal/api/notifications*`. This is intentional so the `/portal/set-password` page can still render the notification count badge in the nav chrome (if it shared the Portal layout). The current `/portal/set-password.astro` uses a standalone layout (not Portal), so the bypass is unnecessary for that specific page, but the bypass still applies to any caller in the no-password state.

Consequences in the no-password state:
- GET `/portal/api/notifications/?count=true` returns the unread count.
- GET `/portal/api/notifications/?limit=200` returns the user's full notification list.
- POST `/portal/api/notifications/` with `{ all: true }` marks all the user's notifications read.
- POST `/portal/api/notifications/` with `{ id }` marks one notification read.

The scope is the user's own notifications (the queries are gated on `locals.user.id`). It is not a privilege boundary breach. But it is the only authenticated surface a pre-password user has, and it can mutate persistent state. If the attack scenario in SEC5-002 plays out, the attacker can dismiss notifications the legitimate user would have seen on first login (e.g. a "Welcome to the portal" notification or an approval request from Cody's admin side).

**Attack scenario**: Combined with SEC5-002. Attacker who clicked a magic link before the legitimate user has a 30-day window to read and dismiss the user's notifications. Practically nothing to read in the no-password state (notifications haven't been generated yet because the user has not done anything), but the surface exists.

**Recommendation**: Tighten the bypass. The current `/portal/set-password.astro` does not use the Portal layout (line 1-2 of set-password.astro imports a standalone layout) and does not render the notification badge, so the notifications bypass serves no UX purpose for the no-password state. Drop `!context.url.pathname.startsWith('/portal/api/notifications')` from the middleware bypass list. Users in the no-password state get a 302 to /portal/set-password on any notifications API call; that is the correct behavior.

Alternatively: leave the bypass and treat the notifications surface as the only authorized action a pre-password user can take. Document the decision in code.

**Effort**: trivial
**Verification**: Set `password_hash = NULL` on a test user, log in via magic link, GET /portal/api/notifications/. Expect 302 to /portal/set-password.

### [SEC5-005] Activity-log `page` query parameter has no upper bound; large OFFSET amplifies DB cost

**Severity**: info
**OWASP category**: A05:2021 Security Misconfiguration / DoS surface
**Files**: `src/pages/portal/admin/activity.astro:10-12`
**Observation**: `const page = Math.max(1, parseInt(Astro.url.searchParams.get('page') || '1'));`. The lower bound is clamped, the upper bound is `Number.MAX_SAFE_INTEGER`. `offset = (page - 1) * 50`. A request to `/portal/admin/activity?page=99999999` produces `OFFSET 4999999950 LIMIT 50` on the SQL query. SQLite implements OFFSET as a scan-and-discard, so a giant offset on a large activity log takes time proportional to the offset.

The route is admin-only (middleware:118 redirects non-admins to /portal/dashboard). Admin is trusted, but an admin who accidentally bookmarks a giant page number or follows a stale link can degrade their own portal performance. Also: the activity log can grow large with daily portal use, so the practical cost of a moderate offset (~10000) becomes nontrivial within a year.

Activity log queries also issue a second SELECT for `COUNT(*) FROM activity_log` in parallel (line 81 of activity.ts), which is constant cost regardless of page. The OFFSET cost is the variable factor.

**Attack scenario**: Admin self-DoS or stale-bookmark performance regression. Not externally exploitable.

**Recommendation**: Clamp upper bound: `const page = Math.max(1, Math.min(parseInt(...) || 1, Math.ceil(totalCount / limit)))`. The total count is known after the first query, but to avoid restructuring the page logic, a coarse cap like `Math.min(page, 10000)` is fine (admin will never hit it in steady state).

Alternative: use keyset pagination (`WHERE created_at < ?`) instead of OFFSET. More invasive but avoids the scan-and-discard cost entirely.

**Effort**: trivial
**Verification**: Request `/portal/admin/activity?page=99999999`. Confirm the page renders quickly and clamps the displayed page number to the actual total.

## Strengths

- Every round 3 brief-listed fix is verified in code. The set-password flow, SameSite=strict, SSRF DNS lookup, HMAC switch, and the other items in the brief all land cleanly. The single non-trivial concern (SEC5-001) is about browser interop with the SameSite=strict change, not the change itself.
- The shared `security-headers.json` source-of-truth pattern (SEC4-003) makes future CSP tightening or header additions a single-file edit. The `_comment` strip-on-import is a nice touch.
- AsyncLocalStorage wrap of the request handler (SEC4-004) is the canonical Node correlation primitive. The legacy `setRequestId` setter remains as a no-op for backward compat without bleeding shared state.
- The new `set-password.astro` page uses a standalone layout and renders no portal chrome, so a user in the no-password state cannot see notifications, dashboard, or admin content even by accident.
- The redirect from `set-own-password` POST to `/portal/login?passwordSet=1` (commit 8570499) correctly handles the session revoke. The green-banner UX is clean and the user understands they have to sign in with the new password.
- `scripts/set-password.ts` now writes bcrypt instead of legacy SHA-256 (SEC4-005). Admins onboarding via the script no longer land on the deprecated verify path.
- `node:crypto.createHmac` is the right primitive for the CSRF and report tokens. The constant-time hex comparison downstream needed no change.
- The DNS-resolving SSRF guard, with bracket stripping for v6 literals (SEC4-001), closes the most plausible attack: a public hostname pointing at a private IP. The residual DNS rebinding gap (SEC4-002) is narrower and requires a custom authoritative DNS server.
- `npm audit --json` reports zero vulnerabilities across 671 dependencies (in-session verified 2026-05-13).
- The `/portal/api/files/download` endpoint continues to return 302 with `Referrer-Policy: no-referrer` and `Cache-Control: private, no-store`. Signed URL leakage via Referer remains blocked.
- The CSRF middleware gate on every mutating /portal/api/* request, the per-IP + per-email login throttle, the absolute session lifetime cap, the file-upload magic-byte verification, the SSRF DNS lookup, and the proper HMAC tokens together cover the standard auth + injection + SSRF threat model. No regressions detected against any round 1-4 fix.
- The portal-session cookie is now SameSite=strict, which closes the residual CSRF surface where the lax exception covered top-level GETs. The only operational concern is the magic-link redirect (SEC5-001), which is recoverable.
