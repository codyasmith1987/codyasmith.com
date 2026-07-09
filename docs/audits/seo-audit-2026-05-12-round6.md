# SEO audit 2026-05-12, Round 6

Branch: seo-security-improvements
Scope: public-facing pages and supporting code only. Portal admin out of scope.
Auditor: Claude Code (Opus 4.7, 1M context) sub-agent
Prior rounds: docs/audits/seo-audit-2026-05-12.md (41 findings), docs/audits/seo-audit-2026-05-12-round2.md (18 findings), docs/audits/seo-audit-2026-05-12-round3.md (11 findings), docs/audits/seo-audit-2026-05-12-round4.md (8 findings), docs/audits/seo-audit-2026-05-12-round5.md (9 findings)

## Summary
- Total findings: 7 (critical: 0, high: 0, medium: 1, low: 4, info: 2)
- Trajectory: 41 to 18 to 11 to 8 to 9 to 7. Down two from round 5 with no regressions and no new findings introduced.
- Top themes:
  - Round 5 ship work landed cleanly. The four service detail BreadcrumbList JSON-LD all start with Home as position 1. Three new OG endpoints under `src/pages/og/blog/` (`index.png.ts`, `articles.png.ts`, `case-studies.png.ts`) are wired into the matching blog list templates. /listener now emits both a WebApplication JSON-LD and a BreadcrumbList JSON-LD. 404 page passes `noIndex={true}` to Base.
  - SEO5-002 (service BreadcrumbList Home) and SEO5-007 (listener structured data) close in one round each, which is the right cadence for trivial scoped fixes.
  - Two long-running items continue without movement: case-studies content (now six rounds deep) and the text-neutral-700 accessibility classification pass (five rounds). Both noted as deferred work, not new findings.
  - Articles H1 voice (SEO4-006) remains closed per the prior commitment.
  - Tag page OG and 404 OG endpoint deferred halves of SEO5-004 and SEO5-005 still in place. Aesthetic finish only; not filing fresh.

## Round 5 fixes verified in code
- SEO5-002 resolved: all four service detail BreadcrumbList JSON-LD blocks now start with Home as position 1. `src/pages/services/web-management.astro:54`, `src/pages/services/marketing-strategy.astro:54`, `src/pages/services/implementation.astro:121`, and `src/pages/services/training.astro:115` each emit a three-step chain (Home, Services, specific service) with the same shape used by the blog routes. Rich Results test should report a consistent breadcrumb across the site without warnings.
- SEO5-005 partially resolved: three new OG endpoints ship under `src/pages/og/blog/`. `index.png.ts` renders the Blog card ("Articles and case studies from a working consultancy.", eyebrow Blog, kicker Cody Smith). `articles.png.ts` renders "I argue for a living." (eyebrow Articles). `case-studies.png.ts` renders "Jobs my lawyer cleared." (eyebrow Case studies). All three set `prerender = true` and `Cache-Control: public, max-age=31536000, immutable`. `src/pages/blog/index.astro:47-48`, `src/pages/blog/articles/index.astro:37-38`, and `src/pages/blog/case-studies/index.astro:37-38` now pass the matching `ogImage` and `ogImageAlt` to Base. The fourth template (`src/pages/blog/tags/[tag].astro`) intentionally stays on the default, consistent with the round 5 note that tag pages rarely act as shared targets.
- SEO5-004 partially resolved: `src/pages/404.astro:5` now passes `noIndex={true}` to Base, which emits the `<meta name="robots" content="noindex, nofollow">` belt-and-suspenders signal. The page still falls back to `/og-default.png`; that half of the finding was always optional and is left as deferred aesthetic work.
- SEO5-007 resolved: `src/pages/listener.astro:10-23` now emits a WebApplication JSON-LD with `name`, `url`, `description`, `applicationCategory: "BusinessApplication"`, `operatingSystem: "Any"`, `browserRequirements`, `isAccessibleForFree: true`, `offers: { price: 0, priceCurrency: "USD" }`, `provider`, and `creator` cross-referenced to the homepage Organization and the about Person nodes. A second block at `src/pages/listener.astro:24-31` emits a BreadcrumbList with Home and Sentiment Scanner. Rich Results test should pick up both.

## Findings

