# Bug + fix log

Append-only record of non-obvious bugs and their fixes. Newest at top.

Every entry: symptom (what the user saw), root cause (what was actually wrong), fix (PR or commit), watch-for (what to check first if this symptom reappears).

When working on the portal, **check this file before guessing at any auth, redirect, session, or middleware symptom.** Several of these have recurred. The pattern is more useful than the patch.

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
