# SEO audit 2026-05-12, Round 5

Branch: seo-security-improvements
Scope: public-facing pages and supporting code only. Portal admin out of scope.
Auditor: Claude Code (Opus 4.7, 1M context) sub-agent
Prior rounds: docs/audits/seo-audit-2026-05-12.md (41 findings), docs/audits/seo-audit-2026-05-12-round2.md (18 findings), docs/audits/seo-audit-2026-05-12-round3.md (11 findings), docs/audits/seo-audit-2026-05-12-round4.md (8 findings)

## Summary
- Total findings: 9 (critical: 0, high: 0, medium: 2, low: 5, info: 2)
- Top themes:
  - Three new findings surface on the surface that round 4 covered: 404 page is the last public route still without ogImage and also lacks a noindex meta tag; service-detail BreadcrumbList JSON-LD omits the Home root that every blog route includes; Person/Organization sameAs arrays still only self-reference. None are emergencies; together they describe the residual finish work after the round 4 OG pass landed.
  - Case studies collection (SEO4-002) and text-neutral-700 inventory (SEO4-005) are again unresolved. Both are now four rounds deep.
  - Articles H1 (SEO4-006) is closed per the prior commitment: deferred and no longer filed.
  - Postbuild sitemap/RSS assertion (SEO4-007) and the CLAUDE.md note about the img-src CSP constraint (SEO4-008) remain pending. Both stay info severity.

## Round 4 fixes verified in code
- SEO4-001 resolved: `grep -r '</invoke>' src/` returns zero matches. The four blog list templates close cleanly. `src/pages/blog/index.astro` ends at line 190 with `</Base>`. `src/pages/blog/articles/index.astro` ends at line 159 after the closing `</script>` block. `src/pages/blog/case-studies/index.astro` ends at line 165 after the closing `</script>` block. `src/pages/blog/tags/[tag].astro` ends at line 93 with `</Base>`. No literal text nodes after the layout close.
- SEO4-003 resolved: ten per-page OG endpoints ship under `src/pages/og/`. Top level: `og/about.png.ts`, `og/contact.png.ts`, `og/listener.png.ts`, `og/privacy.png.ts`, `og/services.png.ts`, `og/work.png.ts`. Services children: `og/services/web-management.png.ts`, `og/services/marketing-strategy.png.ts`, `og/services/implementation.png.ts`, `og/services/training.png.ts`. Every endpoint sets `export const prerender = true`, declares Cache-Control `public, max-age=31536000, immutable`, and calls `renderOg` with distinct title, eyebrow, kicker, and subtitle. Each `.astro` page passes the matching `ogImage` and `ogImageAlt` to Base (about.astro:5, contact.astro:5, listener.astro:9, privacy.astro:5, services.astro:5, work.astro:5, services/web-management.astro:52, services/marketing-strategy.astro:52, services/implementation.astro:118, services/training.astro:112). Base.astro:45 still falls back to `/og-default.png` (correct).
- SEO4-004 resolved: all four service Service JSON-LD blocks now ship `termsOfService`. Web Management at services/web-management.astro:64: "Month-to-month after onboarding. No lock-in. Full backup and 30 days to migrate elsewhere on exit." Marketing Strategy at services/marketing-strategy.astro:64: "Month-to-month after the initial audit. No annual contracts." Implementation at services/implementation.astro:68: "Fixed-price quotes against a written scope document. Payment at signing. Change orders quoted separately before execution. Production deployment with handoff documentation." Training at services/training.astro:68: "Three-session guided programs delivered remotely. Assignments between sessions. Reference materials delivered at the end. Single sessions and ongoing advisory retainers available." All four fit comfortably under 200 chars and stay consistent in voice.

## Findings