### [SEO6-001] Case studies collection still empty; index hero and blog hero still promise content that does not exist
**Severity**: medium
**Dimension**: 15 (Content quality), 6 (Internal linking), 8 (Sitemap), 19 (RSS)
**Files**: `src/content/case-studies/` (empty except `.gitkeep`), `src/pages/blog/case-studies/index.astro:52-58`, `src/pages/blog/index.astro:60-63`, `case-study-psychographic-personalization.md` (still at repo root)
**Observation**: Round 1 SEO-007, round 2 SEO2-001, round 3 SEO3-001, round 4 SEO4-002, round 5 SEO5-001 all unresolved. The `src/content/case-studies/` directory contains only `.gitkeep`. The case-studies RSS feed remains empty. The case-study slug route returns no static paths. The candidate file `case-study-psychographic-personalization.md` still sits unedited at the repo root. The blog-index hero at lines 60-63 still reads "Case studies on clients my lawyer cleared." The case-studies index hero at lines 52-58 still reads "Jobs my lawyer cleared. The rest is for the bar." with empty-state body copy promising future receipts. Filing for the sixth time because two of these promises live above the fold on routes that search engines and AI grounding crawlers will eventually score on alignment between promise and content. The new OG card for `/blog/case-studies` (round 5 ship work) doubles the visibility of the promise on social shares while the underlying content is still zero items.
**Recommendation**: Same three options as prior rounds. Move the candidate into `src/content/case-studies/` after legal review, ship a new greenlit case study, or rewrite the hero copy on both routes to drop the "case studies" promise. The OG card now in place on `/blog/case-studies` makes the third option more visible work than before because the social-share preview would need to match whatever the hero says.
**Effort**: medium (content) or trivial (copy edit)
**Verification**: Either `/blog/case-studies/{slug}` returns valid Article JSON-LD, or the hero copy on `/blog` and `/blog/case-studies` matches what the page actually contains, plus the OG card text on `/og/blog/case-studies.png` aligns with both.

### [SEO6-002] Person.sameAs and Organization sameAs still empty of external profiles
**Severity**: low
**Dimension**: 3 (Structured data), 18 (Schema validity), 17 (Entity disambiguation)
**Files**: `src/pages/about.astro:49`, `src/pages/index.astro:14-35`
**Observation**: Round 1 SEO-004, round 2 partial, round 5 SEO5-003 all unresolved. The Person node at about.astro:49 still carries `"sameAs": ["https://codyasmith.com"]`, a self-referencing array. The Organization node on the homepage `@graph` at index.astro:14-35 has no `sameAs` array at all. `sameAs` is the property Google documentation calls out for knowledge-panel disambiguation and the property AI grounding crawlers use to connect the entity to external profiles. Without external links the schema is technically valid but produces nothing Google, Claude, or Perplexity can cross-reference to confirm the entity exists outside this domain. Listed as outstanding deferred work in the round 6 prompt; filing again to keep the carry-over visible.
**Recommendation**: Three minimum candidates worth adding when accounts exist: LinkedIn profile URL, GitHub profile URL, and the AllenComm portfolio entry at https://allencomm.com/portfolio/spts-provides-suicide-prevention-training already linked in /about visible copy. Add to both Person.sameAs at about.astro:49 and Organization.sameAs at index.astro inside the Organization node around line 27. If only one profile is public, even one is better than zero for entity disambiguation. Blocked on Cody confirming which profile URLs to publish.
**Effort**: trivial (once URLs are confirmed)
**Verification**: Rich Results test on /about shows Person.sameAs with at least one external URL; Search Console knowledge-panel test on the Organization shows linked profiles.

### [SEO6-003] /blog/tags/{tag} still falls back to og-default.png; only blog list template without a per-page OG card
**Severity**: low
**Dimension**: 2 (Open Graph), 20 (OG images)
**Files**: `src/pages/blog/tags/[tag].astro:37-41`
**Observation**: Carry-over from SEO5-005. Three of the four blog list templates now ship per-page OG (`/og/blog/index.png`, `/og/blog/articles.png`, `/og/blog/case-studies.png`). The tag template at lines 37-41 passes `<Base title={...} description={...} breadcrumbs={breadcrumbs}>` with no `ogImage` prop, so Base.astro:45 resolves the missing prop to `/og-default.png`. Round 5 explicitly accepted tag pages as a deferred half on the grounds that tag URLs are not typically shared as targets, so this stays low priority. Filing as a single finding to keep the gap tracked rather than letting it disappear.
**Recommendation**: Add `src/pages/og/blog/tags/[tag].png.ts` that takes `params.tag`, looks up the human-readable label via `getAllTags`, and renders a "Tagged: {tagLabel}" OG card. Then pass `ogImage={`/og/blog/tags/${tagParam}.png`}` to Base on `[tag].astro:37-41`. Same renderOg call shape as the other three. Or accept the default permanently and document the decision.
**Effort**: small
**Verification**: LinkedIn Post Inspector on any `/blog/tags/{tag}` shows a tag-specific preview image; view-source confirms a unique `og:image` URL per tag.

