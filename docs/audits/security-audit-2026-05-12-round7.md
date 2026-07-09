# Security audit 2026-05-12, Round 7

Branch: seo-security-improvements
Scope: server-side code and client-side auth/input handling (same surfaces as rounds 1 through 6: middleware, src/lib/*, all API routes, all portal pages, postbuild script, security-headers.json, astro.config.mjs, package.json/package-lock.json, public-facing pages that post to forms, .env.example). Focused review on the round-6 fix set: `createSession(userId, durationMs)` plus the `verify.ts` 1-hour magic-link DB row, and the `activity.astro` page-param `[1, 10000]` clamp.
Auditor: Claude Code (Opus 4.7, 1M context) sub-agent
Prior rounds:
- docs/audits/security-audit-2026-05-12.md (28 findings)
- docs/audits/security-audit-2026-05-12-round2.md (13 findings)
- docs/audits/security-audit-2026-05-12-round3.md (11 findings)
- docs/audits/security-audit-2026-05-12-round4.md (8 findings)
- docs/audits/security-audit-2026-05-12-round5.md (5 findings)
- docs/audits/security-audit-2026-05-12-round6.md (3 findings)

## Summary

Total findings: 1 (critical: 0, high: 0, medium: 0, low: 1, info: 0)

Trajectory: 28, 13, 11, 8, 5, 3, 1.

Bottom line: round 6 work confirmed in source. One new low-severity finding caught: the 1-hour DB TTL added in SEC6-001 is immediately re-extended to 30 days by `validateSession`'s refresh-window logic on the very first authenticated portal request after magic-link verify. SEC6-001's stated intent ("DB row matches 1-hour cookie") does not hold in practice. All other open items are explicit large-effort deferrals (CSP nonce migration, Google Fonts self-hosting) or info-level carryovers already documented in prior rounds.

If the SEC7-001 refresh-window interaction is itself deferred or accepted, the round 8 audit can be skipped: the remaining surface is exclusively the two explicit deferrals plus the long-tail info-level carryovers.

## Round 6 fixes verified in code

- SEC6-001 (partial). `src/lib/auth.ts:145` now reads `createSession(userId: string, durationMs: number = SESSION_DURATION_MS)` with the comment block at lines 146-148 naming the round 6 audit ID. The `expiresAt` computation at line 151 uses the parameter, not the constant. `src/pages/portal/auth/verify.ts:25-26` defines `ONE_HOUR_MS = 60 * 60 * 1000` and calls `createSession(userId, ONE_HOUR_MS)`. The DB row is initially written with a 1-hour expiry. **However**, see SEC7-001 below: the refresh-window logic in `validateSession` overrides this on the first portal request after magic-link verify, so the DB row only carries a 1-hour TTL for the very brief gap between `verify.ts` running and the redirect's downstream request landing in middleware. By the time the user sees /portal/set-password, the row's `expires_at` is already 30 days. The fix is materially defeated by an interaction the round 6 brief did not flag.
- SEC6-002 resolved. `src/pages/portal/admin/activity.astro:13-14` parses the page param with `parseInt(..., 10)` and the explicit base, runs `Number.isFinite` to reject NaN, and applies `Math.min(Math.max(rawPage, 1), 10000)`. The comment block at lines 10-12 names round 5 SEC5-005 and round 6 SEC6-002 for forward traceability. A hostile `?page=999999999` URL now caps at page 10000, and a non-numeric `?page=abc` falls back to 1.

## Round 1-6 carryover items reaffirmed (not re-counted)

- SEC-012 / SEC2-012 / SEC3-011: CSP `'unsafe-inline'` for `script-src` and `style-src` still in `security-headers.json:5`. Deferred (CSP nonce migration is large effort per brief).
- Google Fonts CSS/font dependency at `fonts.googleapis.com` and `fonts.gstatic.com` referenced from `security-headers.json:5` (CSP allowlist) and from portal-login, portal-set-password, and Base layouts. Deferred (self-hosting fonts is the large-effort sister to the CSP migration per brief).
- SEC2-008: per-account login throttle still sliding-window only. Deferred.
- SEC2-013: Cross-Origin-Embedder-Policy intentionally omitted.
- SEC3-004: legacy-vs-bcrypt timing bucket still distinguishable at `src/lib/auth.ts:114`. Deferred.
- SEC4-002: DNS-pinning gap on the scraper's connect path. The fetch() at `src/lib/scraper.ts:180` re-resolves the hostname independently of the validation lookup. Deferred (per inline comment at lines 166-172).
- SEC5-003: middleware re-queries `userHasPassword` on every authenticated portal request at `src/middleware.ts:149`. Still open.
- SEC5-004 / SEC6-003: pre-password users still have notifications API access via the bypass at `src/middleware.ts:148`. Round 6 reaffirmed at info; with the round 6 ttl drop the exposure window is 1 hour rather than 30 days, but the bypass itself remains. Still open at info-level.

## Findings

### [SEC7-001] validateSession refresh window immediately re-extends 1-hour magic-link sessions to 30 days

**Severity**: low
**OWASP category**: A07:2021 Identification and Authentication Failures
**Files**: `src/lib/auth.ts:202-209`, `src/pages/portal/auth/verify.ts:25-26`, `src/middleware.ts:92`
**Observation**: Round 6 added a `durationMs` parameter to `createSession` so the magic-link verify path can write a 1-hour DB row. The intent, per SEC6-001's recommendation and the inline comment at `verify.ts:22-23`, was "the short DB-side TTL is the failsafe when the user abandons before setting a password." In practice, this short TTL survives for milliseconds.

The flow:

1. `verify.ts` calls `createSession(userId, 60 * 60 * 1000)`. The `sessions` row's `expires_at` is `now + 1h`.
2. `verify.ts` returns a 302 to `/portal/set-password`.
3. The browser follows the redirect. Astro middleware fires on the new request.
4. Middleware calls `validateSession(token)` at `src/middleware.ts:92`.
5. `validateSession` at `src/lib/auth.ts:202-209` runs:

```ts
// Extend session if within refresh window
if (expiresAt.getTime() - Date.now() < SESSION_REFRESH_MS) {
  const newExpiry = new Date(Date.now() + SESSION_DURATION_MS).toISOString();
  await turso.execute({
    sql: 'UPDATE sessions SET expires_at = ? WHERE id = ?',
    args: [newExpiry, sessionId],
  });
}
```

`SESSION_REFRESH_MS` is `15 * 24 * 60 * 60 * 1000` (15 days). The check is "if the session has less than 15 days left, refresh it to the full 30 days." A freshly-issued 1-hour session has 1 hour left, which is unconditionally less than 15 days, so the refresh fires on the very first request. `SESSION_DURATION_MS` (30 days, the constant, not the caller's `durationMs`) is what the refresh writes, so the row jumps from `now + 1h` to `now + 30d`.

By the time the user lands on /portal/set-password and reads "Set a password" on screen, the DB row is already 30 days. The cookie maxAge is still 1 hour, so the legitimate user's browser stops sending the cookie after one hour. But an attacker who captured the cookie value within the 1-hour window holds a 30-day usable session against that token hash, exactly the scenario SEC6-001 was trying to close.

The fix is in two parts:

1. `createSession` should record the caller's intended duration on the row (e.g., a `max_duration_ms` column, or compute it from `expires_at - created_at` at insert time).
2. `validateSession`'s refresh logic should clamp the new expiry to the original duration. The cleanest form is to compute `Math.min(Date.now() + SESSION_DURATION_MS, created_at + max_duration_ms)` so a short-TTL session never extends past its caller-declared ceiling.

Alternative simpler fix: skip the refresh entirely for any session whose `expires_at - created_at` is less than `SESSION_DURATION_MS`. This treats short sessions as "explicitly bounded" and never refreshes them. The setPassword path at `src/lib/auth.ts:99` already revokes all of a user's sessions on completion, so a successful password-set still cleanly transitions the user to a normal 30-day session via the next login. The 1-hour ceiling is only meant to handle abandoned set-password flows, and the simpler fix preserves that ceiling correctly.

**Attack scenario**: Identical to SEC6-001. Attacker captures the raw cookie value within the 1-hour window after a magic-link click but before the user completes set-password (browser extension, malicious local app, shared-machine ungated-browser scenario). The cookie's maxAge is 1 hour so the legitimate user's browser stops presenting it, and a return visit shows "Token invalid or expired" with no surface signal. Meanwhile the attacker's curl can re-present the captured token for 30 days, and each successful presentation extends the row's `expires_at`. The `SESSION_ABSOLUTE_MAX_MS` cap at `src/lib/auth.ts:197` still bounds the maximum at 90 days from `created_at`, but the round 6 fix's stated intent (one-hour bound) is fully defeated until that absolute cap kicks in.

The realistic exploit window is narrow because magic-link cookie capture is exotic, but the round 6 brief described this exact case as the rationale for the fix.

**Recommendation**: Skip the refresh for sessions whose original duration was shorter than `SESSION_DURATION_MS`. Two-call-site change:

```ts
// src/lib/auth.ts
// Inside validateSession, replace the current refresh block:
const originalDurationMs = expiresAt.getTime() - createdAt.getTime();
if (
  originalDurationMs >= SESSION_DURATION_MS &&
  expiresAt.getTime() - Date.now() < SESSION_REFRESH_MS
) {
  const newExpiry = new Date(Date.now() + SESSION_DURATION_MS).toISOString();
  await turso.execute({
    sql: 'UPDATE sessions SET expires_at = ? WHERE id = ?',
    args: [newExpiry, sessionId],
  });
}
```

A slightly cleaner alternative is to thread the original duration onto the row (e.g., a `max_duration_ms` integer column populated at insert) and clamp the refresh to that ceiling, but the originalDuration-vs-constant comparison is sufficient because the pre-password caller is the only call site that passes a non-default `durationMs`.

Document the invariant in a comment block near the refresh logic so a future caller adding another short-TTL session type does not silently re-introduce this gap.

**Effort**: trivial (single-block edit in `validateSession`).
**Verification**: After a magic-link verify, inspect the corresponding `sessions.expires_at` value in Turso immediately, then again after the middleware-driven redirect lands. Confirm the row stays at approximately one hour from `created_at`. Run the same probe for a password-flow login and confirm the row's expiry refreshes to ~30 days as before (regression check on the normal path).

## Strengths

- Round 6 work is otherwise clean. `createSession`'s new signature is backward-compatible (default arg preserves SESSION_DURATION_MS for every other call site), the verify.ts comment block explicitly names round 6 SEC6-001 so future readers see why the parameter exists, and `activity.astro` documents both the round 5 and round 6 audit IDs in the clamp comment.
- The activity-log clamp at `src/pages/portal/admin/activity.astro:13-14` uses `Number.isFinite(rawPage)` to handle the NaN-from-parseInt case explicitly, which is a strict improvement over the round 5 form (`Math.max(1, parseInt(...))` would silently coerce NaN to 1 via Math.max comparing NaN, but the explicit isFinite check makes the intent legible).
- `npm audit --json` reports zero vulnerabilities across 671 dependencies (verified in-session 2026-05-13).
- The `setPassword` flow at `src/lib/auth.ts:98-101` still revokes all of a user's sessions on completion, so SEC7-001's gap closes the moment the user finishes set-password. The window only matters for abandoned flows, and only against an attacker who already captured the cookie. The `SESSION_ABSOLUTE_MAX_MS` at line 197 still caps the row at 90 days from creation.
- The shared `security-headers.json` source-of-truth pattern remains correct. The `_comment` strip on import in `src/lib/security-headers.ts:14` still works, the headers list still iterates cleanly in both middleware and the postbuild wrapper.
- AsyncLocalStorage wrap of the request handler at `src/middleware.ts:21` still scopes the request ID correctly. The legacy `setRequestId` is preserved as a no-op shim at `src/lib/logger.ts:13-15` so any future call cannot accidentally re-introduce the fallback-id cross-correlation bug.
- All client-rendered innerHTML write sites in the portal (`src/pages/portal/admin/csv.astro`, `src/pages/portal/admin/notifications.astro`, `src/pages/portal/notifications.astro`, `src/pages/portal/dashboard.astro`, `src/pages/portal/keywords.astro`, `src/pages/portal/health.astro`) consistently escape user-controlled bytes through an inline `escapeHtml`/`esc`/`escErr` helper. The dashboard and health pages interpolate only internally-derived labels and numeric counters, not free-form user input.
- The naming-preview page at `src/pages/naming-preview.astro:177-185` writes `n.name` and `n.rationale` to innerHTML without escapeHtml. Both fields come from Gemini's response, which a hostile user can prompt-inject via the seed field. The page is `noIndex={true}` and the seed is never read from URL params (only from a form-typed input), so this is purely self-XSS: the only person who can land an `<script>` is the person who typed the seed. Not exploitable as a stored or reflected XSS, so not raised as a finding, but worth a comment in the renderResults function if the run-id is ever exposed as a shareable URL in a future iteration. Document, do not fix.
- Trajectory from round 1 to round 7: 28, 13, 11, 8, 5, 3, 1. The single finding is narrow and tightly coupled to a specific round 6 fix. After SEC7-001 is closed (or formally accepted), the remaining surface is exclusively the two large-effort deferrals named in the brief plus the long-tail info-level carryovers from prior rounds. Round 8 is not needed unless new code lands.