### [SEO5-001] Case studies collection still empty; index hero and blog hero still promise content that does not exist
**Severity**: medium
**Dimension**: 15 (Content quality), 6 (Internal linking), 8 (Sitemap), 19 (RSS)
**Files**: `src/content/case-studies/` (empty), `src/pages/blog/case-studies/index.astro:86-90`, `src/pages/blog/index.astro:60-62`, `case-study-psychographic-personalization.md` (still at repo root)
**Observation**: Round 1 SEO-007, round 2 SEO2-001, round 3 SEO3-001, round 4 SEO4-002 all unresolved. The `src/content/case-studies/` directory is still empty. Build emits the content warning `No files found matching "**/*.{md,mdx}" in directory "src\content\case-studies"`. The case-studies RSS feed contains no items. `getStaticPaths` for the case-study slug route returns nothing. The candidate file `case-study-psychographic-personalization.md` still sits at the repo root unedited since April. The blog-index hero at lines 60-62 still reads "Case studies on clients my lawyer cleared." The case-studies index hero at lines 50-52 still reads "Jobs my lawyer cleared. The rest is for the bar." with an empty-state body promising future receipts. Filing again because two of these promises live above the fold on routes search engines and AI grounding crawlers will eventually score on alignment between promise and content.
**Recommendation**: Same three options as round 4. Move the candidate into `src/content/case-studies/` after legal review, ship a new greenlit case study, or rewrite the hero copy on both routes to drop the "case studies" promise. The longer the hero copy outruns the content, the more downstream re-ranking penalties accumulate.
**Effort**: medium (content) or trivial (copy edit)
**Verification**: Either `/blog/case-studies/{slug}` returns valid Article JSON-LD, or the hero copy on `/blog` and `/blog/case-studies` matches what the page actually contains.

### [SEO5-002] Service detail BreadcrumbList JSON-LD omits the Home root that every blog route includes
**Severity**: medium
**Dimension**: 3 (Structured data), 18 (Schema validity), 6 (Internal linking)
**Files**: `src/pages/services/web-management.astro:54`, `src/pages/services/marketing-strategy.astro:54`, `src/pages/services/implementation.astro:121`, `src/pages/services/training.astro:115`
**Observation**: NEW in round 5. All four service detail pages emit a BreadcrumbList JSON-LD with two items: Services then the specific service. The blog routes (`src/pages/blog/index.astro:18-21`, `src/pages/blog/articles/index.astro:16-20`, `src/pages/blog/case-studies/index.astro:16-20`, `src/pages/blog/tags/[tag].astro:19-23`, plus the BlogPost layout for detail pages) all start with Home as position 1. The service detail breadcrumbs jumping straight to position 1 Services breaks the rich-result trail Google parses for the breadcrumb chip in SERP, and the structural mismatch between two breadcrumb shapes on the same site is the kind of inconsistency Google's Rich Results test reports as a warning. Not a hard error, but the service detail pages are exactly the routes you most want the breadcrumb chip on because they sit two clicks from the homepage and the chip closes the loop visually in search.
**Recommendation**: Prepend `{"@type":"ListItem","position":1,"name":"Home","item":"https://codyasmith.com/"}` to each of the four service detail BreadcrumbList blocks and bump the existing positions by one. Same shape and same root used everywhere else on the site. Five minutes total.
**Effort**: trivial
**Verification**: Rich Results test on each service detail URL reports a three-step breadcrumb (Home, Services, specific service) with no warnings; SERP rendering of the chip matches the blog-route shape.

### [SEO5-003] Person.sameAs and Organization sameAs still empty of external profiles
**Severity**: low
**Dimension**: 3 (Structured data), 18 (Schema validity), 17 (Entity disambiguation)
**Files**: `src/pages/about.astro:49`, `src/pages/index.astro:15-35`
**Observation**: Round 1 SEO-004 partially resolved in round 2 (added worksFor, alumniOf, award, knowsAbout) but `sameAs` was never expanded beyond the self-referential `["https://codyasmith.com"]`. The Organization node on the homepage `@graph` (`src/pages/index.astro:15-35`) has no `sameAs` array at all. `sameAs` is the property Google's documentation explicitly calls out for knowledge-panel disambiguation and AI grounding crawlers use it to connect the entity to external profiles. Without external links the schema is technically valid but produces nothing Google or Claude or Perplexity can cross-reference to confirm the entity exists outside this domain.
**Recommendation**: Three minimum candidates worth adding when accounts exist: LinkedIn profile URL, GitHub profile URL, and the AllenComm portfolio entry at https://allencomm.com/portfolio/spts-provides-suicide-prevention-training (already linked in /about visible copy). Add to both Person.sameAs at about.astro:49 and Organization.sameAs at index.astro inside the Organization node around line 27. If only one profile is public, even one is better than zero for entity disambiguation.
**Effort**: trivial (once URLs are confirmed)
**Verification**: Rich Results test on /about shows Person.sameAs with at least one external URL; Search Console knowledge-panel test on the Organization shows linked profiles.

