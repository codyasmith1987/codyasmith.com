# SEO audit 2026-05-12, Round 2

Branch: seo-security-improvements
Scope: public-facing pages and supporting code only. Portal admin out of scope.
Auditor: Claude Code (Opus 4.7, 1M context) sub-agent
Prior round: docs/audits/seo-audit-2026-05-12.md (41 findings)

## Summary
- Total findings: 18 (critical: 0, high: 2, medium: 6, low: 6, info: 4)
- Top themes:
  - Case studies collection still empty, so the case-study index, RSS, ItemList schema, and homepage receipt block all ship with no content rows or no entries at all
  - FAQ schema still only on /services/web-management; the other three service detail pages still ship without FAQ accordions or schema
  - Implementation and Training still publish concrete dollar rates without `Service` + `Offer` JSON-LD
  - Web Management and Marketing Strategy pages still carry a "Magic-link sign-in (no passwords to leak)" line that contradicts the password-based portal login
  - Top-level pages (services index, about, work, contact, listener, privacy, 404) still fall back to `og-default.png` with no per-page OG variant
  - Body image components Figure.astro and Gallery.astro still render `<img>` without width/height attributes, so any image in an MDX article will cause CLS
  - Portal login page still loads Google Fonts as a render-blocking stylesheet without the preload + media swap pattern used elsewhere
  - Several text-neutral-500/600/700 color usages on dark backgrounds remain widely deployed and were not audited per SEO-032

## Round 1 fixes verified in code
- First-round SEO-001 resolved: BlogPost.astro emits Article JSON-LD with headline, datePublished, dateModified, image, author, publisher, mainEntityOfPage, articleSection, and keywords (`src/layouts/BlogPost.astro:62-88`).
- First-round SEO-002 resolved: BlogPost.astro builds a four-level BreadcrumbList and passes it to Base; the blog index, articles index, case-studies index, and tags pages each emit their own BreadcrumbList JSON-LD through Base (`src/layouts/BlogPost.astro:45-50`, `src/pages/blog/index.astro:18-21`, `src/pages/blog/articles/index.astro:16-20`, `src/pages/blog/case-studies/index.astro:16-20`, `src/pages/blog/tags/[tag].astro:19-23`).
- First-round SEO-003 resolved: Homepage now ships a `@graph` with Organization, ProfessionalService, and WebSite nodes, cross-linked by `@id` references (`src/pages/index.astro:12-64`).
- First-round SEO-004 resolved: Person schema on /about now includes worksFor, alumniOf, award array, knowsAbout, and sameAs (`src/pages/about.astro:6-48`).
- First-round SEO-005 resolved: `author` field added to `baseFields` with `z.string().default('Cody Smith')` (`src/content.config.ts:12`).
- First-round SEO-006 resolved: Every article frontmatter now carries non-empty tags (`src/content/articles/ai-outdated-information-business.md:8`, `ghost-work.md:6`, `rainier-the-mountain-we-called-home.md:6`, `standing-rock-its-not-over-yet.md:6`, `to-my-brother.md:6`).
- First-round SEO-009 resolved: ItemList JSON-LD emitted on blog index, articles index, case-studies index, and tag pages.
- First-round SEO-012 resolved: middleware sets `X-Robots-Tag: noindex, nofollow` on every response under `/portal` (`src/middleware.ts:39-41`).
- First-round SEO-013 resolved: robots.txt now disallows `/api/` and `/naming-preview` in addition to `/portal/` (`public/robots.txt:4-5`).
- First-round SEO-014 partially addressed: naming-preview.astro now passes `noIndex={true}` and `prerender = false`, robots disallows it, sitemap filter excludes it. NEW issue: still a public route reachable by URL guess; see SEO2-007 below.
- First-round SEO-015 resolved: sitemap filter excludes `/portal/`, `/api/`, `.png` endpoints, and `/naming-preview` (`astro.config.mjs:21-25`).
- First-round SEO-016 resolved: Base.astro now uses preload-as-style + media print swap pattern with a noscript fallback (`src/layouts/Base.astro:116-129`).
- First-round SEO-017 resolved: listener.astro removed `prerender = false` and the unused `recentScans` import. The page now builds static (`src/pages/listener.astro:1-7`).
- First-round SEO-018 resolved on the cover image: both blog detail templates use `loading="lazy"`, `decoding="async"`, and pass through `width`/`height` from frontmatter (`src/pages/blog/articles/[slug].astro:94-102`, `src/pages/blog/case-studies/[slug].astro:135-143`).
- First-round SEO-019 resolved: `cover.width` and `cover.height` are now optional integer fields on the content schema (`src/content.config.ts:21-22`).
- First-round SEO-021 partially addressed: tag chips on `/blog/articles` now render as `<a href="/blog/tags/...">` with click-preventDefault filter behavior, and min-h-[44px] for tap targets (`src/pages/blog/articles/index.astro:74-80`). NEW issue: sector chips on `/blog/case-studies` were not converted (still buttons), per SEO2-002.
- First-round SEO-024 resolved: Base.astro emits `og:image:alt` and `twitter:image:alt` from a resolved fallback (`src/layouts/Base.astro:46-47`, `:85`, `:104`).
- First-round SEO-025 resolved: Base.astro emits `article:published_time`, `article:modified_time`, `article:author`, `article:section`, and one `article:tag` per tag when `ogType === 'article'` (`src/layouts/Base.astro:87-97`). BlogPost.astro passes the meta through (`src/layouts/BlogPost.astro:97-103`).
- First-round SEO-027 resolved: `trailingSlash: 'never'` set in astro.config.mjs (`astro.config.mjs:14`).
- First-round SEO-033 partially addressed: tag chips on `/blog/articles` use `min-h-[44px] px-3 py-2.5` (`src/pages/blog/articles/index.astro:72`, `:78`). Sector chips on `/blog/case-studies` still use `px-3 py-1.5` and lack `min-h-[44px]` (`src/pages/blog/case-studies/index.astro:67`, `:73`). Mobile nav button retains `p-2 -mr-2`. See SEO2-008.

