# Proposal + contract UI/UX audit — 2026-05-25

Companion to `docs/audits/proposal-chain-audit-2026-05-24.md`. That audit traced the data chain from AI discovery to executed contract, found 7 mapping breaks, all closed in PRs #99-138 by 2026-05-25 morning. This audit covers UI/UX gaps the structural audit did not catch — voice, copy, state coverage, consistency, friction, accessibility — across 11 surfaces.

## Methodology

Parallel code review across the proposal/contract UI surfaces. Each surface read end-to-end by a dedicated reviewer, findings consolidated and deduplicated below. Finding count by reviewer: wizard 16, prospect-facing 12, agreements admin 14, lists + notifications + preview + snippets 17. After deduplication: 51 unique findings. Severity assigned per impact on prospect, signer, or admin flow.

Surfaces audited:

| Surface | File | Audience | Lines |
|---|---|---|---|
| Wizard | `src/pages/portal/admin/proposals/new.astro` | Admin | 2,363 |
| Published proposal | `src/pages/portal/proposals/[slug].astro` | Prospect | 1,690 |
| Signer view | `src/pages/portal/contracts/[slug].astro` | Signer | 616 |
| Print view | `src/pages/portal/contracts/[slug]/print.astro` | Signer/Practice | — |
| Agreement create | `src/pages/portal/admin/agreements/new.astro` | Admin | 229 |
| Agreement detail | `src/pages/portal/admin/agreements/[id].astro` | Admin | 265 |
| Proposals list | `src/pages/portal/admin/proposals.astro` | Admin | — |
| Agreements list | `src/pages/portal/admin/agreements.astro` | Admin | — |
| Contracts list | `src/pages/portal/admin/contracts.astro` | Admin | — |
| Contract detail | `src/pages/portal/admin/contracts/[id].astro` | Admin | — |
| Snippet editor | `src/pages/portal/admin/proposals/snippets.astro` | Admin | 317 |
| Preview | `src/pages/portal/contracts/preview/[proposalSlug].astro` | Admin | — |
| Notifications (client) | `src/pages/portal/notifications.astro` | Client | — |
| Notifications (admin) | `src/pages/portal/admin/notifications.astro` | Admin | — |

---

## Cross-cutting themes (most impactful)

### A. Listing UI inconsistency (HIGH)

The three admin list pages (proposals, agreements, contracts) drift in structure, status pill styling, signer progress display, and column layout. Proposals show per-signer checkmarks inline; agreements show summary pills on the header row; contracts omit signers entirely. Status pill placement and color tokens differ. Admin moving between the three has no learnable pattern.

Recommended: extract a shared `<ListRow>` component with a fixed column order (Name | Client | Status | Signers | Actions), a single `statusBadge` helper that maps every state in the system, and a single signer-progress widget. Land before any new list view ships.

### B. No autosave + state persistence in the wizard (HIGH)

The wizard at `/portal/admin/proposals/new` keeps all state in JS memory (line 352-369). A browser refresh, accidental tab close, or session timeout loses everything. "Save as draft" persists to the database but only on explicit click. Admin composing a long proposal has no safety net.

Recommended: debounce a `sessionStorage` write on every state mutation. On page load, prompt "Restore draft from <time>?" when storage has content. Optional v2: server-side autosave to `proposals.config` with a `draft_state` column.

### C. Admin text leaks into prospect-facing UI (HIGH)

The published proposal at `src/pages/portal/proposals/[slug].astro` lines 1395, 1433-1434 renders "(Admin preview)" and "Admin preview — submit disabled" labels in the accept form when admin is previewing. If anything in the auth path mis-evaluates, a real prospect could see these. The signing disclosure at lines 415, 430 mentions IP address, browser fingerprint, and network address in two places with slightly different wording.

Recommended: conditionally render admin-preview blocks via a single `isAdminPreview` flag, with a separate JSX subtree that's never shipped to non-admin. Consolidate the UETA disclosure into one block with consistent wording.

### D. Voice-lint not enforced on admin-authored copy (MED)

