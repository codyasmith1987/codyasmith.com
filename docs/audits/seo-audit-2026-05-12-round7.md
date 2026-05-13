# SEO audit 2026-05-12, Round 7

Branch: seo-security-improvements
Scope: public-facing pages and supporting code only. Portal admin out of scope.
Auditor: Claude Code (Opus 4.7, 1M context) sub-agent
Prior rounds: docs/audits/seo-audit-2026-05-12.md (41 findings), docs/audits/seo-audit-2026-05-12-round2.md (18 findings), docs/audits/seo-audit-2026-05-12-round3.md (11 findings), docs/audits/seo-audit-2026-05-12-round4.md (8 findings), docs/audits/seo-audit-2026-05-12-round5.md (9 findings), docs/audits/seo-audit-2026-05-12-round6.md (7 findings)

## Summary
- Total findings: 5 (critical: 0, high: 0, medium: 1, low: 2, info: 2)
- Trajectory: 41 to 18 to 11 to 8 to 9 to 7 to 5. Down two from round 6 with no regressions and no new findings introduced.
- Round 6 ship work landed cleanly. Both deferred OG halves (tag page card and 404 card) closed in one round each.
- What's truly remaining vs blocked: the only actionable items left are the two infra/docs carry-overs (sitemap and RSS postbuild assertion, CSP image-src note in CLAUDE.md). Both are info severity. Every other open item is blocked on Cody-input (case studies content, sameAs URLs) or a design classification call (text-neutral-700 accessibility pass).
- Recommendation: stop the audit cadence here. The remaining actionable items are one-line infra additions that do not need an audit round to file. Cody-blocked work resumes when content and profile URLs land.

## Round 6 fixes verified in code
- SEO6-003 resolved: `src/pages/blog/tags/[tag].astro:40-41` now passes `ogImage="/og/blog/tag.png"` and `ogImageAlt={`Tagged: ${tagLabel}`}` to Base. The shared endpoint at `src/pages/og/blog/tag.png.ts` ships with `prerender = true`, renders a "Patterns I can't shake." card with eyebrow "Tagged", kicker "Cody Smith", and a "grouped by what keeps coming back" subtitle. Cache-Control set to immutable. The decision to ship one shared card rather than per-tag dynamic generation is documented in the round 6 commit message and is the correct call for the static-asset count. Every `/blog/tags/{tag}` URL now shares a tag-themed preview rather than the home card.
- SEO6-004 resolved: `src/pages/404.astro:5` now passes `ogImage="/og/404.png"` and `ogImageAlt="404: This page doesn't exist."` to Base. The endpoint at `src/pages/og/404.png.ts` ships with `prerender = true`, renders "This page doesn't exist." with eyebrow "404", kicker "Cody Smith", and the "either something moved or you typed something creative" subtitle. Cache-Control set to immutable. A stale 404 URL pasted into Slack or LinkedIn now shows a Page-not-found preview rather than the home card.

## Findings

### [SEO7-001] Case studies collection still empty; index hero and blog hero still promise content that does not exist
**Severity**: medium
**Dimension**: 15 (Content quality), 6 (Internal linking), 8 (Sitemap), 19 (RSS)
**Files**: `src/content/case-studies/` (empty except `.gitkeep`), `src/pages/blog/case-studies/index.astro:52-58`, `src/pages/blog/index.astro:62-64`, `case-study-psychographic-personalization.md` (still at repo root)
**Observation**: Round 1 SEO-007, round 2 SEO2-001, round 3 SEO3-001, round 4 SEO4-002, round 5 SEO5-001, round 6 SEO6-001 all unresolved. The `src/content/case-studies/` directory contains only `.gitkeep`. The case-studies RSS feed remains empty. The case-study slug route returns no static paths. The candidate file `case-study-psychographic-personalization.md` still sits unedited at the repo root. The blog-index hero at lines 62-64 still reads "Case studies on clients my lawyer cleared." The case-studies index hero at lines 52-58 still reads "Jobs my lawyer cleared. The rest is for the bar." The OG card at `/og/blog/case-studies.png` reads "Jobs my lawyer cleared." (eyebrow "Case studies"). Three social-share surfaces and two hero copy blocks now advertise a content collection that contains zero items. Filing for the seventh time because the promise-to-content gap is now load-bearing on every social share of a blog-section URL. Blocked on Cody input.
**Recommendation**: Same three options as prior rounds. Move the candidate into `src/content/case-studies/` after legal review, ship a new greenlit case study, or rewrite the hero copy on both routes plus the OG card text to drop the "case studies" promise.
**Effort**: medium (content) or trivial (copy edit)
**Verification**: Either `/blog/case-studies/{slug}` returns valid Article JSON-LD, or the hero copy on `/blog` and `/blog/case-studies` matches what the page actually contains, plus the OG card text on `/og/blog/case-studies.png` aligns with both.
**Status**: blocked on Cody input.