## Findings

### [SEO2-001] Case studies collection is still empty
**Severity**: high
**Dimension**: 15 (Content quality), 6 (Internal linking), 8 (Sitemap), 19 (RSS)
**Files**: `src/content/case-studies/` (empty), `src/pages/blog/case-studies/index.astro:88-91`, `src/pages/blog/index.astro:75-112`, `src/pages/blog/case-studies/rss.xml.ts:13`
**Observation**: First-round SEO-007 not addressed. The case-studies collection has no entries. The case-studies index renders empty-state copy, `getStaticPaths` for `[slug].astro` returns nothing, the homepage `latestCase` block hides entirely, the `otherCases` grid hides, and the case-studies RSS feed contains no items. The site advertises case studies in the homepage CTA, the blog hero, the nav, and the sector filter, but there is nothing crawlable. The candidate file `case-study-psychographic-personalization.md` still sits at the repo root, not inside `src/content/case-studies/`, so it ships nowhere.
**Recommendation**: Either move the candidate file into `src/content/case-studies/` (and clear it through review), publish at least one greenlit case study, or remove the "Latest receipt" and "Other receipts" sections from `/blog/index.astro` plus the sector filter on `/blog/case-studies/index.astro` until content lands.
**Effort**: medium (content) or small (template guard)
**Verification**: Either `/blog/case-studies/[slug]` resolves with valid Article JSON-LD, or the case-study sections cease to appear on the blog index and the case-studies hero rewrites to match.