`lintSnippet` exists in `src/lib/proposal-ai/voice-lint.ts` and is called on Slice 4 snippet saves and Gemini outputs. It is NOT called on:
- The wizard's `overrides.title` and `overrides.prepared_for` fields (admin can type anything)
- The agreement `new.astro` "Master Services Agreement — Client name" title (line 79 has a literal em dash)
- The `intake` form inputs (signer-facing)

Recommended: run `lintSnippet` on every admin-typed string before persist. Surface violations inline; admin must fix or explicitly override.

### E. Modal accessibility (Esc + click-outside + keyboard focus) (MED)

The snippet editor modal handles click-outside but not Esc. The contracts list "new contract" form has neither. Tier picker cards in the published proposal lack `tabindex` + `aria-pressed` + Enter/Space handlers. None of the modals trap focus.

Recommended: a shared `useModal()` hook (or vanilla helper) wires Esc, click-outside, and focus trap once. Tier picker cards become `<button role="button" tabindex="0">`.

### F. Per-signer granularity missing in agreements admin (MED)

Agreement detail at `[id].astro` shows per-signer signed/awaiting status (lines 103-119) but no per-signer "Resend invite" action. Admin must resend to all signers when only one needs a nudge. The `issue.ts` endpoint already returns `send_results` per signer (line 37) but the UI ignores it — a failed signer email is silently swallowed.

Recommended: add per-row Resend button. Surface `send_results` after `Issue` and `Resend` calls with per-signer success/failure pills.

### G. No edit flow for proposals after publish (MED)

`src/pages/portal/api/admin/proposals/[slug].ts` is DELETE-only. The proposals list links to `/portal/admin/proposals/<slug>` (line 236) with a "Manage" label, but that route doesn't exist as a page. Admin who realizes a typo after publish has no recourse short of delete + re-create.

Recommended: build the proposal edit page (status guard: only editable when status is `draft` or `published_not_accepted`). Or remove the "Manage" link until the edit flow ships and document the delete-and-recreate workaround.

---

## Per-surface findings

### Wizard — `/portal/admin/proposals/new`

| # | Severity | Finding | Fix |
|---|---|---|---|
| W1 | HIGH | No back/cancel affordance (lines 111-346) — admin can only escape via browser back | Add breadcrumb "Admin / Proposals" at top, optional Cancel button next to submit |
| W2 | HIGH | No state persistence on refresh (state object lines 348-369) | sessionStorage autosave on state change; restore prompt on load |
| W3 | HIGH | No loading affordance on 5-15s Research call (lines 1598-1641) | Add spinner + skeleton card in research-results slot |
| W4 | MED | Inconsistent button styles across sections (multiple lines) | Standardize to 3 tiers: primary (solid amber), secondary (border), tertiary (text) |
| W5 | MED | Validation errors only surface on submit (lines 1286-1294) | Inline validation on blur for signer email, required fields |
| W6 | MED | Per-site editor missing context callout (lines 1016-1109) | Add subtitle "Primary at full base; additional at 80% of own ecosystem" |
| W7 | MED | No success toast on save/publish (lines 1357-1359) | Use `window.__toast` already wired |
| W8 | MED | Multi-product variables section has no scope summary (lines 239-245) | Add "Variables for N products in scope: X, Y" header |
| W9 | LOW | Tier-override picker label "Marked recommended:" ambiguous (line 2163) | Change to "Set recommended tier:" |
| W10 | LOW | Build options "no picker" warning confusing (lines 837-841) | Simplify to "Single option = standard build" |
| W11 | LOW | Research apply/unapply has no visual confirmation flash (lines 1943-1949) | Add 300ms `bg-emerald-400/10` flash on re-render |
| W12 | LOW | Domain picker chip "x" button too small (lines 1440-1494) | Enlarge x; highlight primary with badge |
| W13 | LOW | Add-site input has no loading state on Enter (lines 1504-1517) | Disable input + "Adding..." until response |
| W14 | LOW | Overrides details collapsed by default; admin may ship without seeing it (lines 300-330) | Expand by default or show "4 auto-filled" badge |
| W15 | LOW | Inconsistent text-color hierarchy (text-neutral-400 vs 500 for labels) | Reserve 400 for labels, 500 for help text, 600 for hints |