### [SEO5-004] 404 page still falls back to og-default.png and ships no robots meta
**Severity**: low
**Dimension**: 2 (Open Graph), 7 (Crawl directives), 20 (OG images)
**Files**: `src/pages/404.astro:5`
**Observation**: NEW in round 5. `src/pages/404.astro:5` is the only public route still passing no `ogImage`, no `ogImageAlt`, and no `noIndex={true}` to Base. The Astro node adapter serves the 404 page with HTTP 404, which by itself is enough to prevent indexing for most crawlers, but the page emits no `<meta name="robots" content="noindex, nofollow">` belt-and-suspenders and no per-page OG. Two small issues that compound when the 404 ever gets accidentally shared (most often when a stale tweet or doc link rots and someone pastes it into Slack): the share preview pulls the default site card, which is misleading because the destination is a dead URL, and any crawler that hits the page through a 200 redirect chain or via the SSR adapter under cold-start conditions has no robots signal to fall back on.
**Recommendation**: Pass `noIndex={true}` to Base on 404.astro:5. Optional: add an `ogImage="/og/404.png"` referencing a new `src/pages/og/404.png.ts` that emits a "Page not found" card. The noindex meta is the higher-priority half of this finding; the OG endpoint is an aesthetic improvement only.
**Effort**: trivial
**Verification**: View-source on any 404 URL shows `<meta name="robots" content="noindex, nofollow">`; Search Console's URL Inspection reports "Excluded by noindex" rather than "Not found (404)".

### [SEO5-005] Blog list pages (`/blog`, `/blog/articles`, `/blog/case-studies`, `/blog/tags/[tag]`) all fall back to og-default.png
**Severity**: low
**Dimension**: 2 (Open Graph), 20 (OG images)
**Files**: `src/pages/blog/index.astro:44-48`, `src/pages/blog/articles/index.astro:34-38`, `src/pages/blog/case-studies/index.astro:34-38`, `src/pages/blog/tags/[tag].astro:37-41`
**Observation**: NEW in round 5, surfaced by SEO4-003's per-page OG pass on non-blog routes. All four blog list templates pass `<Base title={...} description={...} breadcrumbs={breadcrumbs}>` with no `ogImage` prop. Base.astro:45 resolves the missing prop to `/og-default.png`. The blog detail pages have their own per-slug OG via `src/pages/blog/og/articles/[slug].png.ts` and `src/pages/blog/og/case-studies/[slug].png.ts`, but the four list-and-tag landing pages share the generic homepage card. Lower priority than the detail OGs already in place, but inconsistent with the round 4 pattern that established a per-page OG for every other top-level public route.
**Recommendation**: Add four small OG endpoints under `src/pages/og/blog/`: `index.png.ts`, `articles.png.ts`, `case-studies.png.ts`. Tag landing pages can either reuse a generic "Tagged: {tagLabel}" template via a `[tag].png.ts` dynamic endpoint or stay on the default since tag pages typically aren't shared targets. Then pass `ogImage` to Base on each of the four `.astro` files. Mirror the existing top-level shape exactly.
**Effort**: small
**Verification**: LinkedIn Post Inspector on `/blog`, `/blog/articles`, `/blog/case-studies` each shows a distinct preview image; view-source confirms unique `og:image` URLs per page.