### [SEO2-002] FAQ schema only on /services/web-management; three service pages still ship without it
**Severity**: high
**Dimension**: 3 (Structured data)
**Files**: `src/pages/services/marketing-strategy.astro`, `src/pages/services/implementation.astro`, `src/pages/services/training.astro`
**Observation**: First-round SEO-008 not addressed. `web-management.astro:4-49` defines a `FAQPage` block and renders matching `<details>` accordions in `:298-348`. The other three service detail pages still have neither FAQ JSON-LD nor visible FAQ accordions. The audit spec calls for FAQ presence on each services subpage.
**Recommendation**: For each of the three pages, draft 4 to 6 honest FAQs (scope, pricing model, deliverables, exit terms), add `<details>` accordions, and emit matching `FAQPage` JSON-LD. Mirror the pattern in `web-management.astro`. Only emit schema for questions visible on the page.
**Effort**: medium
**Verification**: Each page produces valid FAQPage schema with `mainEntity` array; the visible accordion text matches the schema text exactly.

### [SEO2-003] Implementation and Training rate cards still not modeled as Offer or PriceSpecification
**Severity**: medium
**Dimension**: 3 (Structured data)
**Files**: `src/pages/services/implementation.astro:236-252`, `src/pages/services/training.astro:236-289`
**Observation**: First-round SEO-010 not addressed. Implementation shows "$125/hr implementation, $150/hr advisory" plus rush and emergency multipliers. Training shows "$250", "$200", "$200", "$100/hr" line items. Neither page emits `Service` JSON-LD with `offers.PriceSpecification`. Google cannot associate the visible prices with the service entity.
**Recommendation**: Add a `Service` JSON-LD block per page with `provider` set to the homepage `Organization` `@id`, `serviceType`, and an `offers` array of `Offer` with `priceSpecification` per line item (currency, price, unitText). For Training, model each session as one Offer with `eligibleQuantity` or `unitText` to match the visible label. For Implementation, model the two hourly rates with `unitText: 'HOUR'`. If pricing is still considered preliminary, remove the public numbers instead.
**Effort**: small
**Verification**: Rich Results test accepts the Service entity; the rendered price strings match the schema price values exactly.

### [SEO2-004] Body-image components Figure.astro and Gallery.astro emit img without width or height
**Severity**: medium
**Dimension**: 5 (Image accessibility), 11 (Performance), 12 (Mobile)
**Files**: `src/components/blog/Figure.astro:13-20`, `src/components/blog/Gallery.astro:19-27`
**Observation**: First-round SEO-020 not addressed. Both components render `<img>` with `loading="lazy"` and `decoding="async"` (good), but neither accepts or renders `width` or `height` attributes. Any MDX article that imports `Figure` or `Gallery` and ships even one body image will cause CLS as the image loads. The current articles do not yet use these components, but the components are exported through `src/components/blog/index.ts` and will be reached as soon as a new MDX entry lands.
**Recommendation**: Add `width?: number` and `height?: number` to the Props interface on each component. Render them on `<img>` so the browser reserves layout space. Even better: migrate the components to Astro's `<Image>` from `astro:assets`, which infers dimensions at build time when given a local import. Keep `loading="lazy"` and `decoding="async"`.
**Effort**: small
**Verification**: A test MDX article that imports `Figure` with a `width`/`height` pair renders the attributes in the DOM; Lighthouse "Image elements have explicit width and height" passes for that page.