### Published proposal — `/portal/proposals/[slug]`

| # | Severity | Finding | Fix |
|---|---|---|---|
| P1 | HIGH | Admin-preview text potentially visible to prospect (lines 1395, 1433-1434) | Conditional render with isAdminPreview flag; separate JSX subtree |
| P2 | MED | UETA disclosure inconsistent wording across two places (lines 415, 430) | Consolidate to one block, wording aligned |
| P3 | MED | Recommended tier badge low contrast on cream theme (lines 224-227) | Bump pill to white-on-sepia or bold text |
| P4 | MED | Tier picker cards not keyboard-accessible (lines 856-871) | Add tabindex=0, role=button, aria-pressed, Enter/Space handler |
| P5 | MED | Signature preview lacks validation feedback (lines 426-427) | Add explicit "Preview: " label + bold confirmation that typed name = signature |
| P6 | LOW | Unicode ellipsis "Saving…" (line 487) | Replace with ASCII `...` for universal rendering |
| P7 | LOW | Empty state silent when meSigner is null (lines 374-434) | Banner: "You are not listed as a signer. Contact <practice email>." |
| P8 | LOW | Tier card touch feedback missing on mobile (lines 217-220) | Add `:active`/`:focus` states; `user-select: none` |
| P9 | LOW | "Print friendly view" link text generic (line 362) | Change to "Print or download contract" + icon |
| P10 | LOW | Pending co-signer cards lack visual hierarchy (lines 436-453) | Light background + icon (⏳) on pending |
| P11 | LOW | Intake "Saved" indicator lacks check icon (line 231) | Add ✓ icon or use toast |

### Signer view — `/portal/contracts/[slug]`

Findings folded into P1-P11 above; the signer view shares `[slug].astro` patterns. Specific to the signer surface:

| # | Severity | Finding | Fix |
|---|---|---|---|
| S1 | LOW | Print view shows "Status: <status>" in header — exposes internal state | Omit status from print header, or show only terminal states |

### Agreement create — `/portal/admin/agreements/new`

| # | Severity | Finding | Fix |
|---|---|---|---|
| A1 | HIGH | Literal em dash in title template "Master Services Agreement — Client name" (line 79) | Replace with plain hyphen or rephrase to "Master Services Agreement for <Client>" |
| A2 | LOW | Duplicate signer emails not deduped client-side (lines 90-92) | Warn if email already in list; validate at submit |

### Agreement detail — `/portal/admin/agreements/[id]`

| # | Severity | Finding | Fix |
|---|---|---|---|
| A3 | HIGH | Raw Schedule A JSON editor with no schema hint or preview (line 87) | Add inline schema reference + live preview toggle |
| A4 | MED | Resend invite ambiguous: resends to all signers, not just unsigned (lines 75-80) | Tooltip + per-signer Resend button (see cross-cutting F) |
| A5 | MED | Cancel agreement reason capture is optional; null reason ambiguous (lines 206-211) | Make reason mandatory or fill "No reason provided" sentinel |
| A6 | MED | issue.ts send_results ignored by UI (line 37 endpoint; line 191 UI) | Surface per-signer email status from send_results |
| A7 | LOW | Audit trail truncated silently at 200 events (line 118) | "Load more" or pagination indicator at cap |
| A8 | LOW | Hash verification report has no export option (line 259) | "Export hash report" alongside CSV export |
| A9 | LOW | Breadcrumb only goes to agreements list (line 59) | Add "Client > Proposal > Agreement" chain when proposal_id set |

### Agreements list — `/portal/admin/agreements`

| # | Severity | Finding | Fix |
|---|---|---|---|
| AL1 | MED | "Quick action" disappears when no finalized proposals; no explanation (lines 102-117) | Show empty state "No proposals ready for agreement" instead of hiding |
| AL2 | LOW | Per-signer status in list shows only name+status, no signed-at timestamp (lines 143-153) | Add signed-at inline (e.g., "Signed May 24") |
| AL3 | LOW | No bulk operations (filter, bulk-cancel, bulk-resend) | Add checkbox selection + bulk action menu |

