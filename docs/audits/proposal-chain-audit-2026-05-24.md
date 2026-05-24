# Proposal chain audit — 2026-05-24

The proposal-builder system spans seven surfaces between "AI gathers public info about a prospect" and "executed contract in `documents`." Cody's concern: surfaces have been getting fixed in isolation, the round-trip from rule → product → price → proposal → contract is not airtight, and the wizard surfaces don't make their role in the chain visible to the admin.

This audit traces the chain, identifies mapping breaks, and ranks them. It is not implementation — it's the input for what to fix and in what order.

---

## The chain

Each row is a stage; each cell names what's true at that stage and where the data flows next.

| # | Stage | Surface | What lives here | Flows to |
|---|---|---|---|---|
| 1 | Discovery | `src/lib/proposal-ai/research/client-research.ts` | AI returns `ClientResearchResult` with revenue band, page count, industry, urgency, focus, CMS, domains, plus six synthesis fields (`recommended_product_mix`, `recommended_tier_per_product`, `clv_horizon`, `cody_time_intensity`, `sales_angles`, `risk_signals`) | Wizard panels |
| 2 | Decision | `src/pages/portal/admin/proposals/new.astro` | Admin reviews research, applies findings to wizard state (`product_vars`, `narrative_variables`, scope), picks products via strategy panel, supplies signers | `composeProposal()` server-side |
| 3 | Composition | `src/lib/products/index.ts` + `narrative-snippets.ts` + `web-management.ts` etc. | `composeProposal()` reads picks + variables + engagement strategy, looks up matching snippet by `(product_combo, ecosystem, urgency)`, generates interactive steps per product, computes pricing via product-driven dispatcher | `proposals` table row (JSON config blob) |
| 4 | Render + accept | `src/pages/portal/proposals/[slug].astro` + `src/pages/portal/api/proposals/[slug]/accept.ts` | Prospect reads narrative, picks tiers on interactive step cards, signs LOI. `accept.ts` snapshots `selections`, `signatures`, `pricing_snapshot` into `proposals.config.accepted_state` and flips status to `finalized` | Agreement generation |
| 5 | Agreement | `src/pages/portal/api/admin/agreements/index.ts` (create from proposal) + intake | Admin generates agreement from finalized proposal. Schedule A built via `buildScheduleA()` (`src/lib/contract-schedule.ts`) from tier picks + product definitions. Intake fields collected from each signer | `agreements` row, signers notified |
| 6 | Sign | `src/pages/portal/contracts/[slug].astro` (signer view) | Signers see standard contract template (`src/contracts/templates/standard-v3.md`) with Schedule A interpolated. Each signs in sequence | Executed PDF stored in `documents` |
| 7 | Bind | Operations | Engagement begins. Pricing, hours, cadences, change-order rules all governed by the executed contract + Schedule A | Invoices, projects, change orders |

Every data point should round-trip the chain consistently. The audit below finds five places it does not.

---

## Findings

### Finding 1 — Multi-site Web Management pricing: four canonical sources, three different formulas (HIGH SEVERITY, expanded)

This was originally scoped to just onboarding pricing. On full inspection it's worse — **monthly and onboarding both have multiple incompatible canonical statements**, and the doc that 05 says is canonical (`business-design-v2.docx`) is itself in conflict with the contract, the code, and the rules doc that refers to it.

**business-design-v2.docx** (canonical pricing per 05 §3):

> "Multi-Site Add-On (Preserved)
> When a client has multiple domains, the multi-site pricing stacks on top of whichever ecosystem and tier they are in. The formula is unchanged:
> - Each additional domain: **base onboarding x 0.25**
> - Monthly for 2 sites: **current monthly + (base monthly x 0.66)**
> - Monthly for 3 sites: **compounds from there**
> - Hours scale proportionally with each additional site
>
> The multi-site add-on applies within the same ecosystem. If a client has two mid-size sites, both are priced within Ecosystem B. If a client has one small site and one mid-size site, **the primary site sets the ecosystem and the add-on uses that ecosystem's base rate**."

**05-BUSINESS-RULES-AND-STRUCTURE.md** §4:

> "Site takeover onboarding is priced per site at the ecosystem base onboarding fee in `business-design-v2.md`. The multi-site formula reduces the recurring monthly Web Management fee for additional sites; it does not reduce per-site onboarding. A takeover audit happens once per site and is billed in full per site."

**Code** (`src/lib/products/web-management.ts`):

```typescript
// computeMultiSiteMonthly:
return base + (n - 1) * base * 0.80;  // linear, 80% per add'l site, NO compounding
// computeMultiSiteOnboarding:
return base * n;                      // full base per site (100%)
```

**Standard contract template** (`src/contracts/templates/standard-v3.md` §3.1):

> "each additional site is priced at eighty percent (80%) of the base monthly for the tier (the per-site floor), and onboarding for each additional site is priced at twenty-five percent (25%) of the base onboarding."

**The conflicts, side by side:**

| Source | Monthly per additional site | Onboarding per additional site | 3+ sites |
|---|---|---|---|
| business-design-v2 | base × 0.66 | base × 0.25 (75% off) | "compounds from there" |
| 05 rules | (defers to v2) | full base per site | n/a (defers) |
| Standard contract template v3 | base × 0.80 (linear) | base × 0.25 (75% off) | linear (per-site floor) |
| Code (WM product) | base × 0.80 (linear) | base × 1.00 (full per site) | linear, no compounding |

**Summary:**

- **Monthly**: v2 says 0.66 (with compounding from site 3 on). Code, contract, and tests say 0.80 linear. **No two say the same number.**
- **Onboarding**: v2 and contract say 0.25. 05 rules and code say 1.00 (full). **Two-and-two split.**

**Cody's question that surfaced this** (turn 2026-05-24): would the formula compound to insane numbers at 3+ sites?

Math under each formula at Eco B Better ($797/mo):

| Sites | v2 formula (0.66, compounds) | Code formula (0.80, linear) |
|---|---|---|
| 1 | $797 | $797 |
| 2 | $797 + $526 = $1,323 | $797 + $638 = $1,434 |
| 3 | $1,323 × 1.66 = $2,196 | $797 + 2 × $638 = $2,072 |
| 4 | $2,196 × 1.66 = $3,645 | $797 + 3 × $638 = $2,710 |
| 5 | $3,645 × 1.66 = $6,051 | $797 + 4 × $638 = $3,348 |

The code formula is linear, not compounding. So the live code is NOT insane at 3+. The v2 doc says it compounds, and at 5 sites that's nearly 2× the linear formula. **Cody's "this is crazy" instinct was right about the v2 wording, but the code doesn't actually do that.**

**Why this is high severity:**

This is the contract → invoice → client integrity problem. If a client reads the standard contract template and Schedule A is generated from the code, the numbers will not match. If a client reads the business-design-v2 design doc (during sales conversations) and signs the contract, the numbers in the contract are different from what they were quoted. The invoices they receive (from code) are different again.

This needs a **single canonical decision from Cody**, then a sweep across all four surfaces to enforce it.