### [SEO2-005] Web-management and marketing-strategy still claim "Magic-link sign-in (no passwords to leak)" while portal uses passwords
**Severity**: medium
**Dimension**: 15 (Content quality), 16 (Tracking and accuracy of public content)
**Files**: `src/pages/services/web-management.astro:260`, `src/pages/services/marketing-strategy.astro:258`, `src/pages/portal/login.astro:53-69`, `src/lib/auth.ts:90-129`
**Observation**: First-round SEO-035 partially addressed. The privacy page was updated to describe password-based authentication backed by bcrypt with magic-link onboarding only (`src/pages/privacy.astro:36`), which is accurate. The same correction was not pulled through on the two service detail pages. The line "Magic-link sign-in (no passwords to leak). Sessions hashed. Files in encrypted storage. Activity log behind every action. Your data stays yours, end to end." still ships on both pages inside the `data-vibe="mountain"` variant block. Sessions are stored as SHA-256 hashes (true) and passwords are bcrypt-hashed (true), but the public claim of magic-link sign-in conflicts with the login form. Trust hinges on this and the language is still misaligned.
**Recommendation**: Rewrite the line on both service pages to match the portal's real auth model. Suggested: "Bcrypt-hashed passwords. Magic-link onboarding. Sessions stored as SHA-256 hashes. Files in encrypted storage. Activity log behind every action."
**Effort**: trivial
**Verification**: Search the codebase for "Magic-link sign-in"; the remaining matches sit in privacy.astro and admin tooling, not on public service marketing pages.

### [SEO2-006] Top-level pages still fall back to og-default.png with no per-page OG variant
**Severity**: medium
**Dimension**: 2 (Open Graph), 20 (OG images)
**Files**: `src/pages/services.astro:5`, `src/pages/services/web-management.astro:52`, `src/pages/services/marketing-strategy.astro:5`, `src/pages/services/implementation.astro:5`, `src/pages/services/training.astro:5`, `src/pages/about.astro:5`, `src/pages/contact.astro:5`, `src/pages/work.astro:5`, `src/pages/listener.astro:9`, `src/pages/privacy.astro:5`, `src/pages/404.astro:5`
**Observation**: First-round SEO-026 not addressed. Every non-blog page passes through Base.astro and falls back to `og-default.png`. A share of `/services/web-management` and a share of `/contact` show the same image in LinkedIn or X. The blog-detail OG pipeline at `src/pages/blog/og/articles/[slug].png.ts` and `src/pages/blog/og/case-studies/[slug].png.ts` proves the renderOg helper supports the use case; the helper just is not wired to any other page.
**Recommendation**: Cheap version: hand-author 4 to 6 PNGs at 1200x630 for the highest-traffic pages (homepage, /services index, the four service subpages, /about, /contact) and place them at `/public/og/{slug}.png`. Wire each page to pass `<Base ogImage="/og/{slug}.png" />`. Higher-effort version: add a parameterized OG endpoint at `src/pages/og/[slug].png.ts` mirroring the blog OG endpoints, with a static path map of titles/eyebrows per page.
**Effort**: medium
**Verification**: LinkedIn Post Inspector shows distinct preview images on each top-level page; view-source confirms `og:image` URLs are unique per page.

### [SEO2-007] Portal login page bypasses the Base layout, loads Google Fonts as a render-blocking stylesheet, and emits no canonical or twitter card meta
**Severity**: low
**Dimension**: 1 (Page metadata), 11 (Performance)
**Files**: `src/pages/portal/login.astro:14-25`
**Observation**: portal/login.astro is the only authenticated entry point, but it does not extend Base.astro and instead renders its own `<head>` directly. The Google Fonts URL is loaded as `<link rel="stylesheet">` without the preload + `media="print" onload=...` swap pattern that Base.astro adopted post-SEO-016. The login page is `noindex, nofollow` so the SEO surface is small, but a slow text paint still impacts every returning client. The page also omits `og:image`, twitter cards, and a canonical link, which is fine for indexing but means a casual share of the login URL on Slack or LinkedIn produces no preview at all. The font set requested is also smaller (no Lora, no JetBrains Mono), which is correct, but the preload pattern would still help.
**Recommendation**: Either move the login page to extend Base.astro and pass `noIndex={true}` (which Base now supports), or apply the same preload + media swap pattern inline. Decide whether to emit OG meta; for a portal login URL, a minimal OG card might help in client-onboarding emails when a portal invite gets shared sideways.
**Effort**: small
**Verification**: Lighthouse "Eliminate render-blocking resources" stops flagging fonts on `/portal/login`.