### Proposals list — `/portal/admin/proposals`

| # | Severity | Finding | Fix |
|---|---|---|---|
| PL1 | MED | "Manage" link points to non-existent edit page (line 236) | See cross-cutting G — build edit flow or remove link |
| PL2 | LOW | Missing breadcrumb back to admin home | Add "Admin > Proposals" pattern from detail pages |

### Contracts list — `/portal/admin/contracts`

| # | Severity | Finding | Fix |
|---|---|---|---|
| CL1 | MED | New contract form lacks Esc + click-outside close (lines 94-166) | See cross-cutting E — shared modal helper |
| CL2 | MED | Toast call signature inconsistent on same page (lines 276-277) | Standardize to string format `__toast('text', 'success')` used elsewhere |

### Contract detail — `/portal/admin/contracts/[id]`

| # | Severity | Finding | Fix |
|---|---|---|---|
| CD1 | MED | Delete confirmation overclaims scope: says "projects, milestones, tasks" but only deletes contract + invoices + approvals + change-orders (line 282 vs 287-289) | Update message to match actual cascade |
| CD2 | LOW | Client name in breadcrumb has no fallback (line 47) | Add "(client deleted)" sentinel |

### Snippet editor — `/portal/admin/proposals/snippets` (PR #139)

| # | Severity | Finding | Fix |
|---|---|---|---|
| SN1 | MED | Modal close button works but Esc key not wired (lines 65-66) | Add `keydown` Esc handler |
| SN2 | MED | New-snippet key format validated only on save endpoint, not client-side (lines 291-313) | Add client-side regex check matching KEY_RE before opening editor |
| SN3 | LOW | "File baseline" badge ambiguous (line 178) | Change to "File only (no DB override)" or add tooltip |
| SN4 | LOW | Save re-fetches list during 700ms modal-close delay (line 251) | Defer load() until after modal closes |

### Notification surfaces

| # | Severity | Finding | Fix |
|---|---|---|---|
| N1 | MED | Admin notifications have type icons (emoji), client notifications omit them | Pick one — add to client or remove from admin |
| N2 | MED | Admin and client both POST to `/portal/api/notifications/` with `{ id }` or `{ all: true }`; no separation by audience | Document parameter shape in endpoint or split into admin + client endpoints |
| N3 | LOW | Notification titles have no truncation; long titles wrap unpredictably on narrow viewports (line 65 of notifications.astro) | Add `line-clamp-2` |

### Preview surface — `/portal/contracts/preview/[proposalSlug]`

| # | Severity | Finding | Fix |
|---|---|---|---|
| PR1 | MED | Admin-only blocks (`<!-- internal -->`) stripping is implicit; comment claims it but no inline confirmation in renderTemplate(…, 'preview') call (lines 117-119) | Add inline comment confirming 'preview' status strips internal scope; ideally add a test asserting the internal-block strip happens for 'preview' just like 'client' |
| PR2 | LOW | Breadcrumb arrow uses HTML entity `&larr;` not the text/icon used in other admin breadcrumbs (line 179) | Match the convention used elsewhere |

---

## Recommendations ranked (impact x effort)

| Priority | Item | Cross-cutting? | Effort |
|---|---|---|---|
| 1 | **Wizard autosave + restore prompt** | No, scoped to one file | Small (~1 hour) |
| 2 | **Strip admin-preview text from prospect view conditionally** | No | Small (~30 min) |
| 3 | **Shared ListRow + statusBadge for the 3 admin lists** | Yes (cross-cutting A) | Medium (~3 hours) |
| 4 | **Shared modal helper with Esc + click-outside + focus trap** | Yes (cross-cutting E) | Medium (~2 hours) |
| 5 | **Per-signer Resend + surface send_results** | No, agreement detail | Medium (~2 hours) |
| 6 | **Voice-lint on admin-typed overrides (title, prepared_for, agreement title)** | Yes (cross-cutting D) | Small (~1 hour) |
| 7 | **Tier picker keyboard accessibility (tabindex + Enter/Space)** | No | Small (~30 min) |
| 8 | **Wizard back/cancel affordance + breadcrumbs** | No | Small (~30 min) |
| 9 | **Recommended tier badge contrast** | No | Small (~15 min) |
| 10 | **Replace literal em dash in agreement title template** | No | Trivial (one line) |
| 11 | **Decide on proposal edit flow vs remove "Manage" link** | No | Small if remove; Large if build |
| 12 | **Fix contract delete confirmation overclaim** | No | Trivial |
| 13 | **Snippet editor: Esc handler + client-side key validation** | No | Small (~30 min) |