### [SEO6-004] 404 page still falls back to og-default.png after round 5 noindex fix
**Severity**: low
**Dimension**: 2 (Open Graph), 20 (OG images)
**Files**: `src/pages/404.astro:5`
**Observation**: Carry-over from SEO5-004. The noindex half closed in round 5 (the higher-priority half). The OG endpoint half is still pending. 404.astro:5 passes `ogImage="/og-default.png"` explicitly now rather than relying on the fallback, which is cleaner code but still produces a misleading share preview if a stale 404 URL ever gets pasted into Slack or LinkedIn (the destination would show the home card while landing on a dead URL). Aesthetic improvement only.
**Recommendation**: Add `src/pages/og/404.png.ts` emitting a "Page not found" card with eyebrow "404", title "This page doesn't exist.", and subtitle pointing to the home or services route. Then change 404.astro:5 from `ogImage="/og-default.png"` to `ogImage="/og/404.png"`. Five minutes.
**Effort**: trivial
**Verification**: View-source on any 404 URL shows `og:image` referencing `/og/404.png`; LinkedIn Post Inspector shows a Page not found preview rather than the home card.

### [SEO6-005] Text-neutral-700 still used 86 times across 33 files; classification deferred again
**Severity**: low
**Dimension**: 14 (Accessibility)
**Files**: many; identical hit count and file list as rounds 3, 4, 5
**Observation**: Round 1 SEO-032, round 2 SEO2-012, round 3 SEO3-007, round 4 SEO4-005, round 5 SEO5-006 all unresolved. Same 86 hits across 33 files. #404040 on neutral-950 fails WCAG AA at every text size. Several are decorative chrome (Footer copyright divider middots, Nav personalization badge, blog breadcrumb separators, footnote markers, placeholder text on form inputs in contact and listener and portal-login) but several are meaningful copy crossing into assistive-tech territory: the count badges next to tag chips on `/blog` and case-study sectors, the "Updated" timestamp on article detail meta strips, the SVG arrow text on home service cards, and the right-column count badges on `/blog/articles` and `/blog/tags/{tag}`. Filing for the sixth time without movement because the classification work is one focused afternoon and unblocks Lighthouse improvements visible to anyone running a third-party accessibility audit on the public site.
**Recommendation**: Same as round 5. Single inventory pass on the 33 files. Decorative middots and dividers stay at neutral-700 with `aria-hidden="true"` added. Meaningful counters and timestamps lift to neutral-500 or above. Document the rule in CLAUDE.md so the next contributor does not regress.
**Effort**: small (audit) or medium (full pass)
**Verification**: Lighthouse Accessibility reports zero contrast failures on homepage, services, contact, listener gate, and a blog detail page; CLAUDE.md carries the rule.

### [SEO6-006] No sitemap or RSS post-build assertion still in place
**Severity**: info
**Dimension**: 8 (Sitemap), 19 (RSS)
**Files**: `astro.config.mjs`, `scripts/postbuild-security-headers.mjs`, `package.json:10`
**Observation**: Round 2 SEO2-014, round 3 SEO3-009, round 4 SEO4-007, round 5 SEO5-008 unresolved. The build chain at `package.json:10` runs `astro build && node scripts/postbuild-security-headers.mjs`. The postbuild script wraps the entry handler with security headers but performs no assertion on the sitemap or RSS artifacts. A regression in `site`, `trailingSlash`, or the sitemap and RSS integrations would ship a broken artifact silently and Search Console would notice before the team did.
**Recommendation**: Same as prior rounds. Add `scripts/postbuild-assert-sitemap-rss.mjs` opening `dist/sitemap-index.xml`, asserting the homepage, /services, /blog, and at least one blog detail URL appear, then opening each RSS XML and asserting `<link>` values are absolute URLs starting with `https://codyasmith.com`. Chain after the headers script. Exit nonzero on failure.
**Effort**: trivial
**Verification**: `npm run build` fails when sitemap or RSS is malformed; passes when complete.