### [SEO2-008] Case-studies sector filter still uses buttons, blocking sector-page discovery if the taxonomy ever expands
**Severity**: low
**Dimension**: 6 (Internal linking), 12 (Mobile)
**Files**: `src/pages/blog/case-studies/index.astro:60-79`
**Observation**: First-round SEO-022 not addressed and first-round SEO-033 partially addressed. The sector filter bar uses `<button data-sector="...">` elements with `px-3 py-1.5` padding and no `min-h-[44px]`. The tag-filter equivalent on `/blog/articles` was updated to anchors plus `min-h-[44px] px-3 py-2.5`. Sector chips lag both upgrades. Sector landing pages do not currently exist, so the linking gap is theoretical, but the tap-target gap is real on touch devices once content lands.
**Recommendation**: At minimum, raise the chip padding to `min-h-[44px] px-3 py-2.5` to match `/blog/articles`. If sector landing pages are not on the roadmap, the anchor-vs-button distinction can wait. If sectors will get their own pages later, convert to anchors with `preventDefault` filter behavior to mirror the articles pattern.
**Effort**: trivial (tap target) / small (anchors + sector pages)
**Verification**: Lighthouse Mobile touch-target audit on `/blog/case-studies` shows zero failures on the sector chips (once content exists to render them).

### [SEO2-009] Persona-variant H1s now use role="heading" aria-level="1" wrappers; verify single H1 lands per render
**Severity**: low
**Dimension**: 4 (Headings), 13 (Persona variants), 14 (Accessibility)
**Files**: `src/pages/services.astro:13-24`, `src/pages/contact.astro:14-22`
**Observation**: First-round SEO-011 partially addressed. The non-default variants on `/services` and `/contact` were rewritten from `<h1>` to `<div role="heading" aria-level="1">`. Exactly one `<h1>` element now exists in the DOM (the default variant), which is the right call. The non-default variants still carry the same heading semantics via ARIA, but they ship with `style="display:none" aria-hidden="true"` so screen readers ignore them and crawlers only see the default. The swapAxis function in `Base.astro:236-248` strips `display:none` and `aria-hidden` from the active variant on JS-enabled clients; the default keeps the `<h1>` tag and the active variant exposes its `aria-level=1` ARIA heading. Result: the DOM now has one real H1 (good) and at most one announced heading per render (good). Filing as low because the implementation is sound but worth verifying with an accessibility tree dump once the next variant ships.
**Recommendation**: No change required. Optional: add an automated test that snapshots a render under each persona variant and asserts exactly one `[role="heading"][aria-level="1"]` node is visible. The same pattern applies to H2 variants on `/index.astro`, `/services.astro`, and the four service subpages, all of which still use multiple `<h2>` elements; H2 repetition is permitted by HTML5 so no change needed there.
**Effort**: trivial (verification)
**Verification**: View-source on `/services` and `/contact` confirms one `<h1>` element. Devtools accessibility tree shows one announced heading at level 1 in any persona variant.

### [SEO2-010] RSS feeds still description-only; absolute-URL fix unverified
**Severity**: low
**Dimension**: 19 (RSS)
**Files**: `src/pages/blog/articles/rss.xml.ts:17`, `src/pages/blog/case-studies/rss.xml.ts:17`, `src/pages/blog/rss.xml.ts:17`
**Observation**: First-round SEO-038 partially addressed and SEO-039 not addressed. The three RSS feeds still pass `link: '/blog/articles/{id}'`, `link: '/blog/case-studies/{id}'`, and `link: e.href` to `@astrojs/rss`. The package documentation says it joins `link` against `context.site`, which is set to `https://codyasmith.com` in `astro.config.mjs:10`, so the produced XML should resolve absolute. This was not verified against a built `dist/blog/rss.xml`. Separately, no feed emits `content:encoded`, so subscribers see only the description teaser and must click through. That may be intentional but was not documented.
**Recommendation**: Build the site and grep `dist/blog/rss.xml` for `<link>https://`. If any are relative, switch to `new URL(href, context.site).href` before passing to rss(). Decide whether articles should emit `content:encoded` for full-text RSS; if yes, render the article body through `@astrojs/mdx`'s renderer and pass as `content` in the item. Document the decision in CLAUDE.md.
**Effort**: trivial (verify) / medium (full-text RSS)
**Verification**: Feed validator at validator.w3.org/feed shows absolute URLs and, if applicable, `<content:encoded>` blocks on articles.