### [SEO7-002] Person.sameAs and Organization sameAs still empty of external profiles
**Severity**: low
**Dimension**: 3 (Structured data), 18 (Schema validity), 17 (Entity disambiguation)
**Files**: `src/pages/about.astro:49`, `src/pages/index.astro:12-64`
**Observation**: Round 1 SEO-004, round 2 partial, round 5 SEO5-003, round 6 SEO6-002 all unresolved. The Person node at about.astro:49 still carries `"sameAs": ["https://codyasmith.com"]`, a self-referencing array. The Organization node on the homepage `@graph` at index.astro lines 16 through 35 has no `sameAs` array at all. Without external links the schema is technically valid but produces nothing Google, Claude, or Perplexity can cross-reference. Listed as outstanding deferred work in every round prompt for the past three rounds. Blocked on Cody confirming which profile URLs to publish.
**Recommendation**: Three minimum candidates worth adding when accounts exist: LinkedIn profile URL, GitHub profile URL, and the AllenComm portfolio entry at https://allencomm.com/portfolio/spts-provides-suicide-prevention-training (already linked in /about visible copy at about.astro:167). Add to both Person.sameAs at about.astro:49 and Organization.sameAs at index.astro inside the Organization node around line 27.
**Effort**: trivial (once URLs are confirmed)
**Verification**: Rich Results test on /about shows Person.sameAs with at least one external URL; Search Console knowledge-panel test on the Organization shows linked profiles.
**Status**: blocked on Cody input.

### [SEO7-003] Text-neutral-700 still used 114 times across 38 files; classification deferred again
**Severity**: low
**Dimension**: 14 (Accessibility)
**Files**: many across `src/pages/`, `src/components/`, `src/layouts/`
**Observation**: Round 1 SEO-032, round 2 SEO2-012, round 3 SEO3-007, round 4 SEO4-005, round 5 SEO5-006, round 6 SEO6-005 all unresolved. Hit count rose since round 6 (86 to 114) and file count rose 33 to 38, driven by the portal admin pages added during the security-improvements branch work. Most new uses are portal chrome (table dividers, tag badge separators, breadcrumb middots) and stay decorative. But the rise highlights why this needs a documented rule before more decorative uses accumulate. Several copy-bearing uses persist: count badges next to tag chips on `/blog` and `/blog/articles`, the "Tagged" breadcrumb separator on `/blog/tags/{tag}`, count badges on `/blog/case-studies` sector chips, the SVG arrow text on home service cards, and placeholder text on form inputs in /contact, /listener, and /portal/login. Filing for the seventh time without movement because the classification work is one focused afternoon and unblocks Lighthouse improvements visible to anyone running a third-party accessibility audit on the public site.
**Recommendation**: Same as prior rounds. Single inventory pass on the 38 files. Decorative middots, dividers, and breadcrumb separators stay at neutral-700 with `aria-hidden="true"` added where assistive tech currently announces them. Meaningful counters, timestamps, and form placeholders lift to neutral-500 or above. Document the rule in CLAUDE.md so the next contributor does not regress.
**Effort**: small (audit) or medium (full pass)
**Verification**: Lighthouse Accessibility reports zero contrast failures on homepage, services, contact, listener gate, and a blog detail page; CLAUDE.md carries the rule.
**Status**: blocked on design classification call.

### [SEO7-004] No sitemap or RSS post-build assertion still in place
**Severity**: info
**Dimension**: 8 (Sitemap), 19 (RSS)
**Files**: `astro.config.mjs`, `scripts/postbuild-security-headers.mjs`, `package.json:10`
**Observation**: Round 2 SEO2-014, round 3 SEO3-009, round 4 SEO4-007, round 5 SEO5-008, round 6 SEO6-006 unresolved. The build chain at `package.json:10` runs `astro build && node scripts/postbuild-security-headers.mjs`. The postbuild script wraps the entry handler with security headers but performs no assertion on the sitemap or RSS artifacts. A regression in `site`, `trailingSlash`, or the sitemap or RSS integrations would ship a broken artifact silently and Search Console would notice before the team did. Trivial to fix. Filing one more time because no fresh discussion of the gap is needed.
**Recommendation**: Add `scripts/postbuild-assert-sitemap-rss.mjs` opening `dist/sitemap-index.xml`, asserting the homepage, /services, /blog, and at least one blog detail URL appear, then opening each RSS XML and asserting `<link>` values are absolute URLs starting with `https://codyasmith.com`. Chain after the headers script. Exit nonzero on failure.
**Effort**: trivial
**Verification**: `npm run build` fails when sitemap or RSS is malformed; passes when complete.
**Status**: actionable, one-file addition.