### [SEO6-007] CSP image-src constraint still undocumented in CLAUDE.md
**Severity**: info
**Dimension**: 16 (Tracking), 11 (Performance), 15 (Content quality)
**Files**: `security-headers.json:5`, `src/middleware.ts`, `CLAUDE.md`
**Observation**: Round 2 SEO2-018, round 3 SEO3-010, round 4 SEO4-008, round 5 SEO5-009 unresolved. CSP is centralized in `security-headers.json:5` with `img-src 'self' data: blob:`. CLAUDE.md still carries no note about the constraint (grep for `img-src`, `public/images/blog`, and `CSP` returns no matches in CLAUDE.md). A future content author who references an external image URL in an article or case-study MDX will see the image silently blocked in the browser with the only signal being a console CSP violation. The rule was correctly enforced for current content (every cover under `public/images/blog/*`) but the enforcement is invisible to authors.
**Recommendation**: Same one-line addition under content-authoring conventions in CLAUDE.md: "All blog images must be uploaded to `public/images/blog/{slug}/`; external image URLs will be blocked by the site CSP (`img-src 'self' data: blob:`)." Applies to MDX Figure and Gallery entries as well.
**Effort**: trivial
**Verification**: A future MDX file referencing an external image URL fails to render in the browser with a CSP violation visible in the console; CLAUDE.md note prevents the mistake at authoring time.

## Strengths confirmed since round 5
- All four service detail BreadcrumbList JSON-LD now start with Home as position 1, matching the shape used on every blog route. Rich Results test should report a consistent three-step chain on `/services/web-management`, `/services/marketing-strategy`, `/services/implementation`, and `/services/training`.
- Three new OG endpoints under `src/pages/og/blog/` cover the three primary blog list routes. Each emits a 1200x630 PNG via the satori plus Resvg pipeline with title, eyebrow, kicker, subtitle, immutable Cache-Control, and `prerender: true`.
- `/listener` emits a complete WebApplication JSON-LD with the free-offer signal Google parses for the SoftwareApplication rich result, plus a BreadcrumbList. The free `offers: { price: 0, priceCurrency: "USD" }` is exactly the language that surfaces the "Free" badge on rich results.
- 404 page emits `<meta name="robots" content="noindex, nofollow">` via the `noIndex={true}` prop. Search Console URL Inspection should now report "Excluded by noindex" rather than relying on the HTTP 404 alone.
- Zero stray `</invoke>` literals anywhere in `src/` (SEO4-001 staying closed since round 5).
- Ten top-level per-page OG endpoints under `src/pages/og/` (services, four service children, about, contact, listener, work, privacy) plus three new blog list endpoints. Thirteen total non-default OG endpoints in place.
- Security headers centralized in `security-headers.json` so SSR middleware and the postbuild wrapper share one source of truth.
- Person schema on /about accurately models the five visible awards in the Credentials section.
- All four service detail pages emit Service plus FAQPage plus BreadcrumbList JSON-LD with consistent provider @id reference back to the homepage Organization node, and all four ship `termsOfService`.
- Article JSON-LD pipeline complete and centralized in BlogPost.astro.
- Homepage @graph (Organization plus ProfessionalService plus WebSite) cross-references via @id.
- Base.astro emits a complete Open Graph plus Twitter Card set with image dimensions, image alt, article meta, site name, locale, and canonical.
- middleware.ts emits X-Robots-Tag: noindex, nofollow on every response under /portal.
- astro.config.mjs sets `trailingSlash: 'never'` and the sitemap filter excludes portal, api, PNG endpoints, and naming-preview.
- Fonts loaded via preload-as-style plus media-print swap with noscript fallback.
- Cover images on blog detail pages use loading="lazy", decoding="async", and width/height when frontmatter provides them.
- Persona variant H1s collapse to one DOM `<h1>` per page via `<div role="heading" aria-level="1">` wrappers; aria-hidden toggled correctly via swapAxis.
- Skip-to-content link with strong focus contrast at the top of Base.astro.
- viewport, lang, charset, theme-color, manifest, favicon variants, and apple-touch-icon all present.
- No third-party tracking scripts, consistent with the privacy policy.
- Astro view transitions wired so SPA-style nav re-initializes accessibility and personalization through astro:after-swap hooks.
- robots.txt explicitly disallows /portal/, /api/, and /naming-preview under each named AI-bot record group.

## Regressions
None observed.