### [SEO2-011] Articles index H1 "I argue for a living. You get what you paid for." still reads ambiguous in SERP
**Severity**: low
**Dimension**: 15 (Content quality)
**Files**: `src/pages/blog/articles/index.astro:50-53`
**Observation**: First-round SEO-041 not addressed. The H1 still pairs "I argue for a living." with "You get what you paid for." If Google pulls the second sentence as a snippet, it reads like a refund warning. Voice-wise it is on brand, so this is a deliberate-tradeoff call.
**Recommendation**: Defer. Cody owns the voice call. Filing again because the trade is worth a second look if the page underperforms in search; an alternative such as "I argue for a living. These are the arguments." preserves the rhythm with less snippet ambiguity.
**Effort**: trivial
**Verification**: Search Console snippet for the page reads cleanly six weeks post-deploy.

### [SEO2-012] Text-neutral-500/600/700 used 521 times across 41 files; contrast not audited per token
**Severity**: low
**Dimension**: 14 (Accessibility)
**Files**: many across `src/pages/`
**Observation**: First-round SEO-032 not addressed. `text-neutral-500` (#737373 on neutral-950 #0a0a0a) sits around 5.1:1 (passes WCAG AA Normal but fails AAA), `text-neutral-600` (#525252) is roughly 3.2:1 (fails AA Normal), `text-neutral-700` (#404040) is around 2.0:1 (fails AA at every threshold). A grep for these tokens across `src/pages/*.astro` returns 521 hits in 41 files. Many are decorative (footer copyright, eyebrow microcopy, divider labels), but several are actionable (form helper text, metadata strips). No global audit was performed to classify each usage.
**Recommendation**: Walk the 41 files and classify each text-neutral-600 and text-neutral-700 usage as either decorative (acceptable AA failure) or meaningful (lift to text-neutral-500 or higher). Document the decision in CLAUDE.md so future copy follows the rule. As a near-term win, raise all `text-neutral-700` to `text-neutral-500` on dark surfaces unless the surrounding text is decorative.
**Effort**: small (audit) / medium (full pass)
**Verification**: Lighthouse Accessibility audit reports zero contrast failures on the homepage, services pages, and a blog detail page.

### [SEO2-013] Robots.txt disallow for naming-preview uses a path prefix; consider a more explicit form
**Severity**: info
**Dimension**: 9 (Robots), 10 (Crawl directives)
**Files**: `public/robots.txt:5`
**Observation**: The line `Disallow: /naming-preview` blocks `/naming-preview` and any descendant path starting with that prefix. There is no descendant route at the moment, so the rule is effective. If a future route `/naming-preview-results` ever lands, the rule would also block that, which may be unintended. The blog audit calls out three layered defenses already in place: `noIndex={true}` on the page, the robots.txt rule, and the sitemap filter. Belt and suspenders to spare.
**Recommendation**: Optional: tighten to `Disallow: /naming-preview$` (most crawlers support the `$` anchor) or `Disallow: /naming-preview/` if a trailing-slash variant exists. If you intend to launch related sub-routes, leave as is and revisit when those routes ship.
**Effort**: trivial
**Verification**: `https://codyasmith.com/robots.txt` reflects the chosen form.

### [SEO2-014] No /sitemap-index.xml health check or automated post-build assertion
**Severity**: info
**Dimension**: 8 (Sitemap)
**Files**: `astro.config.mjs:17-26`, `scripts/postbuild-security-headers.mjs`
**Observation**: The sitemap integration is configured and the filter excludes the right paths, but there is no post-build assertion that the produced `dist/sitemap-index.xml` exists, parses, and contains the expected URL set. A regression in `astro.config.mjs` would silently ship a broken sitemap. The post-build security-headers script proves the pattern; a sister script could check the sitemap.
**Recommendation**: Add a tiny post-build script (or extend the existing one) that opens `dist/sitemap-index.xml`, asserts at minimum the homepage, /services, /blog, and at least one blog detail URL are present, and bails the build if not.
**Effort**: trivial
**Verification**: `npm run build` fails when the sitemap is missing a known route; passes when complete.

### [SEO2-015] Listener page does not emit OG image relevant to the scanner
**Severity**: info
**Dimension**: 2 (Open Graph)
**Files**: `src/pages/listener.astro:9`
**Observation**: The Sentiment Scanner page falls back to `og-default.png` (covered in aggregate by SEO2-006). Calling it out separately because the listener page is a free lead-magnet tool intended for direct sharing; a distinct OG (for example, "What does the web say about your business?" headline burned into the card) would convert better in social link previews than the generic default. Lumping into SEO2-006 understates the funnel impact.
**Recommendation**: Author one PNG at 1200x630 with the scanner headline and pass `ogImage="/og/listener.png"`. Optional: pair with `ogImageAlt` set to the same headline.
**Effort**: trivial
**Verification**: LinkedIn Post Inspector on `/listener` shows the scanner-specific card.

### [SEO2-016] Quiz lightbox blocks scroll on first paint; no SEO impact, but worth a perf note
**Severity**: info
**Dimension**: 11 (Performance), 13 (Persona variants)
**Files**: `src/layouts/Base.astro:131-160`
**Observation**: Base.astro's inline script reads localStorage and adds either `cs-no-quiz` or `quiz-active` to `<html>` before `<body>` renders. With `quiz-active` set, the body sets `overflow: hidden` so the quiz overlay can capture interaction without document scroll. For first-time visitors the quiz lightbox always renders. Crawlers see the underlying page (good, no cloaking), but Core Web Vitals tooling may report a small LCP cost when the overlay paints. The current implementation is sound and the trade is intentional; filing as info for future LCP tuning.
**Recommendation**: No change. If Lighthouse LCP drifts past 2.5s on cold-cache loads, consider deferring the overlay paint until after first interaction.
**Effort**: N/A
**Verification**: N/A

### [SEO2-017] Privacy page has no internal link from any public page outside the footer
**Severity**: info
**Dimension**: 6 (Internal linking)
**Files**: `src/components/Footer.astro:27`
**Observation**: `/privacy` is linked only from the footer. The contact form, the listener email gate, and the portal login all collect PII but none link to the privacy policy at the point of capture. Indexability is fine (Footer link suffices for crawl), but legal/regulatory exposure compounds if a regulator audits the consent flow and notes that the privacy policy was not prominently linked at the point of data collection.
**Recommendation**: Add an inline link to `/privacy` near the submit button on the contact form, near the email field on `/listener` (gate section), and near the password field on `/portal/login`. Tiny copy, one sentence, one link.
**Effort**: trivial
**Verification**: Each capture point renders a privacy link within 200 pixels of the submit control.

### [SEO2-018] CSP image-src is locked to self/data/blob; document the policy for future content authors
**Severity**: info
**Dimension**: 16 (Tracking), 11 (Performance)
**Files**: `src/middleware.ts:50`, `scripts/postbuild-security-headers.mjs:36`
**Observation**: First-round SEO-037 not formally documented. The Content Security Policy still uses `img-src 'self' data: blob:` in both the middleware (for SSR pages) and the post-build wrapper (for prerendered pages and static assets). This is correct for the current content surface, since every article image lives under `public/images/blog/*`. The rule will silently block any future external image. CLAUDE.md does not document this constraint as of this audit pass.
**Recommendation**: Add a one-line note to CLAUDE.md under content authoring conventions: "All blog images must be uploaded to `public/images/blog/{slug}/`; external image URLs will be blocked by the site CSP." Same goes for MDX-authored Figure or Gallery entries. If a future need arises (YouTube thumbnails, partner CDN images), widen `img-src` deliberately and note the exception.
**Effort**: trivial
**Verification**: A future MDX file that references an external image URL fails to render the image in a normal browser; the CSP violation is visible in the console.

## Strengths
- Article and BlogPost JSON-LD pipeline is complete: every article and case-study detail page emits a valid `Article` block (headline, datePublished, dateModified when present, image with ImageObject dimensions when cover has them, author Person, publisher Organization, mainEntityOfPage, articleSection, keywords). BlogPost.astro centralizes the pattern so new templates pick it up free.
- Homepage `@graph` (Organization + ProfessionalService + WebSite) properly cross-references nodes via `@id` and references the about-page Person via `founder`. This is the right shape for knowledge-panel disambiguation.
- BreadcrumbList JSON-LD now ships on every category and detail blog page through the Base layout prop.
- ItemList schema ships on the blog index, articles index, case-studies index, and tag pages.
- Person schema on /about has worksFor, alumniOf, award array, knowsAbout, and sameAs.
- Base.astro emits a full Open Graph + Twitter Card set with image dimensions, image alt, article meta (published, modified, author, section, tag), site name, locale, and canonical.
- middleware.ts emits `X-Robots-Tag: noindex, nofollow` on every response under `/portal`, belt-and-suspendering the meta tag on `/portal/login`.
- robots.txt disallows portal, api, and the experimental naming-preview route; explicitly allows GPTBot, ChatGPT-User, ClaudeBot, Claude-User, PerplexityBot, Google-Extended, and CCBot.
- astro.config.mjs sets `trailingSlash: 'never'` and the sitemap filter excludes portal, api, PNG OG endpoints, and naming-preview.
- Fonts loaded via preload-as-style plus media-print swap with noscript fallback; preconnect to fonts.googleapis.com and fonts.gstatic.com still in place.
- listener.astro is now static (no `prerender = false`), unused getRecentScans import removed.
- Cover images on blog detail pages use `loading="lazy"`, `decoding="async"`, and pass width/height from frontmatter when available; the content schema accepts the dimensions.
- Tag chips on `/blog/articles` are anchors with min-h-[44px] tap targets and click-preventDefault filter behavior, so crawlers can follow them and humans get JS filtering.
- Persona variant H1s on `/services` and `/contact` reduce to one DOM `<h1>` per page via `<div role="heading" aria-level="1">` wrappers; aria-hidden is toggled correctly via swapAxis so screen readers announce exactly one heading per persona variant.
- Skip-to-content link with strong focus contrast (amber-500 on neutral-950 = roughly 10:1) sits at the top of Base.astro.
- viewport, lang, charset, theme-color, manifest, favicon variants, and apple-touch-icon all present.
- No third-party tracking scripts (no GA, no Microsoft Clarity, no Meta pixel), consistent with the privacy policy.
- Astro view transitions wired so SPA-style nav still re-initializes accessibility/personalization through `astro:after-swap` hooks in Base.astro, Nav.astro, Footer.astro, BlogPost.astro, listener.astro, and contact.astro.
- Security headers (HSTS, CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, COOP, CORP) applied uniformly via postbuild wrapper plus SSR middleware.
- Privacy page accurately describes the bcrypt password flow with magic-link onboarding and SHA-256 session hashing; the magic-link contradiction is now isolated to two service pages (see SEO2-005).
