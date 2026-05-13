# Security audit 2026-05-12, Round 6

Branch: seo-security-improvements
Scope: server-side code and client-side auth/input handling (same surfaces as rounds 1 through 5: middleware, src/lib/*, all API routes, all portal pages, postbuild script, security-headers.json, astro.config.mjs, package.json/package-lock.json, public-facing pages that post to forms, .env.example). Focused review on the round-5 fix set: SameSite=Lax on the verify cookie with 1-hour maxAge and the redirect to /portal/set-password, plus the in-flight SEC4-008 CSV admin innerHTML escape.
Auditor: Claude Code (Opus 4.7, 1M context) sub-agent
Prior rounds:
- docs/audits/security-audit-2026-05-12.md (28 findings)
- docs/audits/security-audit-2026-05-12-round2.md (13 findings)
- docs/audits/security-audit-2026-05-12-round3.md (11 findings)
- docs/audits/security-audit-2026-05-12-round4.md (8 findings)
- docs/audits/security-audit-2026-05-12-round5.md (5 findings)

## Summary

Total findings: 3 (critical: 0, high: 0, medium: 0, low: 1, info: 2)

Top themes:
- Round 5 brief items verified in code. `/portal/auth/verify.ts` sets the session cookie with `sameSite: 'lax'` and `maxAge: 60 * 60` (1 hour) and redirects the user to `/portal/set-password` rather than `/portal/dashboard`. The mid-round-5 SEC4-008 patch is also in place: `src/pages/portal/admin/csv.astro` defines a local `esc` helper and runs it over `file.name`, `data.error`, `data.format`, `data.row_count`, and the catch path's `err.message` before each `card.innerHTML` write. SEC4-007 (notification id and type icon escapes) and the `src/pages/portal/admin/notifications.astro` typeIcons lookup are still wrapped in `escapeHtml`.
- One new low: the cookie maxAge is 1 hour but `createSession(userId)` writes a 30-day `expires_at` to the `sessions` table regardless of the caller. The cookie token is the only client-side handle on the session row, so a deleted cookie effectively ends the session for the legitimate user, but the row persists in the DB and accepts the same token on re-presentation until `SESSION_DURATION_MS` elapses. Round 5 SEC5-002's stated intent was a "1-hour TTL" for pre-password sessions; the cookie meets that, but the DB row does not. Practical exploitability is low because retrieving the token requires either the cookie or DB access, but the asymmetry is worth documenting.
- One info: SEC5-005 (activity-log `page` query parameter unbounded upper limit) remains open. `src/pages/portal/admin/activity.astro:10` is unchanged from round 5. Admin-only route and admin-trusted, so re-flagging at info, not low.
- One info: SEC5-004 (pre-password user access to `/portal/api/notifications`) remains open. The middleware bypass list in `src/middleware.ts:148` still exempts the notifications routes from the password-set redirect. With the round-5 TTL drop to 1 hour, the window for the SEC5-002 attack scenario shrinks proportionally, so the practical risk is much smaller than at round 5.

## Round 5 fixes verified in code

- SEC5-001 resolved. `src/pages/portal/auth/verify.ts:44-50` sets the session cookie with `sameSite: 'lax'` and `maxAge: 60 * 60`, and line 52 redirects to `/portal/set-password` (not `/portal/dashboard`). The comment block at lines 31-43 documents both reasons: Safari refusal to set Strict cookies on cross-site initiated navigations, and the short TTL as a failsafe for abandoned set-password flows. `/portal/auth/login.ts:49-55` still uses `sameSite: 'strict'` with a 30-day maxAge, which is correct because login submits are same-site by the time they fire.
- SEC5-002 resolved at the cookie layer. The cookie maxAge dropped from 30 days to 1 hour for the verify path. The DB session row still gets `SESSION_DURATION_MS` (30 days) from `createSession`, see SEC6-001 below.
- SEC4-008 resolved. `src/pages/portal/admin/csv.astro:148-150` defines an inline `esc` helper that runs the standard five-character HTML escape over each interpolation in the success-card and error-card `innerHTML` writes. The error catch-path at line 168-171 uses a separate but identical `escErr` helper over `file.name` and `err.message`. No `innerHTML` write in this file leaves a user-controlled byte unescaped.

## Round 1-5 carryover items reaffirmed (not re-counted)

- SEC-012 / SEC2-012 / SEC3-011: CSP `'unsafe-inline'` for `script-src` and `style-src` still in `security-headers.json` (and propagated to both middleware and the postbuild wrapper). Marked deferred in the brief.
- SEC2-008: per-account login throttle still sliding-window only. Marked deferred in the brief.
- SEC2-013: Cross-Origin-Embedder-Policy intentionally omitted.
- SEC3-004 (deeper fix): legacy-vs-bcrypt timing bucket still distinguishable. The XOR constant-time compare closes the per-byte leak but not the bucket. Deferred.
- SEC4-002 (residual): DNS-pinning gap on the connect path. The fetch re-resolves the hostname; rebinding attacks still possible against a custom authoritative resolver. Deferred.
- SEC5-003: middleware re-queries `userHasPassword` on every authenticated portal request. Round 5 effort: small. Still open.
- SEC5-004: pre-password users still have full read/write access to `/portal/api/notifications`. Tightened by the 1-hour cookie TTL but the bypass remains. Re-flagged below as info.
- SEC5-005: activity-log `page` query parameter has no upper bound. Still open. Re-flagged below as info.

## Findings

### [SEC6-001] Pre-password session DB row still has 30-day expires_at; only the cookie maxAge is 1 hour

**Severity**: low
**OWASP category**: A07:2021 Identification and Authentication Failures
**Files**: `src/pages/portal/auth/verify.ts:21`, `src/lib/auth.ts:145-162`
**Observation**: The round 5 brief described SEC5-002's fix as "pre-password sessions are now 1-hour TTL." The implementation drops the cookie `maxAge` to 3600 seconds, but `createSession(userId)` at `src/lib/auth.ts:148` still computes `expiresAt = new Date(Date.now() + SESSION_DURATION_MS)` with `SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000` (30 days). The `sessions` row in Turso retains a 30-day `expires_at` regardless of whether the caller is `verify.ts` (pre-password) or `login.ts` (post-password).

The practical implication is narrow because the unhashed session token is only known to the user's cookie. When the browser drops the cookie at the 1-hour mark, the session row becomes inert from the user's perspective. But two side effects remain:

1. An attacker who manages to capture the session token within the 1-hour window (via the magic-link interception scenario in SEC5-002, browser exfiltration, etc.) holds a 30-day usable session against the same token hash, not a 1-hour one. The cookie maxAge governs the legitimate browser, not the attacker's curl.
2. The `validateSession` refresh window (`SESSION_REFRESH_MS = 15 days from expiry`) extends the row's `expires_at` on every successful validation. A pre-password session never reaches that refresh threshold under normal use, but a re-presented token (legitimate or otherwise) inside the 30-day window will be accepted and silently extended.

The cleanest fix is to thread an optional `durationMs` parameter through `createSession` and pass `60 * 60 * 1000` from `verify.ts` so the DB row and the cookie agree. This was the round 5 recommendation in SEC5-002 option 1; only half of it landed.

**Attack scenario**: Combined with magic-link interception. Attacker captures the cookie value (or steals it via local-machine compromise) within the 1-hour window. Cookie disappears from the user's browser at the 1-hour mark, but the attacker holds the raw token. They can re-present it indefinitely up to 30 days, and any successful presentation refreshes the DB row's expiry if they reach the refresh window. The legitimate user, seeing a "Token invalid or expired" on a return visit, has no signal that an attacker holds a parallel session.

The window for this is small (cookie capture within 1 hour after a magic-link click, before set-password completes) and the attack is exotic, so the severity is low.

**Recommendation**: Pass an optional duration to `createSession`. Two-call-site change:

```ts
// src/lib/auth.ts
export async function createSession(userId: string, durationMs: number = SESSION_DURATION_MS): Promise<string> {
  ...
  const expiresAt = new Date(Date.now() + durationMs).toISOString();
  ...
}

// src/pages/portal/auth/verify.ts
const sessionToken = await createSession(userId, 60 * 60 * 1000);
```

Document in code that pre-password sessions deliberately use a short DB TTL. Also worth confirming `setPassword` revokes the row on completion (it does, via `DELETE FROM sessions WHERE user_id = ?` at `src/lib/auth.ts:99`), so the row never persists past a successful set-password.

**Effort**: trivial
**Verification**: After a magic-link verify, inspect the corresponding `sessions.expires_at` value in Turso. Confirm it is approximately one hour from `created_at`.

### [SEC6-002] Activity-log `page` parameter remains unbounded on the upper end (carry-over from SEC5-005)

**Severity**: info
**OWASP category**: A05:2021 Security Misconfiguration / DoS surface
**Files**: `src/pages/portal/admin/activity.astro:10`
**Observation**: `const page = Math.max(1, parseInt(Astro.url.searchParams.get('page') || '1'));`. Unchanged since round 5. The route is admin-only via middleware, so the practical impact is bounded to the admin's own session and not externally exploitable.

The round 5 report flagged this and recommended a one-line clamp like `Math.min(parseInt(...) || 1, Math.ceil(total / limit))` or a coarse `Math.min(page, 10000)` cap. Neither has landed. Carried over as info; not double-counted with the round 5 headline number.

**Attack scenario**: Admin self-DoS only. Bookmarked or stale `?page=999999999` links cost the admin one full-table scan on `activity_log` with an `OFFSET 49999999950` SQLite operation that scans-and-discards.

**Recommendation**: Same as round 5. Either clamp `page` to `Math.ceil(total / limit)` (requires reordering the query so the count is available before the LIMIT/OFFSET fetch, easy to do), or a coarse `Math.min(page, 10000)` cap on the parsed value.

**Effort**: trivial
**Verification**: Request `/portal/admin/activity?page=99999999`. Confirm the page renders quickly and the displayed page number is clamped to the actual total.

### [SEC6-003] Pre-password users still have notifications API access (carry-over from SEC5-004)

**Severity**: info
**OWASP category**: A07:2021 Identification and Authentication Failures
**Files**: `src/middleware.ts:148`
**Observation**: The middleware bypass list in the password-set redirect still includes `/portal/api/notifications*`:

```ts
if (
  !isSetPasswordRoute &&
  !isSelfSetPasswordApi &&
  !context.url.pathname.startsWith('/portal/api/notifications') &&
  !await userHasPassword(result.user!.id)
) {
  return context.redirect('/portal/set-password');
}
```

The round 5 report recommended dropping the bypass because `/portal/set-password.astro` does not use the Portal layout and does not render the notification badge that would need the API. The bypass remains and pre-password users can still GET and POST notifications during the new 1-hour window.

The TTL drop in SEC5-002 reduced the window from 30 days to 1 hour, so the practical risk dropped by roughly two orders of magnitude. Re-flagged at info because the bypass is now mostly a layering nit rather than a meaningful attack surface, but the layering is still wrong.

**Attack scenario**: Same as SEC5-004 but with a 1-hour window. Attacker who clicks the magic link before the legitimate user can read and dismiss their notifications for up to one hour. Almost certainly empty at that point because the user has not done anything to generate notifications.

**Recommendation**: Drop the `/portal/api/notifications` bypass clause. Pre-password users in a notifications API call land on the 302 to `/portal/set-password`, which is the correct behavior. If the future set-password page ever shares the Portal layout (and thus the notification badge), revisit this then.

**Effort**: trivial
**Verification**: Set a test user's `password_hash` to NULL, magic-link in, GET `/portal/api/notifications/`. Expect 302 to `/portal/set-password`.

## Strengths

- Round 5 brief items land cleanly. `verify.ts` is now Lax + 1-hour + redirect to `/portal/set-password`. The comment block above the cookie set is detailed enough to survive future review (it names Safari behavior, the failsafe semantics, and the relevant audit IDs). `/portal/auth/login.ts` retains `sameSite: 'strict'` and 30-day maxAge because login is same-site initiated.
- The mid-round-5 SEC4-008 fix on `src/pages/portal/admin/csv.astro` is thorough. Both `innerHTML` paths (success card and error catch) get their own escape helper. `file.name`, `data.error`, `data.format`, `data.row_count`, and `err.message` all flow through it. The escape helper is correctly defined inline per-handler so a future refactor cannot accidentally drop it.
- `npm audit --json` reports zero vulnerabilities across 671 dependencies (verified in-session 2026-05-13).
- The new prerendered OG endpoints added in commit `1281cde` (`src/pages/og/404.png.ts`, `src/pages/og/blog/tag.png.ts`) take no user input. The `renderOg` call uses hardcoded strings only. No new attack surface.
- The CSRF middleware gate on every mutating `/portal/api/*` request, the per-IP plus per-email login throttle with shared `login:ip:` bucket between password and magic-link paths, the absolute session lifetime cap, the file-upload magic-byte verification, the SSRF DNS lookup with bracket normalization for IPv6 literals, and the HMAC-SHA256 CSRF and report tokens together cover the standard auth, injection, and SSRF threat model.
- The `/portal/api/files/download` endpoint continues to return 302 with `Referrer-Policy: no-referrer` and `Cache-Control: private, no-store`. Signed-URL leakage via Referer remains blocked.
- The session row revoke on `setPassword` (`DELETE FROM sessions WHERE user_id = ?` at `src/lib/auth.ts:98-101`) means SEC6-001's DB-vs-cookie TTL gap closes the moment a user completes the set-password flow. The gap only matters for abandoned sessions, which the cookie TTL handles for the legitimate user.
- AsyncLocalStorage wrap of the request handler at `src/middleware.ts:21` still scopes the request ID correctly. No regression.
- The shared `security-headers.json` source-of-truth pattern continues to drive both middleware and the postbuild wrapper from one file. The `_comment` strip on import means iteration over headers does not pick up the documentation key.
- Trajectory from round 1 to round 6: 28, 13, 11, 8, 5, 3. The remaining items are increasingly narrow and increasingly low-severity. No critical or high-severity findings have re-emerged. The CSP nonce migration and the optional account-lockout layer remain the two largest deferred items, both explicitly out of scope per the brief.