### [SEO5-006] Text-neutral-700 still used 86 times across 33 files; classification deferred again
**Severity**: low
**Dimension**: 14 (Accessibility)
**Files**: many; identical hit count and file list as rounds 3 and 4
**Observation**: Round 1 SEO-032, round 2 SEO2-012, round 3 SEO3-007, round 4 SEO4-005 all unresolved. Same 86 hits across 33 files. #404040 on neutral-950 fails WCAG AA at every text size. Several are decorative chrome (Footer copyright/divider middots, Nav personalization badge, blog breadcrumb separators, footnote markers, placeholder text on form inputs in contact and listener and portal-login), but several are meaningful copy crossing into assistive-tech territory: the count badges next to tag chips on `/blog` and case-study sectors, the "Updated" timestamp on article detail meta strips, the SVG arrow text on home service cards, and the right column "{count}" badges on `/blog/articles` and `/blog/tags/{tag}`. Filing for the fifth time without movement because the classification work is one focused afternoon and unblocks Lighthouse improvements visible to anyone running a third-party accessibility audit on the public site.
**Recommendation**: Same as round 4. Single inventory pass on the 33 files. Decorative middots and dividers stay at neutral-700 with `aria-hidden="true"` added. Meaningful counters and timestamps lift to neutral-500 or above. Document the rule in CLAUDE.md so the next contributor does not regress.
**Effort**: small (audit) / medium (full pass)
**Verification**: Lighthouse Accessibility reports zero contrast failures on homepage, services, contact, listener gate, and a blog detail page; CLAUDE.md carries the rule.

### [SEO5-007] /listener emits no structured data despite being a tool/lead-magnet route
**Severity**: low
**Dimension**: 3 (Structured data), 18 (Schema validity)
**Files**: `src/pages/listener.astro:9`
**Observation**: NEW in round 5. The Sentiment Scanner at `/listener` ships a Base layout with title, description, ogImage, and an article-meta strip in visible copy, but no JSON-LD. This is the highest-volume single-page lead-magnet on the site, the page most likely to be linked from external sources (X, LinkedIn, AI assistant answers about "free brand sentiment tool"), and the only public route that emits no schema entity. A small `WebApplication` or `SoftwareApplication` block with `name`, `description`, `applicationCategory: "BusinessApplication"`, `operatingSystem: "Any"`, `offers: { price: 0, priceCurrency: "USD" }`, and `url` would make the page eligible for the SoftwareApplication rich result and give AI grounding crawlers a clear entity hook. Optional: a FAQPage block answering the questions the gate flow already implies (How does it work? Is it free? What sources does it pull from?).
**Recommendation**: Add a single `WebApplication` JSON-LD block at the top of `/listener` mirroring the shape used on the four service pages. The free offer is the differentiator and modeling it as `offers: { "@type": "Offer", price: 0, priceCurrency: "USD" }` is exactly the language Google parses to surface the "Free" badge on rich results.
**Effort**: trivial
**Verification**: Rich Results test on `/listener` shows valid WebApplication or SoftwareApplication entity; Search Console's URL Inspection picks up the entity within a week of next crawl.

### [SEO5-008] No sitemap or RSS post-build assertion still in place
**Severity**: info
**Dimension**: 8 (Sitemap), 19 (RSS)
**Files**: `astro.config.mjs:17-26`, `scripts/postbuild-security-headers.mjs`, `package.json:10`
**Observation**: Round 2 SEO2-014, round 3 SEO3-009, round 4 SEO4-007 unresolved. The build chain at `package.json:10` runs `astro build && node scripts/postbuild-security-headers.mjs`. The postbuild script wraps the entry handler with security headers but performs no assertion on the sitemap or RSS artifacts. The previous finding's RSS absolute-URL check (round 3 SEO3-006) also remains pending. A regression in `site`, `trailingSlash`, or the sitemap/rss integrations would ship a broken artifact silently and Search Console would notice before the team did.
**Recommendation**: Same as prior rounds. Add `scripts/postbuild-assert-sitemap-rss.mjs` opening `dist/sitemap-index.xml`, asserting the homepage, /services, /blog, and at least one blog detail URL appear, then opening each RSS XML and asserting `<link>` values are absolute URLs starting with `https://codyasmith.com`. Chain after the headers script. Exit nonzero on failure.
**Effort**: trivial
**Verification**: `npm run build` fails when sitemap or RSS is malformed; passes when complete.