The first 10 items together are roughly one focused day of work and would close every HIGH severity finding plus most cross-cutting concerns.

---

## Closure status (added 2026-05-25)

All findings tracked here have shipped fixes in PRs #137-148. The exceptions are explicitly deferred with reasons:

- **W4** (button style consistency): deferred. Mechanical refactor across 2,400 lines of wizard JS. Risks regression if a button is mis-classified. Warrants its own focused PR with a manual visual diff pass.
- **W5** (inline validation on blur): deferred. Needs a validation-library or pattern decision (per-field error rendering convention). Voice-lint catches the AI-style violations at submit; the gap is field-shape errors (missing required, invalid email) which currently surface as modal-blocking on submit.
- **W11** (research apply/unapply visual flash): deferred. Requires careful CSS animation work + identifying the row that changed across re-renders.
- **W12** (domain chip x button): not reproducible. The audit pointed at a "small x" but the current code renders an `+ add site` input inline, not an x-button on each chip. Possibly a stale finding from an earlier wizard version.
- **W15** (text-color hierarchy): deferred. Too subjective without a token system to standardize against. The Cody persona quiz palette (sun + mountain + spring + clouds) is the design vocabulary; standardizing requires extracting tokens first.
- **AL3** (bulk operations on lists): deferred. Feature work, not polish. Worth scoping separately when the user volume justifies it.
- **N2** (notification endpoint param shape): deferred. The current shared endpoint works for both audiences with the same param shape; the audit's recommendation to split into admin + client endpoints is a refactor without immediate user benefit.
- **Cross-cutting B** (wizard auto-restore on reload): CLOSED in PR #150. Restore button on the autosave banner copies saved state onto live state, re-sets form inputs (client_id, narrative_variables, overrides), calls renderVars + renderDerivedDomains + syncOverrides. Best-effort. Toast notes that research/strategy/build options sections may need re-triggering since their re-hydration is more complex than v1 scope.
- **Cross-cutting E** (shared modal helper with focus trap): focus trap + focus restoration CLOSED on the snippet editor modal in PR #151. Establishes the pattern template for other modals. The pure "shared helper extraction" (a `wireModal()` function importable across pages) is still deferred because the script-tag bundling pattern decision (is:inline + define:vars vs bundled imports) hasn't been finalized; current modals copy the ~30-line template.

All other findings are closed. See the per-batch commit messages in PRs #137-148 for the implementation detail.

## What this audit did NOT cover

- Performance: wizard page weight (large file, lots of inline JS), composer execution time, render times under load
- SEO/discoverability of the public proposal pages (probably non-issue since these are gated)
- Email rendering across major clients (Gmail, Outlook, Apple Mail) — `contract-emails.ts` HTML wasn't sample-rendered
- The mobile experience comprehensively — flagged on tier picker but not exhaustively
- Browser compatibility (specifically Safari quirks on tier picker, intake form)
- Spec-vs-implementation drift on the standard contract template (`standard-v3.md` vs renderer behavior)

These should be addressed in follow-up audits when scope is bounded.

---

## Cross-references

- Structural audit (all 7 findings closed): `docs/audits/proposal-chain-audit-2026-05-24.md`
- Snippet editor implementation: PR #139
- Tier-override picker (Finding 3 UI): PR #137
- Render parity test harness (Finding 6): PR #138 — extends naturally to test the UI-text-vs-Schedule-A claim in W6
- Voice rules: `src/lib/proposal-ai/voice-lint.ts` + memory `feedback_voice_and_formatting`
- Multi-site handling plan: `.claude/plans/multi-site-portal-handling.md`