### [SEO7-005] CSP image-src constraint still undocumented in CLAUDE.md
**Severity**: info
**Dimension**: 16 (Tracking), 11 (Performance), 15 (Content quality)
**Files**: `security-headers.json:5`, `src/middleware.ts`, `CLAUDE.md`
**Observation**: Round 2 SEO2-018, round 3 SEO3-010, round 4 SEO4-008, round 5 SEO5-009, round 6 SEO6-007 unresolved. CSP is centralized in `security-headers.json:5` with `img-src 'self' data: blob:`. CLAUDE.md still carries no note about the constraint (grep for `img-src`, `public/images/blog`, and `CSP` returns no matches in CLAUDE.md). A future content author who references an external image URL in an article or case-study MDX will see the image silently blocked in the browser with the only signal being a console CSP violation. The rule was correctly enforced for current content (every cover under `public/images/blog/*`) but the enforcement is invisible to authors.
**Recommendation**: Same one-line addition under content-authoring conventions in CLAUDE.md: "All blog images must be uploaded to `public/images/blog/{slug}/`; external image URLs will be blocked by the site CSP (`img-src 'self' data: blob:`)." Applies to MDX Figure and Gallery entries as well.
**Effort**: trivial
**Verification**: A future MDX file referencing an external image URL fails to render in the browser with a CSP violation visible in the console; CLAUDE.md note prevents the mistake at authoring time.
**Status**: actionable, one-line documentation addition.

## What changed between round 6 and round 7
- /blog/tags/{tag} now ships a per-page OG card via the shared `/og/blog/tag.png` endpoint, closing the deferred half of SEO5-005 and SEO6-003.
- /404 now ships a per-page OG card via `/og/404.png`, closing the deferred half of SEO5-004 and SEO6-004.
- text-neutral-700 hit count and file count grew (86 to 114, 33 to 38) due to portal admin pages added on the security-improvements branch. None of the new uses are on the indexed public marketing surface; all the growth is in portal chrome. The audit rule still applies but the public-page scope did not regress.
- og-default.png appears missing from `public/` but is correctly generated at build via the prerender endpoint at `src/pages/og-default.png.ts`. Not a finding. The homepage and any page without an explicit `ogImage` prop will resolve to this generated PNG.
- All previously verified strengths from round 6 remain in place. Spot-checked: Base.astro OG meta set, four service detail BreadcrumbList JSON-LD start with Home, three blog list OG endpoints render correctly, /listener WebApplication + BreadcrumbList JSON-LD, robots.txt AI-bot record groups, sitemap filter, Article JSON-LD pipeline.

## Strengths confirmed since round 6
- Fourteen non-default per-page OG endpoints under `src/pages/og/` (services, four service children, about, contact, listener, work, privacy, 404, three blog list cards, one shared tag card) plus the og-default endpoint and two parameterized blog detail endpoints. Every indexed public route now ships a per-page OG image.
- All four service detail BreadcrumbList JSON-LD start with Home as position 1.
- /listener emits a WebApplication JSON-LD with the free-offer signal Google parses for the SoftwareApplication rich result, plus a BreadcrumbList.
- 404 page emits `<meta name="robots" content="noindex, nofollow">` and a tailored OG card.
- Person schema on /about accurately models the five visible awards.
- All four service detail pages emit Service plus FAQPage plus BreadcrumbList JSON-LD with provider @id cross-reference to the homepage Organization node, and all four ship `termsOfService`.
- Article JSON-LD pipeline complete and centralized in BlogPost.astro.
- Homepage @graph (Organization plus ProfessionalService plus WebSite) cross-references via @id.
- Base.astro emits a complete Open Graph plus Twitter Card set with image dimensions, image alt, article meta, site name, locale, and canonical.
- middleware.ts emits X-Robots-Tag: noindex, nofollow on every response under /portal.
- astro.config.mjs sets `trailingSlash: 'never'` and the sitemap filter excludes portal, api, PNG endpoints, and naming-preview.
- Fonts loaded via preload-as-style plus media-print swap with noscript fallback.
- Persona variant H1s collapse to one DOM `<h1>` per page via `<div role="heading" aria-level="1">` wrappers; aria-hidden toggled correctly via swapAxis.
- Skip-to-content link with strong focus contrast at the top of Base.astro.
- viewport, lang, charset, theme-color, manifest, favicon variants, and apple-touch-icon all present.
- No third-party tracking scripts, consistent with the privacy policy.
- Astro view transitions wired so SPA-style nav re-initializes accessibility and personalization through astro:after-swap hooks.
- robots.txt explicitly disallows /portal/, /api/, and /naming-preview under each named AI-bot record group plus the wildcard.
- Tag pages emit ItemList JSON-LD when entries exist; emit no JSON-LD when empty.

## Regressions
None observed. Public-page scope is clean. The text-neutral-700 hit count growth is contained to portal admin chrome and does not affect the indexed marketing surface.