### [SEO5-009] CSP image-src constraint still undocumented in CLAUDE.md
**Severity**: info
**Dimension**: 16 (Tracking), 11 (Performance), 15 (Content quality)
**Files**: `security-headers.json:5`, `src/middleware.ts:50`, `CLAUDE.md`
**Observation**: Round 2 SEO2-018, round 3 SEO3-010, round 4 SEO4-008 unresolved. CSP is now centralized in `security-headers.json:5` (good change since round 4) with `img-src 'self' data: blob:`. CLAUDE.md still carries no note about the constraint. A future content author who references an external image URL in an article or case-study MDX will see the image silently blocked in the browser with the only signal being a console CSP violation. The rule was correctly enforced for current content (every cover under `public/images/blog/*`) but the enforcement is invisible to authors.
**Recommendation**: Same one-line addition under content-authoring conventions in CLAUDE.md: "All blog images must be uploaded to `public/images/blog/{slug}/`; external image URLs will be blocked by the site CSP (`img-src 'self' data: blob:`)." Applies to MDX Figure/Gallery entries as well.
**Effort**: trivial
**Verification**: A future MDX file referencing an external image URL fails to render in the browser with a CSP violation visible in the console; CLAUDE.md note prevents the mistake at authoring time.

## Strengths confirmed since round 4
- Zero stray `</invoke>` literals anywhere in src/.
- Ten per-page OG endpoints under `src/pages/og/` covering services, all four service children, about, contact, listener, work, and privacy. Each emits a 1200x630 PNG via the satori plus Resvg pipeline with title, eyebrow, kicker, subtitle, immutable Cache-Control, and `prerender: true`.
- All four service Service JSON-LD blocks ship `termsOfService` aligned in voice and under 200 chars.
- Security headers centralized in `security-headers.json` so SSR middleware and the postbuild wrapper share one source of truth. Both consume from the same JSON.
- Person schema on /about accurately models the five visible awards in the Credentials section.
- All four service detail pages emit FAQPage JSON-LD with rendered `<details>` accordion text matching the schema text.
- Article JSON-LD pipeline complete and centralized in BlogPost.astro.
- Homepage @graph (Organization plus ProfessionalService plus WebSite) cross-references via @id.
- BreadcrumbList JSON-LD ships on every blog category and detail page through the Base layout prop.
- ItemList JSON-LD ships on blog index, articles index, case-studies index, and tag pages.
- Base.astro emits a complete Open Graph plus Twitter Card set with image dimensions, image alt, article meta (published, modified, author, section, tag), site name, locale, and canonical.
- middleware.ts emits X-Robots-Tag: noindex, nofollow on every response under /portal.
- astro.config.mjs sets `trailingSlash: 'never'` and the sitemap filter excludes portal, api, PNG endpoints, and naming-preview.
- Fonts loaded via preload-as-style plus media-print swap with noscript fallback on Base.astro and /portal/login.
- Cover images on blog detail pages use loading="lazy", decoding="async", and width/height when frontmatter provides them.
- Persona variant H1s collapse to one DOM `<h1>` per page via `<div role="heading" aria-level="1">` wrappers; aria-hidden toggled correctly via swapAxis.
- Skip-to-content link with strong focus contrast at the top of Base.astro.
- viewport, lang, charset, theme-color, manifest, favicon variants, and apple-touch-icon all present.
- No third-party tracking scripts (no GA, no Microsoft Clarity, no Meta pixel), consistent with the privacy policy.
- Astro view transitions wired so SPA-style nav re-initializes accessibility and personalization through astro:after-swap hooks.
- Privacy page accurately describes bcrypt password flow with magic-link onboarding and SHA-256 session hashing; cookie disclosure carries SameSite=strict and 90-day max language landing from the security round 4 work.
- robots.txt explicitly disallows /portal/, /api/, and /naming-preview under each named AI-bot record group.
- All four service detail pages emit Service plus FAQPage plus BreadcrumbList JSON-LD with consistent provider @id reference back to the homepage Organization node.