**Cody's additional question that surfaced in the same turn:** instead of all additional sites being priced off the PRIMARY site's ecosystem (per v2's "primary sets the ecosystem" rule), should each additional site be priced off ITS OWN ecosystem (based on its own page count) × the multi-site discount?

That changes the answer to "if Site 1 is 100 pages (Eco B) and Site 2 is 15 pages (Eco A), then Site 2's monthly is (Eco A Better base) × 0.80 instead of (Eco B Better base) × 0.80."

This is more accurate sizing but contradicts v2's primary-sets-ecosystem rule. v2 explicitly says "the primary site sets the ecosystem and the add-on uses that ecosystem's base rate." Cody's new idea would override that.

**Decisions Cody locked (2026-05-24):**

1. **Additional-site monthly discount: 0.80 of base, linear.** Each additional site adds `base_monthly_for_that_site * 0.80` to the engagement monthly. No compounding.
2. **Additional-site onboarding discount: 0.80 of base.** Same as monthly. Each additional site's onboarding is `base_onboarding_for_that_site * 0.80`. This overrides what 05 §4 currently says ("full base per site").
3. **Ecosystem routing: per-site.** Each managed site's ecosystem is determined by its own page count. Primary's page count routes the primary; Site 2's page count routes Site 2; etc. The 0.80 multiplier applies to THAT site's own ecosystem base. This overrides what v2 currently says ("primary sets the ecosystem and the add-on uses that ecosystem's base rate").
4. **3+ sites: linear, no compounding.** Confirmed.
5. **Canonical truth going forward:** business-design-v2.docx remains canonical. It gets rewritten to match the locked decisions above, with a date-stamped revision note. 05 rules, contract template, code, code tests, snippet copy, and proposal-side display all get swept to match v2's new wording.

**Worked example with Cody's decisions:**

Three managed sites at the Better tier; sites have different page counts:

| Site | Pages | Ecosystem | Better monthly base | Effective monthly | Better onboarding base | Effective onboarding |
|---|---|---|---|---|---|---|
| 1 (primary) | 100 | B | $797 | $797 (full) | $1,200 | $1,200 (full) |
| 2 | 15 | A | $497 | $397.60 (× 0.80) | $800 | $640 (× 0.80) |
| 3 | 200 | C | $1,497 | $1,197.60 (× 0.80) | $2,000 | $1,600 (× 0.80) |
| | | | **Total** | **$2,392.20 / mo** | | **$3,440 onboarding** |

Linear, predictable, sized per site.

**Sweep work to land the decisions:**

Surfaces that need updating, all dated `2026-05-24` for the revision marker:

- `C:\Users\codya\Downloads\business-design-v2.docx` — rewrite Multi-Site Add-On section. Replace 0.66/compound/primary-sets language. New rules: 0.80 linear per-site, 0.80 onboarding per-site, each site's own ecosystem routes its base, hours scale proportionally with each site. Add revision footer: "Multi-site section revised 2026-05-24 per audit `docs/audits/proposal-chain-audit-2026-05-24.md` finding 1."
- `C:\Users\codya\OneDrive - Cody A Smith LLC\Cody A Smith LLC\May business validation and lessons learned work\05-BUSINESS-RULES-AND-STRUCTURE.md` §4 — rewrite to match: per-site ecosystem, 0.80 monthly + 0.80 onboarding for additional sites. Add revision note.
- `src/contracts/templates/standard-v3.md` §3.1 — rewrite to match. Add `<!-- Revised 2026-05-24 -->` comment.
- `src/lib/products/web-management.ts` — `computeMultiSiteOnboarding` changes from `base * n` to `base + (n-1) * base * 0.80` (mirror the monthly formula). The pricing functions need to switch from "primary's ecosystem base × multiplier × n" to "sum over sites of (each site's own ecosystem base × per-site multiplier)" — this requires the pricing pipeline to receive per-site page counts, not just a count.
- `src/lib/products/types.ts` — `ProductContext.managedSites` array gains a `page_count` field per site. The wizard captures it.
- `src/lib/migrations/0XX-client-sites-page-count.ts` — new migration: ADD COLUMN `page_count INTEGER` to `client_sites`. Backfill from crawl data when available (`crawl_urls` joined on host).
- `src/pages/portal/admin/proposals/new.astro` — WM product-variables section adds per-site page-count entry (or pulls from client_sites). Display each site's routed ecosystem.
- `src/pages/portal/admin/clients.astro` — already manages client_sites; need to expose page_count per site editable.
- `src/lib/contract-schedule.ts` — Schedule A WM section renders per-site rows with each site's ecosystem and monthly. The `monthly_base` and `monthly_total` fields need to handle per-site differing bases (sum or per-row).
- `src/lib/products/narrative-snippets.ts` — snippets 1, 3, 7, 8 (WM-only by ecosystem) and the multi-site phrasing in inline WM narrative need to be updated to reflect per-site ecosystem.
- `tests/run-products-tests.mjs` — multi-site tests need full rewrite. Multiple ecosystems per engagement is now testable.
- Snippet wording: "additional sites at 80 percent of the base" → "additional sites at 80 percent of their own ecosystem's base" or similar.
- Proposal renderer at `src/pages/portal/proposals/[slug].astro` — tier card display for multi-site needs to show per-site routing.

All seven doc surfaces that get touched need date stamps in the format `Revised YYYY-MM-DD` per `docs/audits/proposal-chain-audit-YYYY-MM-DD.md`. This is a versioning audit trail so any future drift can be tracked.

This is the largest single piece of work in the audit. Estimate: a careful one-pass sweep that respects the chain takes the better part of a focused session. It will touch the canonical pricing doc (v2), so we treat that doc edit as the source of truth and propagate.

---

### Finding 2 — "Sales angles" section name vs returned data (MEDIUM SEVERITY)

The Phase 1 system prompt asked the AI to return:

> "Sales-angles logic: Pull from scraped content. Each angle is one phrase that names the client's perceived problem in language they would recognize, backed by a quote or paraphrase from the actual content."

The intent: phrases that describe what the prospect is trying to solve / what's hard for them. Cody would lead with those angles in conversation. The proposal opener would echo the prospect's problem back in their own language.

The AI's actual behavior on MCM:

- "Ensure your switchgear is built to highest quality standards"
- "Quality is Priority #1 — Our Medium Voltage Metal Clad and Metal Enclosed products are ANSI C37.20.1, C37.20.2 and C37.20.3/4 compliant."
- "Get direct access to engineering support without layers of bureaucracy"
- "Built faster than industry average"

These are MCM's own marketing copy — what MCM tells THEIR customers. Their pitch to their buyers. Not their problems.

Three different concepts collapsed under one label:

| Concept | What it is | Use in the proposal | Current state |
|---|---|---|---|
| A. Prospect's customer-facing pitch | Their value props to their customers ("Quality is Priority #1") | Echo back in The Situation opener so they feel understood. Hint at which of Cody's products supports those values | What the AI returns today, mislabeled |
| B. Prospect's internal gaps | What's broken or stale ("Site on WPEngine, content not updated since 2022") | Drive the strategy panel's product mix. Drive onboarding scope ("month one focuses on stabilizing the site that carries their quality story") | Partially in `revenue_band` / `cody_time_intensity` / `risk_signals` rationales; not surfaced as discrete actionable items |
| C. Cody's pitch lines | How Cody sells ("I become the outside thinker for the questions the room can't answer") | Lives in the snippet registry as `what_i_recommend_paragraphs` | Lives in `src/lib/products/narrative-snippets.ts`, doesn't surface in the wizard |

The wizard's "Sales angles to lead with" surfaces type A under a label that sounds like type C. Cody reads the section header and expects "what I should pitch them"; gets "what they pitch their customers."

The connection from type A to Cody's pitch (product mix) is also implicit-only. Each MCM value prop maps cleanly to something Cody's products do:

| Prospect's value prop (A) | Cody's product that supports it |
|---|---|
| "Quality is Priority #1" | WM keeps the site that communicates this quality story running |
| "Direct access to engineering support" | MC can sharpen this differentiation across the site, content, vendor selection |
| "Built faster than industry average" | Build (when relevant) could foreground this speed story in IA |

Right now that map lives only in admin heads (so far, just Cody's). The wizard doesn't show it.

**Where to land the fix (two parts):**

1. Rename the wizard section to **"How they describe themselves to their customers"** (or similar — admin-facing label that matches what the data actually is). Sub-label or tooltip explains: "These are echoed back in the proposal opener so the prospect feels understood, and they're starting points for connecting your products to their value chain."

2. Each angle gets a **"How this maps to my pitch" annotation** — small text or expandable disclosure showing which of Cody's products supports this value prop. The mapping can be admin-edited (free text) or AI-suggested (a future enhancement). Phase 1: just give space for the connection. Phase 2: AI-suggest the connection.

A separate finding: add a new synthesis field `internal_gaps` (concept B above) to the research prompt. Surface as a sibling section "What's broken or under-served." Drive the product-mix recommendation directly from these gaps + the value props. Right now product mix is recommended via rationale strings; making the gaps explicit makes the rationale traceable.

---

### Finding 3 — AI tier recommendation doesn't reach the prospect (MEDIUM SEVERITY)

The Phase 1 research returns `recommended_tier_per_product` — the AI's per-prospect tier recommendation, e.g., "Better" for MCM's WM. Admin sees this in the strategy panel as "Tier hint."

The buyer (prospect on the proposal page) sees the tier picker. Each tier card has a `recommended: true` badge IF the product definition marks it recommended. From `src/lib/products/web-management.ts`, "Better" is marked `recommended: true` at every ecosystem (lines 56, 115, 174). MC is the same (lines 53, 112, 169). Build sizes don't have tier picks at all.

**The mismatch:** the AI might recommend "Best" for a high-touch prospect. The admin sees "Tier hint: Best" in the strategy panel. The prospect lands on the proposal page and sees "Better" marked as recommended (the static product default), not "Best" (the AI's per-prospect recommendation).

**Why this matters for CLV:** the recommended tier badge is the single biggest influence on which tier the prospect picks. Defaulting to "Better" for everyone means the AI's tier recommendation (which is informed by `cody_time_intensity`, `clv_horizon`, the rationale, etc.) loses its primary value: steering the prospect toward the right tier.

**Where to land the fix:** in `composeProposal()` (around `src/lib/products/index.ts:88-93`), when generating each product's steps, pass the AI's recommended tier and override the `recommended: true` flag on the matching tier option. Falls back to the product's default `recommended` field when no AI recommendation exists.

Side effect: the admin should see in the wizard preview which tier will be marked recommended (so admin can override if AI got it wrong). This is the same per-card "Applied" pattern from PR #96 but for tier overrides.

---

### Finding 4 — Closer doesn't tie back to prospect's value props (LOW SEVERITY)

The "How this works in practice" closer (Phase 2, `composeHowItWorksCloser`) is constant boundary language. It tells the prospect: month one is concentrated; afterwards is the cadence we agreed to; new work outside scope is a change order. Good content. Echoes contract sections 5.4 / 6.4 / 7.5 / 8 in plain language.

But the closer doesn't reconnect to the prospect's stated value props (the angles from Finding 2). The proposal opens with their language ("The Situation") and ends in Cody's language ("How this works in practice"). The bridge between is missing — there's no paragraph that says "and here's how my engagement protects what you said you value."

For MCM specifically: opener echoes "quality is priority," "direct engineering access," "fast delivery." Then the recommend section is product-shaped (WM does X, MC does Y). Then the closer is boundary-shaped. The thread from value-prop → engagement-protects-value-prop is left implicit.

**Where to land the fix:** add an optional fourth paragraph to `composeHowItWorksCloser` that ties to `sales_angles[0]` when present:

> "[Concrete example tying engagement to the prospect's first stated value prop, in plain Cody-voice prose. e.g., for MCM: 'A site that conveys your quality story matters more when the site stays running. That's what the cadence above protects.']"

This is template-prone (could feel formulaic if applied to every proposal), so it should be optional and rely on the snippet registry to author specific tie-back paragraphs for each major sales_angle pattern.

Lower-severity than Finding 3 because the proposal-as-it-stands works without this bridge. It just reads stronger with it.

---

### Finding 5 — Apply/unapply asymmetry on research cards (LOW SEVERITY)

After PR #96, clicking "Apply" on a research card adds the finding to `appliedFindings` and re-renders with the applied state visible. Clicking the now-"Applied" button RE-applies (idempotent — same value goes to the same place). There is no undo.

If admin applies a finding by mistake — clicked the wrong card, or AI value was wrong but applied before noticing — the only way back is to navigate to the destination (uncheck the product checkbox, clear the dropdown) manually.

**Where to land the fix:** when card is in applied state, the button label changes to "Unapply" (or a small × next to the "applied" badge). Click runs the inverse — removes product from scope if it was added, clears the narrative variable if it was set, etc.

Inverse-action logic per block type:

| Block | Apply does | Unapply should do |
|---|---|---|
| Revenue band | adds MC to scope + sets revenue_band | removes MC from scope (or clears just the variable if MC was already in scope before Apply) |
| Industry | sets narrative_variables.industry | clears narrative_variables.industry, resets the select |
| Urgency | sets narrative_variables.urgency | clears narrative_variables.urgency, resets the select |
| Focus | sets narrative_variables.focus[] | clears the array, deselects options |
| CMS | no destination change | no-op (just remove from appliedFindings) |
| Page count | adds WM to scope + sets page_count + site_count | removes WM from scope (or clears just the variables if WM was already in scope before Apply) |
| Domains found | sets client_domain to primary | reverts client_domain (need to remember the prior value) |

Edge case: if the user applied multiple findings that BOTH touched the same destination (e.g., applied Page count to add WM, then later edited site_count manually), Unapply on Page count shouldn't blow away the manual edit. The implementation needs to remember the pre-apply state per finding.

---

### Finding 7 — Multi-option deployment picker (the Raised Bar pattern) not expressible (HIGH SEVERITY)

The live Raised Bar proposal (`src/lib/proposal-configs/raised-bar.ts`) uses a two-column choice section on the proposal page: **Option 1** (unified Builders site with Tailwater section inside) vs **Option 2** (standalone Tailwater micro-site + separate Builders site). The prospect picks one; the rollout phases swap accordingly; Schedule A reflects the picked option.

That section is rendered from a `binary_picker` step with id `site_setup` plus a paired `rollout_scenarios` block keyed by the step's value. Both live on the `raised_bar_v1` pricing formula config.

In the new `product_driven_v1` builder, the prospect can pick TIERS within a product (good/better/best) and a yes/no on adding Marketing Consulting. There is no surface for the admin to define **deployment options inside a product** — two or more shapes the same build could take, that change pricing or rollout — and have them rendered as a two-column choice on the proposal page.

The Build product's variable schema today (`src/lib/products/build.ts:78-105`) collects:
- `build_size` — small / mid / large (pricing band)
- `build_count` — integer (drives subsequent-build discount)
- `build_description` — one sentence the proposal narrative carries

There's no `build_options` field for "the prospect picks between 2 or 3 deployment shapes."

Looking at the original product-driven plan (`.claude/plans/serene-drifting-platypus.md`):

> "**`site_setup` is a Build-product option**, only generated when Build is in scope AND the build has multiple deployment shapes. Default proposals don't show it. ... This is the only place `site_setup`-style steps live."

So the intent was always that Build supports multi-option. The current code stub acknowledges it but doesn't expose it:

> "site_setup-style binary pickers are NOT a primary step. They only appear when Build is in scope AND the build has multiple deployment shapes (the Raised Bar pattern). For v1, default builds generate ZERO interactive steps; admin can add a multi-config option set via the wizard's override step if needed." (`src/lib/products/build.ts:8-13`)

But the wizard's override step doesn't let the admin define options either. The product-driven_v1 builder cannot today produce a Raised Bar-shaped proposal.

**What needs to happen for full parity:**

1. **Wizard UI:** Build product's per-product-variables section gains an optional "Deployment options" block. Admin can add 2-3 options. Each option captures:
   - Option title (e.g., "Unified Builders site, Tailwater inside")
   - Short pitch (one or two sentences shown on the prospect's option card)
   - Rollout impact (which phases change, or free-text rollout for this option)
   - Pricing delta (default $0; can be positive or negative if the option changes cost)
   - Schedule A impact (free-text or structured: which site rows in Schedule A's WM section, which build SOW references)

2. **Composer:** Build product's `generateSteps()` returns a `binary_picker` (or n-ary picker if 3+ options) when `build_options.length > 1`. Options surface as cards.

3. **Composer narrative:** Build product's `generateNarrativeSnippets()` builds `rollout_scenarios` keyed by the picker's step id, similar to the Raised Bar pattern. Each scenario's `phases` come from the matching option's rollout-impact field.

4. **Pricing:** if an option carries a pricing delta, `computePricing()` adds it conditionally on the picked option id.

5. **Schedule A:** the WM section's site rows and the build SOW reference need to be conditional on the picked option, so the executed contract reflects the prospect's choice.

This is a meaningful feature addition, not a bug. The wizard is at v1 and v1 did not include multi-option deployment. Adding it is a v1.5 milestone.

Severity: HIGH because **without this, Cody cannot use the new wizard to draft anything resembling Raised Bar or the next sub-brand engagement that has more than one deployment shape**. Existing Raised Bar stays on `raised_bar_v1` and is untouched, but every future complex engagement falls back to hand-editing the legacy formula's config rather than using the wizard.

---

### Finding 6 — Schedule A vs proposal narrative wording (LOW SEVERITY, mostly clean)

Sampled the proposal renderer's tier display vs `buildScheduleAForProductDrivenV1()` output for WM at ecosystem B / Better:

| Surface | Renders | Same data? |
|---|---|---|
| Proposal page tier card | "$797 / month" + "Eco B Better" + "About eight pooled hours per month..." | Yes |
| Schedule A WM section | `monthly_base: 797`, `monthly_total: 797`, `included_hours: 8`, `update_cadence: 'bi-weekly'`, `response_time: 'standard tier response window'` | Yes — comes from the same tier definition |
| Contract template §3.1 | "Specific tier, included hours, response time, and per-site count are set in Schedule A" | Yes — defers to Schedule A consistently |
| Contract template §5.4 | "The monthly fee for Web Management includes the pooled hours stated for the chosen tier in Schedule A. Pooled hours apply across every site the Practice manages for the Client. Unused included hours do not roll over..." | Yes — matches snippet 1 ("predictability is the trade") and the closer |

No wording drift detected in this spot-check beyond Finding 1 (the onboarding contradiction). The pricing-related rounding-and-formatting paths look consistent. A full systematic check would require running each ecosystem/tier combination through the composer and comparing the rendered proposal text against the rendered Schedule A text — that's a one-time test harness, not a structural code issue.

---

## Recommendations, ranked

| # | Finding | Severity | Fix shape | Estimated work |
|---|---|---|---|---|
| 1 | Multi-site onboarding contract vs code contradiction | HIGH | Update `src/contracts/templates/standard-v3.md` §3.1 wording to match rules + code | Small, one file, no test impact |
| 7 | Multi-option deployment picker not in wizard | HIGH | Add `build_options` to Build product variable schema; wire `generateSteps` and `rollout_scenarios`; add wizard UI for option authoring | Larger — adds a new wizard surface + new composer branch + Schedule A conditionality |
| 2 | Sales-angles section labeling + product-map annotation | MEDIUM | Rename section, add per-angle product-map annotation slot; add `internal_gaps` synthesis field as separate Phase | Medium for labeling, larger for the new synthesis field |
| 3 | AI tier recommendation reaches prospect | MEDIUM | Override `recommended: true` per tier based on AI synthesis in `composeProposal()` | Medium, single function + test |
| 4 | Closer tie-back paragraph | LOW | Add optional fourth paragraph in `composeHowItWorksCloser` keyed to first sales angle; snippet-registry-authored | Small for scaffold, work moves to Cody for the actual ties |
| 5 | Unapply on research cards | LOW | Add inverse-action handler per block; track pre-apply state | Small per block, several blocks total |
| 6 | Schedule A vs proposal wording test | LOW | One-time test harness covering all (product, ecosystem, tier) combos | Medium — comprehensive test addition |

## What I'm not changing without sign-off

Every item above is documented but not coded. Per Cody's "audit-first, no more code yet" direction (2026-05-24 turn), the next step is review of this audit and prioritization, not implementation.

Particular caution before changing #2 and #3: those are structural changes to the synthesis layer and the composer. Changing `recommended_tier_per_product` to actually drive the prospect's tier picker is a CLV-shaping decision that lives upstream of all the snippet copy I shipped in PRs #87-89. If we change the default tier the prospect sees, the existing snippets that read at "Better" need a re-read against "what they sound like at the AI-recommended tier for THIS prospect" — a small but non-zero quality pass.

---

## Cross-references

- Canonical rules: `C:\Users\codya\OneDrive - Cody A Smith LLC\Cody A Smith LLC\May business validation and lessons learned work\05-BUSINESS-RULES-AND-STRUCTURE.md`
- Canonical pricing: `C:\Users\codya\Downloads\business-design-v2.docx`
- Standard contract template (v3): `src/contracts/templates/standard-v3.md`
- Research client and synthesis: `src/lib/proposal-ai/research/client-research.ts`, `src/lib/proposal-ai/research/prompts/client-research.ts`
- Product definitions: `src/lib/products/web-management.ts`, `marketing-consulting.ts`, `build.ts`, `training.ts`, `other-sow.ts`
- Snippet registry: `src/lib/products/narrative-snippets.ts`
- Composer: `src/lib/products/index.ts`
- Schedule A builder: `src/lib/contract-schedule.ts`
- Wizard: `src/pages/portal/admin/proposals/new.astro`
- Proposal renderer: `src/pages/portal/proposals/[slug].astro`
- Accept endpoint: `src/pages/portal/api/proposals/[slug]/accept.ts`
- Engagement-strategy initiative plan: `.claude/plans/engagement-strategy-synthesis.md`
