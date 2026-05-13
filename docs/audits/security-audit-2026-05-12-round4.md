# Security audit 2026-05-12, Round 4

Branch: seo-security-improvements
Scope: server-side code and client-side auth/input handling (same surfaces as rounds 1, 2, and 3: middleware, src/lib/*, all API routes, all portal pages, postbuild script, astro.config.mjs, package.json/package-lock.json, public-facing pages that post to forms, .env.example).
Auditor: Claude Code (Opus 4.7, 1M context) sub-agent
Prior rounds:
- docs/audits/security-audit-2026-05-12.md (28 findings)
- docs/audits/security-audit-2026-05-12-round2.md (13 findings)
- docs/audits/security-audit-2026-05-12-round3.md (11 findings)

## Summary

Total findings: 8 (critical: 0, high: 1, medium: 2, low: 3, info: 2)

Top themes:
- The new DNS-resolving SSRF guard closes SEC3-001's main concern (a public hostname pointing at a private IP) but inherits a long-standing bracket bug: `URL.hostname` for an IPv6 literal in Node 22 returns the address with square brackets intact (e.g. `[::1]`), and every IPv6 check in `scraper.ts` does a literal compare or `startsWith` that fails to match the bracketed form. Result: `http://[::1]/`, `http://[fc00::1]/`, `http://[fe80::1]/`, `http://[ff02::1]/`, and `http://[::ffff:127.0.0.1]/` all pass the guard and reach loopback/ULA/link-local/v4-mapped addresses. The same bug existed in round 2; the comment in round 3's audit asserted it was handled but the code path is broken in practice.
- The DNS lookup happens at validation time but the subsequent `fetch()` does its own resolve, so a DNS rebinding attacker can return a public IP to the validation lookup and a private IP to the connect. SEC3-001 explicitly called this out as a follow-on ("Connect using the resolved IP rather than the hostname") and the gap is unaddressed.
- All medium/low/info round-3 carryovers that were marked effort small or trivial remain in place: quiz endpoint length caps, activity log encodeURIComponent, magic-link onboarding password setup, funnel-emails escapeHtml dedupe, Chart.js SRI, account lockout, CSP nonces. None are regressions.
- One new low: the postbuild monkey-patch on `http.createServer` sets baseline security headers via `res.setHeader`, but Astro's SSR routes can `set()` a fresh `Content-Security-Policy` that replaces the wrapper's value. Middleware in `src/middleware.ts` does exactly this for every route. The two CSPs match today, so functionally identical, but the model is fragile and easy to drift.
- One new info: shared-state `_fallbackId` in logger.ts can cross-correlate log entries across concurrent requests. AsyncLocalStorage exists in the module but `setRequestId` (the only call site from middleware) writes to the module-level fallback rather than entering an ALS scope.

## Round 3 fixes verified in code

- SEC3-001 partially resolved. `src/lib/scraper.ts:121-147` now does `dns.lookup(host, { all: true, verbatim: true })` and rejects if any returned IPv4 address matches `ipv4DecimalIsBlocked` or any IPv6 address matches `ipv6StringIsBlocked`. Redirect re-validation at line 174 reuses the same async path. Caveats captured in SEC4-001 and SEC4-002 below.
- SEC3-002 resolved. `src/pages/portal/api/notifications/index.ts:24-25` clamps `limit` to `Math.min(Math.max(rawLimit, 1), 200)` and the comment cites SEC3-002.
- SEC3-003 resolved. `src/pages/portal/auth/send-link.ts:19` passes `failClosed=true` and uses the unified key `login:ip:${ip}` matching `login.ts:16`. Per-IP throttle is now shared between the two auth paths.
- SEC3-004 resolved. `src/lib/auth.ts:114-134` builds an XOR-accumulator constant-time compare for the legacy SHA256 branch, with a length check that short-circuits cleanly when the hashes do not match in length. The recommended "drop the legacy branch outright or run a synthetic bcrypt on cache miss" is the deeper fix and stays outstanding as a future improvement (the timing buckets between bcrypt-user / legacy-user / no-user still differ by orders of magnitude). The audit flagged this in SEC3-004's recommendation; this round does not re-count it because the constant-time fix was the stated scope.
- SEC3-005 resolved. `src/lib/csrf.ts:11,27-29` and `src/lib/report-token.ts:15,31-33` now import `createHmac` from `node:crypto` and compute the MAC as `createHmac('sha256', SECRET).update(data).digest('hex')`. Both modules retain their existing constant-time hex comparison downstream. Proper RFC 2104 HMAC, no length-extension surface.

## Round 1, 2, and 3 carryover items reaffirmed (not re-counted)

- SEC-012 / SEC2-012 / SEC3-011: CSP `'unsafe-inline'` for `script-src` and `style-src` still in `src/middleware.ts:47-48` and `scripts/postbuild-security-headers.mjs:36`.
- SEC2-008: per-account login throttle still sliding-window only; no persistent `failed_login_attempts` counter or `locked_until` column.
- SEC2-010 / SEC3-010: `src/lib/funnel-emails.ts:18-24` local `escapeHtml` still missing single-quote replacement.
- SEC2-011: Chart.js CDN script at `src/pages/portal/dashboard.astro:102` still lacks `integrity=`.
- SEC2-013: Cross-Origin-Embedder-Policy intentionally omitted to preserve cross-origin asset loading.
- SEC3-006: `/api/quiz` (`src/pages/api/quiz.ts:18-25`) still validates only presence of name/email, no email regex, no length cap. The unchanged `escapeHtml` and `stripCRLF` downstream stop injection, but the request body is unbounded and the email format is unenforced.
- SEC3-007: `/portal/admin/activity.astro:113,124` still interpolates `clientFilter` into `href` without `encodeURIComponent`.
- SEC3-008: `/portal/auth/verify.ts:21-37` still creates a 30-day session on first magic-link click without a password-setup gate.
- SEC3-009: session cookie `path: '/portal'` and `sameSite: 'lax'` still the defensible status quo.

## Findings

### [SEC4-001] IPv6 literal URLs bypass the SSRF guard because Node returns bracketed `hostname`

**Severity**: high
**OWASP category**: A10:2021 Server-Side Request Forgery
**Files**: `src/lib/scraper.ts:76-87, 116, 127`
**Observation**: `parsed.hostname` for an IPv6 literal URL returns the bracketed form in Node 22 (verified locally: `new URL('http://[::1]/').hostname === '[::1]'`). Every IPv6 check in `scraper.ts` operates on the literal string with no bracket stripping:
- `ipv6StringIsBlocked` (lines 76-87) compares `host === '::1' || host === '::'` and `host.startsWith('fc' | 'fd' | 'fe80' | 'ff')`. Against `[::1]`, `[fc00::1]`, `[fe80::1]`, `[ff02::1]`, `[::ffff:127.0.0.1]` it returns `false` for all five.
- `syncUrlIsRejected` (line 116) calls `ipv6StringIsBlocked` with the raw bracketed host.
- `isAllowedFetchUrl` (line 127) takes the host through DNS only when `!host.includes(':')`, so bracketed v6 literals always skip the DNS path. Even if DNS ran, `dns.lookup('[::1]')` returns `[{ address: '::1', family: 6 }]`, and the address-side check goes through `ipv6StringIsBlocked` again where the same bracket-naive logic fires (this time on `::1` without brackets, which would actually match) but the early-return at line 127 prevents the DNS path from running at all.

The net effect: `http://[::1]/`, `http://[fc00::1]/` (ULA), `http://[fe80::1]/` (link-local), `http://[ff02::1]/` (multicast), and `http://[::ffff:127.0.0.1]/` (v4-mapped loopback) all pass the SSRF guard, and `fetch()` on a bracketed v6 URL attempts the TCP connect to that address (verified locally; fetch errors only because nothing is listening on the test port).

The round 3 audit summary stated the SSRF guard "rejects IPv6 loopback, ULA, link-local, multicast, and v4-mapped variants." It does not.

**Attack scenario**: Two delivery paths.
1. Direct: an attacker plants a public page that ranks for a target brand. The page's URL gets served by Serper. The attacker arranges for the URL to be a bracketed v6 form (rare but possible if the listing site uses v6 link rendering). Scan calls `scrapeSinglePage('http://[::1]:8080/')` and reaches a local admin interface.
2. Redirect: more practically, attacker registers `metadata.attacker.example`, serves a 302 `Location: http://[fd00::1]/`. The redirect revalidation at scraper.ts:174 re-runs the same bypassed check. fetch follows the redirect to the ULA address. On a deploy that has any v6-bound internal service (Postgres on `[::1]:5432`, an admin sidecar on `[::1]:8080`), the scraper proxies the request and Cheerio dumps the response into the mention body.

**Recommendation**: Strip brackets from `parsed.hostname` once at the top of `syncUrlIsRejected`, normalize to a bare v6 address, and run all checks on the unbracketed form. The same normalized host then passes safely to `dns.lookup`. Two-line fix:

```ts
let host = parsed.hostname.toLowerCase();
if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
```

Also drop the early-return at line 127 (the "literal IP, skip DNS" branch) once the sync check actually validates v6 literals. Keeping it is fine as long as the sync check is correct. While here, expand `ipv6StringIsBlocked` to handle the omitted-zeros forms (e.g. `0:0:0:0:0:0:0:1` is equivalent to `::1`); `net.isIP` plus a canonical normalization via the `ip-address` package would be more robust than string-prefix matching.

**Effort**: small
**Verification**: Stub the URL list to `['http://[::1]/', 'http://[fc00::1]/']`. Confirm `scrapeSinglePage` returns null before issuing a fetch.

### [SEC4-002] SSRF DNS check is not pinned to the connect; rebinding attacker can still reach private IPs

**Severity**: medium
**OWASP category**: A10:2021 Server-Side Server Request Forgery
**Files**: `src/lib/scraper.ts:121-147, 162-169`
**Observation**: `isAllowedFetchUrl` resolves the hostname and inspects every returned address, but `fetch(current)` then re-resolves the hostname through its own resolver. A DNS authoritative server controlled by an attacker can serve a public IP to the validation lookup (TTL 0) and a private IP to the connect lookup. The IP that the SSRF guard certified is not the IP the connection uses. SEC3-001's recommendation explicitly named this: "Connect using the resolved IP rather than the hostname (set the `Host` header to preserve virtual-host routing) to defeat DNS rebinding."

The exposure is narrower than SEC4-001 because the attacker has to host a custom resolver, run a real-time switch on the answer, and time the second lookup correctly. Some Node versions cache DNS results within a single process for the duration of the request, which incidentally pins the answer; this is not a documented guarantee and depends on the platform's `getaddrinfo` cache and the request's lifecycle.

**Attack scenario**: Attacker registers `metadata-proxy.attacker.example` and points it at a DNS server that returns `1.2.3.4` on the first query of each connection and `169.254.169.254` on the second. They submit a brand whose Serper results include `https://metadata-proxy.attacker.example/`. `isAllowedFetchUrl` resolves to `1.2.3.4`, passes. `fetch()` re-resolves to `169.254.169.254` (IMDS), connects, and the scraper stores the IMDS response. Practical only against deploys where IMDSv1 is enabled and the Node process has network access to 169.254.169.254.

**Recommendation**: After `dns.lookup`, build an `https.Agent` / `http.Agent` with `lookup` overridden to return the validated IP directly (or substitute the IP for the hostname in the URL and set `Host: <original-hostname>` manually). The `request-filtering-agent` and `ssrf-req-filter` packages do this. Alternatively, set the global DNS resolver cache to a short, sticky TTL and rely on Node's caching to pin within a request, but that is platform-dependent and not part of any stable API.

**Effort**: small
**Verification**: Stub a DNS resolver that returns different IPs on the validation lookup vs the fetch lookup; confirm the fetch never reaches the private address.

### [SEC4-003] CSP defined in two places with no shared source; drift between middleware and postbuild wrapper is easy

**Severity**: medium
**OWASP category**: A05:2021 Security Misconfiguration
**Files**: `src/middleware.ts:45-56`, `scripts/postbuild-security-headers.mjs:36`
**Observation**: The same `Content-Security-Policy` value lives as a hand-edited string in two places. The wrapper script monkey-patches `http.createServer` and pre-sets every response header via `res.setHeader` before Astro's handler runs. Middleware then calls `response.headers.set('Content-Security-Policy', ...)` on the SSR-side response, and the wrapper's `setHeader` value is the one that wins for non-SSR routes while middleware's `headers.set` wins for SSR routes. Both currently produce the same string, so behavior is consistent. The risk is purely operational: a future contributor who adjusts the CSP in middleware (the obvious place) without remembering to mirror it into the wrapper script will ship a divergent header on prerendered pages.

Same risk applies to `Strict-Transport-Security` (only the wrapper sets it; middleware never touches it). HSTS rides on the wrapper only, so any future middleware change that overrides response headers wholesale could silently strip HSTS from SSR responses.

The other headers (X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, COOP, CORP) are duplicated across both surfaces.

**Attack scenario**: No live exploit. The risk is that a CSP tightening (e.g. removing `'unsafe-inline'`) made in middleware would not propagate to static pages, leaving the homepage and blog with the looser CSP indefinitely. Or, more subtly, a CSP loosening would propagate to one but not the other and produce inconsistent behavior that is hard to test for.

**Recommendation**: Export the canonical header set as a single object from one source (e.g. `src/lib/security-headers.ts`), import it into both middleware and the postbuild script. The postbuild script already JSON-stringifies the header set into the wrapper at build time, so it can pull from the shared module via dynamic import. Alternatively, drop the wrapper entirely and apply all headers in middleware once Astro's standalone mode runs every response through middleware (Astro 6 does; the wrapper exists because it predates the all-routes-through-middleware guarantee).

**Effort**: medium
**Verification**: Diff the deployed responses for `/` (static) vs `/api/contact` (SSR). Confirm header sets are identical. Tighten one header in the shared module and confirm both surfaces pick it up.

### [SEC4-004] Logger uses a process-shared `_fallbackId` that cross-correlates concurrent requests

**Severity**: low
**OWASP category**: A09:2021 Security Logging and Monitoring Failures
**Files**: `src/lib/logger.ts:9-22`, `src/middleware.ts:17`
**Observation**: The module exports `runWithRequestId` (which would correctly enter an AsyncLocalStorage scope) but the only call site from `middleware.ts:17` is `setRequestId(requestId)`, which writes to the module-level `_fallbackId`. Subsequent `logger.info` / `logger.error` calls read `prefix()`, which prefers `als.getStore()` but falls back to `_fallbackId`. Because middleware never enters an ALS scope, every log call goes through the fallback. The fallback is a single shared module variable, so under any concurrency two interleaved requests will see each other's request IDs in log prefixes. The audit trail of "which request did this error happen on" becomes lossy.

The comment on line 11 names the legacy setter as backward-compat and points to `runWithRequestId` as the real correlation primitive, but nothing in the live code path uses `runWithRequestId`. The intent is correct; the implementation never finished the migration.

**Attack scenario**: Not directly exploitable. The downstream impact is forensic: a security incident requiring "trace request X through all log entries" cannot reliably reconstruct which log lines belong to which request when traffic is concurrent, which is most of the time. False-attribution risk on activity logs (which are stored in a separate table, not affected) is zero; this is purely about stdout/stderr correlation.

**Recommendation**: Replace the `setRequestId` body with a no-op (or remove it) and update middleware to wrap `next()` plus the post-response logic in `runWithRequestId(requestId, async () => ...)`. The AsyncLocalStorage scope already exists; middleware just needs to enter it. Mark `_fallbackId` deprecated and delete after one release.

**Effort**: small
**Verification**: Fire 50 concurrent requests, dump logs, confirm each request's logs share one ID and do not bleed into adjacent requests.

### [SEC4-005] `scripts/set-password.ts` stores a legacy SHA256 hash, putting users back on the deprecated verification path

**Severity**: low
**OWASP category**: A02:2021 Cryptographic Failures / A07:2021 Identification and Authentication Failures
**Files**: `scripts/set-password.ts:15-49`
**Observation**: This developer script computes `sha256(password)` and writes the hex digest directly to `users.password_hash`. The format (64-char hex, no `$` prefix) is exactly what `isLegacySha256(storedHash)` matches in `src/lib/auth.ts:48-51`. Anyone running the script puts the targeted user on the legacy verification path, which uses unsalted SHA-256 (vulnerable to offline brute force if the DB ever leaks) and exposes the user-bucket timing issue documented in SEC3-004. On the user's next login, `verifyPassword` silently rehashes them to bcrypt; until then, the legacy hash sits in the DB.

The script's first-line comment ("Run with: ... YourPassword") explicitly suggests using it to set passwords. The production codepath in `src/lib/auth.ts:setPassword` uses bcrypt cost 12. The two are inconsistent and the wrong one (the script) is the documented onboarding path.

**Attack scenario**: Cody sets a new admin's initial password via the script. Until that admin logs in once, their password is stored as raw SHA-256. A DB leak in that window exposes the credential to an offline rainbow-table attack. Practical risk is small because the admins who use the script are infrequent and the bcrypt upgrade fires on first login, but it is a foot-gun the codebase actively maintains.

**Recommendation**: Rewrite the script to import `setPassword` from `src/lib/auth.ts` (which uses bcrypt) and delegate to it. Two lines of change. Update the script's policy check to match (`PASSWORD_MIN_LENGTH = 12`). Alternatively delete the script entirely and document `tsx -e 'import("./src/lib/auth").then(m => m.setPassword(...))'` as the supported path.

**Effort**: trivial
**Verification**: Run the updated script, inspect `users.password_hash`; confirm bcrypt format (`$2b$12$...`).

### [SEC4-006] Funnel-email and quiz endpoints accept unbounded-length JSON bodies

**Severity**: low
**OWASP category**: A05:2021 Security Misconfiguration / DoS surface
**Files**: `src/pages/api/quiz.ts:18`, `src/pages/api/contact.ts:17`, `src/pages/api/unlock.ts:15`
**Observation**: The portal API routes have a 1MB body size cap enforced in middleware (`src/middleware.ts:108-116`), gated on `pathname.startsWith('/portal/api/')`. The public `/api/*` routes (quiz, contact, unlock, scan, naming/preview) have no equivalent cap; Astro's standalone adapter does not enforce one by default. A POST with a 100MB JSON body lands inside the route handler, gets parsed by `request.json()`, and consumes memory. Quiz and contact are rate-limited to 5/hour per IP, so the per-IP impact is small; unlock has no rate limit at all (relies only on `consent` and `scan_id` presence).

SEC3-006 already flagged the per-field length issue on quiz; this is the broader concern of total-body size.

**Attack scenario**: Attacker scripts a botnet of 10k IPs, each POSTing a 50MB JSON body to `/api/unlock`. `request.json()` parses each. Sustained traffic OOMs the Node process. Per-IP rate limits do not apply (no limit on unlock) and the body cap does not apply (not a portal route).

**Recommendation**: Add a public-routes body-size check to middleware that mirrors the portal one, scoped to `pathname.startsWith('/api/')` and capped at 100KB (these are JSON forms, never large payloads). Or implement per-route caps. The fix is one branch in the same middleware block.

**Effort**: trivial
**Verification**: POST a 10MB JSON body to `/api/unlock`; confirm 413 response before the handler runs.

### [SEC4-007] Notifications page interpolates `n.id` and `n.type` without escaping in attribute and content positions

**Severity**: info
**OWASP category**: A03:2021 Injection
**Files**: `src/pages/portal/admin/notifications.astro:73-85`, `src/pages/portal/notifications.astro:61-72`
**Observation**: The two notifications pages build `innerHTML` from server-returned notification objects. `${escapeHtml(n.title)}` and `${escapeHtml(n.body)}` are properly escaped. `${n.id}` and `${typeIcons[n.type] || typeIcons.general}` are not. `n.id` flows into `data-notif-id="${n.id}"` and `data-mark-read="${n.id}"`. `typeIcons[n.type]` is a lookup against a typed icon table (`'✓'`, `'⚠'`, etc.); if `n.type` does not match a known key, the JS evaluates to `typeIcons.general` and renders that. Today `n.id` is always a nanoid (URL-safe alphanumeric + `_-`), and `n.type` is always one of the `NotificationType` union values because the DB writes are server-side. Not currently exploitable.

The fragility: any future code path that lets a non-server-controlled value into either field would render attacker HTML in an attribute context (id) or text context (type icon).

**Recommendation**: Wrap both with `escapeHtml`. Two-character fix per occurrence. Same pattern as the existing escapes in the same files.

**Effort**: trivial
**Verification**: Inspect rendered HTML for a row whose stored `type` value contains `<` or whose `id` contains `"`; confirm escaped output.

### [SEC4-008] Activity log error path and CSV ingest store raw `err.message` in DB without sanitization

**Severity**: info
**OWASP category**: A03:2021 Injection / A09:2021 Security Logging Failures
**Files**: `src/lib/csv/index.ts:151-154`
**Observation**: When CSV parsing fails, `err.message` is stored in `csv_uploads.error` and returned to the client at `/portal/admin/csv.astro:153`, where it gets interpolated into `card.innerHTML` without escaping. Parser exceptions throw `Error` objects whose message is constructed from user input on at least some paths (e.g. `'Invalid header: ${header}'` patterns are common in CSV parsers). A crafted CSV could theoretically produce an error message containing HTML markup that then renders in the admin's browser. Because the admin is the same role that triggered the upload (no privilege boundary crossed) and the admin already has full portal access, the actual exposure is "self-XSS" where the admin attacks themselves by uploading their own crafted CSV. Not a real security boundary.

The DB-side concern is more about pollution: arbitrary attacker-controlled strings in a column that gets rendered raw is a code smell that breaks the more general "user content gets escaped" discipline. Round 2 SEC2-005 specifically cleaned up `err.message` exposure in API responses; this is the inverse direction (stored, not transmitted).

**Recommendation**: Cap error length to (say) 500 chars before storing. On the client, `card.textContent = data.error` rather than `card.innerHTML = ...${data.error}...`. The card UI currently uses a span around the error specifically; switching to textContent works without losing layout.

**Effort**: trivial
**Verification**: Upload a CSV that triggers a parser error whose message contains `<script>`; confirm the admin page renders the literal text rather than executing.

## Strengths

- Round 3 high (SSRF DNS resolution), medium (notifications limit, send-link rate limit policy and key), and low (legacy SHA256 constant-time, HMAC primitive) items were all addressed in commit `4b0f36a`. The SSRF DNS work is a real defense improvement; the residual gaps (SEC4-001, SEC4-002) are tractable and do not reset the round 3 progress.
- `node:crypto.createHmac` swap is a clean fix that uses the correct primitive without introducing dependencies. The constant-time hex compare downstream did not need to change.
- `verifyPassword` legacy branch now uses a byte-XOR accumulator that is genuinely constant time, with a length check that short-circuits without leaking timing because the input and stored hashes are always 64 hex chars on the legacy path.
- The unified `login:ip:${ip}` key plus `failClosed=true` on `send-link.ts` removes the round 3 fail-open hole and the bucket-split issue in one fix. The shared bucket means an attacker hitting both endpoints uses one 10-request window, not two.
- `npm audit --json` reports zero vulnerabilities across 671 dependencies (in-session verified May 13 2026).
- The DNS-resolving SSRF guard catches the most common attack (registering a public domain that A-records into a private range), which was the round 3 headline concern. The remaining gaps in IPv6 literal handling and DNS pinning are narrower attack surfaces.
- The migration runner, retention sweep, and rate-limiter cleanup are all idempotent and bounded; no growth-without-cap surfaces remain on the data side.
- Cheerio still strips script/style/nav/iframe/noscript/svg before extracting text, so an attacker who does get a private response through the SSRF guard cannot use it to inject script context into a downstream report email (text content only).
- The two PDF endpoints (admin and client invoices) both validate ownership (`invoice.client_id === locals.user.client_id`) and `client_visible` flags. No IDOR surface in the PDF download flow.
