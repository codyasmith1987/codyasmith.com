# SEO audit 2026-05-12, Round 3

Branch: seo-security-improvements
Scope: public-facing pages and supporting code only. Portal admin out of scope.
Auditor: Claude Code (Opus 4.7, 1M context) sub-agent
Prior rounds: docs/audits/seo-audit-2026-05-12.md (41 findings), docs/audits/seo-audit-2026-05-12-round2.md (18 findings)

## Summary
- Total findings: 11 (critical: 0, high: 1, medium: 3, low: 3, info: 4)
- Top themes:
  - Case studies collection is still empty; the homepage receipt blocks, the case-studies RSS, and the sector filter still depend on content that has not shipped
  - Web Management and Marketing Strategy still ship no Service JSON-LD, while Implementation and Training do
  - About page `Person.award` array lists three awards while the rendered Credentials section lists five plus a UPA group
  - Top-level pages still fall back to og-default.png with no per-page OG variant
  - robots.txt AI-bot record groups inherit no Disallow rules from `User-agent: *`, so a compliant AI crawler is technically free to fetch /portal/ and /api/

## Round 2 fixes verified in code
- SEO2-002 resolved: all four service detail pages now emit FAQPage JSON-LD with visible `<details>` accordions that mirror schema text exactly (`src/pages/services/web-management.astro:4-49`, `marketing-strategy.astro:4-49`, `implementation.astro:4-57`, `training.astro:4-57`).
- SEO2-003 resolved on Implementation and Training: each emits a Service JSON-LD block with `provider` referencing the homepage Organization `@id`, `areaServed`, and an `offers` array using UnitPriceSpecification for hourly rates and PriceSpecification for flat-fee items (`implementation.astro:59-114`, `training.astro:59-108`).
- SEO2-004 resolved: Figure.astro and Gallery.astro now accept `width?: number` and `height?: number` props and pass them through to the rendered `<img>` (`src/components/blog/Figure.astro:11-25`, `src/components/blog/Gallery.astro:10-32`).
- SEO2-005 resolved: the "Magic-link sign-in" line is no longer present on any public service page. Marketing Strategy now reads "Password sign-in with bcrypt hashing. Sessions stored as SHA-256 hashes. Files in encrypted storage with signed time-bound download links. Activity log behind every action." (`src/pages/services/marketing-strategy.astro:305-307`). The only remaining "magic-link" string in `src/` is a code comment in `src/pages/portal/auth/send-link.ts:34`.
- SEO2-007 resolved: portal login now uses the preload-as-style + media print swap pattern with a noscript fallback (`src/pages/portal/login.astro:22-37`).
- SEO2-008 resolved: sector chips on `/blog/case-studies` now ship with `min-h-[44px] px-3 py-2.5` (`src/pages/blog/case-studies/index.astro:67-78`).

## Findings

### [SEO3-001] Case studies collection is still empty
**Severity**: high
**Dimension**: 15 (Content quality), 6 (Internal linking), 8 (Sitemap), 19 (RSS)
**Files**: `src/content/case-studies/` (empty), `src/pages/blog/case-studies/index.astro:86-91`, `src/pages/blog/index.astro:75-112`, `src/pages/blog/case-studies/rss.xml.ts:13`
**Observation**: Round 1 SEO-007 not addressed, Round 2 SEO2-001 not addressed. The case-studies collection still has no entries. The index renders empty-state copy, `getStaticPaths` for `[slug].astro` returns nothing, the case-studies RSS contains no items, the homepage `latestCase` block hides entirely, the `otherCases` block hides, and the sector filter renders nothing. The candidate file `case-study-psychographic-personalization.md` still sits at the repo root, not inside `src/content/case-studies/`. Nav, hero copy, blog hero, sector chip wiring, and the homepage CTAs all advertise case studies that do not exist.
**Recommendation**: Either move the candidate file into the collection (after legal review), publish one greenlit study, or strip the case-study sections from `/blog/index.astro` and the sector filter from `/blog/case-studies/index.astro` until content lands. The third option is the smallest possible commit if no content is imminent.
**Effort**: medium (content) or small (template guard)
**Verification**: Either `/blog/case-studies/[slug]` resolves with valid Article JSON-LD, or the case-study sections cease to appear on the blog index.

### [SEO3-002] About page Person.award array does not match the visible Credentials list
**Severity**: medium
**Dimension**: 3 (Structured data), 16 (Tracking and accuracy of public content), 18 (Schema validity)
**Files**: `src/pages/about.astro:34-38`, `src/pages/about.astro:147-180`
**Observation**: Round 1 SEO-004 partially addressed and not noted in Round 2. The schema lists three awards: "Horizon Interactive Award, Best Advocacy Training Program (SPTS / AllenComm)", "Davey Award, Education (SPTS / AllenComm)", "Utah Press Association Award (Iron County Today)". The visible Credentials section lists five distinct named awards (Bronze Horizon, Silver Horizon, Bronze Horizon, Silver Davey) plus "Utah Press Association Awards" (plural). The schema undercounts Horizon awards (1 vs 3 in the UI), misnames the Davey category ("Education" in schema vs "General-Education" in UI), and the schema text refers to "Best Advocacy Training Program" which appears nowhere on the page. A reviewer comparing JSON-LD to the rendered page will see a discrepancy; Google's E-E-A-T crawlers reading the structured data get a different award count than a human reader.
**Recommendation**: Rewrite the `award` array to match the visible list exactly. Suggested values: "Bronze Horizon Interactive Award, Non-profit (SPTS / AllenComm)", "Silver Horizon Interactive Award, Training and eLearning (SPTS / AllenComm)", "Bronze Horizon Interactive Award, Non-profit and Advocacy (SPTS / AllenComm)", "Silver Davey Award, General-Education (SPTS / AllenComm)", "Utah Press Association Awards (Iron County Today)". Cross-link to the AllenComm portfolio page via `sameAs` if it lists the same awards.
**Effort**: trivial
**Verification**: View source on `/about` and confirm the `award` array count matches the rendered list count; Rich Results test validates the Person entity.

### [SEO3-003] Web Management and Marketing Strategy still ship no Service JSON-LD
**Severity**: medium
**Dimension**: 3 (Structured data)
**Files**: `src/pages/services/web-management.astro:52-54`, `src/pages/services/marketing-strategy.astro:52-54`
**Observation**: Round 2 SEO2-003 was resolved only for Implementation and Training. The two remaining service detail pages still emit only FAQPage and BreadcrumbList JSON-LD. Web Management explicitly says pricing is "calibrated, not off the rack" (`web-management.astro:282`) and the page intentionally hides public rates; Marketing Strategy mirrors that ("Calibrated, not off the rack", `marketing-strategy.astro:326-328`). The absence of public prices is a defensible reason to skip `Offer` blocks, but the `Service` entity itself (with `provider`, `serviceType`, `areaServed`, `name`, `description`, `url`) is independent of pricing and should still ship so each service page declares a typed service entity that AI assistants and rich-result crawlers can connect back to the homepage Organization `@id`.
**Recommendation**: Add a `Service` block per page modeled after `implementation.astro:59-68` (the header lines, dropping the `offers` array). Use `serviceType` values "Web Management" and "Marketing Strategy", `provider: { "@id": "https://codyasmith.com/#organization" }`, and the existing page title/description as `name` and `description`. If pricing decisions ever go public, the `offers` array can be added later.
**Effort**: small
**Verification**: Rich Results test accepts each Service entity; `provider.@id` resolves to the homepage Organization.

### [SEO3-004] Top-level pages still fall back to og-default.png with no per-page OG variant
**Severity**: medium
**Dimension**: 2 (Open Graph), 20 (OG images)
**Files**: `src/pages/services.astro:5`, `src/pages/services/*.astro` (all four), `src/pages/about.astro:5`, `src/pages/contact.astro:5`, `src/pages/work.astro:5`, `src/pages/listener.astro:9`, `src/pages/privacy.astro:5`, `src/pages/404.astro:5`
**Observation**: Round 1 SEO-026 not addressed, Round 2 SEO2-006 not addressed. Every non-blog page still passes through Base.astro with no `ogImage` prop and resolves to `/og-default.png`. The blog OG endpoints in `src/pages/blog/og/articles/[slug].png.ts` and `src/pages/blog/og/case-studies/[slug].png.ts` prove the `renderOg` helper supports parameterized generation. The helper is not wired to any other page. `public/og/` does not exist.
**Recommendation**: Cheap version: hand-author 4 to 6 PNGs at 1200x630 for the homepage, /services, the four service subpages, /about, /contact, /listener, and /work. Drop them in `public/og/{slug}.png` and pass `ogImage="/og/{slug}.png"` per page. Higher-effort version: add `src/pages/og/[slug].png.ts` mirroring the blog endpoints, with a static title/eyebrow map per slug.
**Effort**: medium
**Verification**: LinkedIn Post Inspector and X Card Validator each show a distinct preview image per top-level page.

### [SEO3-005] robots.txt AI-bot groups inherit no Disallow rules; portal and api are technically crawlable by compliant AI agents
**Severity**: low
**Dimension**: 9 (Robots), 10 (Crawl directives), 16 (Tracking)
**Files**: `public/robots.txt:10-29`
**Observation**: New in round 3. The robots.txt spec is record-scoped per `User-agent`: each block stands alone, with no inheritance from `User-agent: *`. The file currently has eight record groups: the wildcard plus seven named AI bots (GPTBot, ChatGPT-User, ClaudeBot, Claude-User, PerplexityBot, Google-Extended, CCBot). The wildcard correctly carries `Disallow: /portal/`, `/api/`, `/naming-preview`. The seven AI-bot groups each carry only `Allow: /`. A compliant AI crawler reads its named group, finds no Disallow rules, and treats the whole site as open, including `/portal/` and `/api/`. The X-Robots-Tag noindex header in `src/middleware.ts:39-41` still prevents indexing of `/portal/*` responses, and `/api/*` returns JSON not HTML, but the crawl waste and the surface-area signal are real.
**Recommendation**: Duplicate the three Disallow lines into each AI-bot block, or restructure to use a shared block. Pattern (per bot):
```
User-agent: GPTBot
Allow: /
Disallow: /portal/
Disallow: /api/
Disallow: /naming-preview
```
Repeat for each named AI bot. Alternatively, group all seven names under one `User-agent: name` block per record with the same Disallow set.
**Effort**: trivial
**Verification**: A robots.txt tester (Google Search Console or technicalseo.com/tools/robots-txt) reports each AI bot blocked on `/portal/` and `/api/`.

### [SEO3-006] RSS feed link fields use relative paths; verify @astrojs/rss joins against context.site
**Severity**: low
**Dimension**: 19 (RSS)
**Files**: `src/pages/blog/articles/rss.xml.ts:17`, `src/pages/blog/case-studies/rss.xml.ts:17`, `src/pages/blog/rss.xml.ts:17`
**Observation**: Round 2 SEO2-010 not addressed. The three feeds still pass `link: '/blog/articles/${a.id}'`, `link: '/blog/case-studies/${c.id}'`, and `link: e.href` (which is also a leading-slash path) to `rss()`. The unified feed at `src/pages/blog/rss.xml.ts:17` is materially the same shape as the others. @astrojs/rss documentation states `link` is joined against `context.site` when relative, and `site: 'https://codyasmith.com'` is set in `astro.config.mjs:10`, so the generated XML should be absolute. This was not built and verified during this audit; a regression in the `site` value or the rss package would silently ship relative `<link>` tags. No feed emits `content:encoded`, so subscribers see only the description teaser.
**Recommendation**: Build the site and `Select-String '<link>https' dist/blog/rss.xml` to confirm absolute URLs. If absolute, leave the code and add a short comment noting the dependency. If relative, switch to `link: new URL('/blog/articles/${a.id}', context.site).href`. Separately, decide whether articles should ship `content:encoded` for full-text RSS; if yes, render the article body through `@astrojs/mdx`'s renderer and pass as `content`. Document the decision in CLAUDE.md.
**Effort**: trivial (verify) / medium (full-text RSS)
**Verification**: validator.w3.org/feed reports absolute URLs and, if applicable, `<content:encoded>` blocks on articles.

### [SEO3-007] Text-neutral-700 used 86 times across 33 files; contrast still not audited per token
**Severity**: low
**Dimension**: 14 (Accessibility)
**Files**: many across `src/pages/` and `src/components/` and `src/layouts/`
**Observation**: Round 1 SEO-032 not addressed, Round 2 SEO2-012 not addressed. A grep for `text-neutral-700` (#404040 on neutral-950 #0a0a0a is roughly 2.0:1, fails WCAG AA at every threshold) returns 86 hits in 33 files. Many are decorative (`Footer.astro:23` copyright line, divider middots, eyebrow microcopy), but several are meaningful copy: the `/portal/login` placeholder text colors (`placeholder-neutral-700`), the listener tier 1 score area (`t1-source-bars` empty-state span), and the homepage personalization badge (`Nav.astro:19`). No global audit has been performed to classify each usage.
**Recommendation**: Walk the 33 files (use the grep results above as the inventory) and classify each `text-neutral-700` usage as either decorative (acceptable AA failure on small chrome) or meaningful (lift to `text-neutral-500` or higher). As a near-term win, raise all placeholder colors to `text-neutral-500` so input ghosting passes AA. Document the rule in CLAUDE.md so future copy follows it.
**Effort**: small (audit) / medium (full pass)
**Verification**: Lighthouse Accessibility reports zero contrast failures on the homepage, services pages, the contact form, the listener gate, and a blog detail page.

### [SEO3-008] Articles index H1 still pairs "I argue for a living. You get what you paid for."
**Severity**: low
**Dimension**: 15 (Content quality)
**Files**: `src/pages/blog/articles/index.astro:50-53`
**Observation**: Round 1 SEO-041 not addressed, Round 2 SEO2-011 not addressed. The H1 still ends on the refund-warning phrasing. Filing again because the trade is worth a second look if the page underperforms in search; the call is Cody's.
**Recommendation**: Defer per prior rounds. Cody owns the voice call. If revisiting, an alternative such as "I argue for a living. These are the arguments." preserves the rhythm with less snippet ambiguity.
**Effort**: trivial
**Verification**: Search Console snippet for the page reads cleanly six weeks post-deploy.

### [SEO3-009] No sitemap post-build assertion still in place
**Severity**: info
**Dimension**: 8 (Sitemap)
**Files**: `astro.config.mjs:17-26`, `scripts/postbuild-security-headers.mjs`
**Observation**: Round 2 SEO2-014 not addressed. The sitemap filter is correct (excludes portal, api, png endpoints, naming-preview), but no post-build script asserts that `dist/sitemap-index.xml` exists, parses, and contains the expected URL set. A regression in `site` value, the sitemap integration, or `trailingSlash` would ship a broken sitemap silently. The existing postbuild script is the obvious extension point.
**Recommendation**: Extend `scripts/postbuild-security-headers.mjs` (or add a sister script) to open `dist/sitemap-index.xml`, parse the URL list, and assert at minimum the homepage, /services, /blog, and at least one blog detail URL are present. Exit nonzero if not. Wire it into `npm run build` after the security-headers step.
**Effort**: trivial
**Verification**: `npm run build` fails when the sitemap is missing a known route; passes when complete.

### [SEO3-010] CSP image-src constraint still undocumented for content authors
**Severity**: info
**Dimension**: 16 (Tracking), 11 (Performance), 15 (Content quality)
**Files**: `src/middleware.ts:50`, `scripts/postbuild-security-headers.mjs:36`, `CLAUDE.md`
**Observation**: Round 2 SEO2-018 not addressed. CSP still uses `img-src 'self' data: blob:` in both the SSR middleware and the static wrapper. Correct for the current content surface (every article image lives under `public/images/blog/*`), and it will silently block any future external image. CLAUDE.md does not document the constraint.
**Recommendation**: Add a one-line note to CLAUDE.md under content authoring conventions: "All blog images must be uploaded to `public/images/blog/{slug}/`; external image URLs will be blocked by the site CSP." Apply to MDX Figure or Gallery entries.
**Effort**: trivial
**Verification**: A future MDX file that references an external image URL fails to render the image in a normal browser; the CSP violation is visible in the console.

### [SEO3-011] Listener and other lead-magnet pages have no scanner-specific OG card
**Severity**: info
**Dimension**: 2 (Open Graph)
**Files**: `src/pages/listener.astro:9`
**Observation**: Round 2 SEO2-015 rolled into the aggregate SEO3-004 above, but worth calling out separately because `/listener` is the most direct lead-magnet on the site and a distinct OG card would convert better in social previews than the generic default. Same logic applies to `/contact` and `/services`, where direct shares are most likely.
**Recommendation**: Author one PNG at 1200x630 with the scanner headline ("What does the web say about your business?") and pass `ogImage="/og/listener.png"`. Pair with `ogImageAlt` set to the same headline.
**Effort**: trivial
**Verification**: LinkedIn Post Inspector on `/listener` shows the scanner-specific card.

## Strengths confirmed since round 2
- FAQPage JSON-LD now ships on all four service detail pages and the rendered `<details>` accordion text matches the schema text exactly. This was the biggest structured-data gap and it closed cleanly.
- Implementation and Training emit Service JSON-LD with provider references to the homepage Organization `@id`, areaServed, serviceType, and offers arrays modeled correctly (UnitPriceSpecification for hourly rates, PriceSpecification for flat-fee items, referenceQuantity for hourly).
- Figure.astro and Gallery.astro accept optional width and height props and render them on the underlying `<img>`. Content authors can now ship body images without causing CLS.
- The "Magic-link sign-in" phrase is no longer present on any public service page. The remaining string in `src/` is a code comment in the auth flow.
- Portal login uses the preload-as-style + media print swap pattern with a noscript fallback, matching the Base.astro pattern post-SEO-016.
- Sector chips on `/blog/case-studies` raise tap target to `min-h-[44px]` per WCAG 2.5.5.
- Article JSON-LD pipeline remains complete and centralized in BlogPost.astro.
- Homepage `@graph` (Organization + ProfessionalService + WebSite) still cross-references via `@id`.
- BreadcrumbList JSON-LD ships on every blog category and detail page through the Base layout prop.
- ItemList JSON-LD ships on blog index, articles index, case-studies index, and tag pages.
- Person schema on /about has worksFor, alumniOf, knowsAbout, sameAs (note: award array undercount per SEO3-002).
- Base.astro emits a full Open Graph + Twitter Card set with image dimensions, image alt, article meta (published, modified, author, section, tag), site name, locale, and canonical.
- middleware.ts emits `X-Robots-Tag: noindex, nofollow` on every response under `/portal`.
- robots.txt disallows portal, api, and naming-preview for the wildcard agent.
- astro.config.mjs sets `trailingSlash: 'never'` and the sitemap filter excludes portal, api, PNG endpoints, and naming-preview.
- Fonts loaded via preload-as-style plus media-print swap with noscript fallback on Base.astro and now also on /portal/login.
- Cover images on blog detail pages use loading="lazy", decoding="async", and width/height when frontmatter provides them.
- Persona variant H1s reduce to one DOM `<h1>` per page via `<div role="heading" aria-level="1">` wrappers; aria-hidden toggled correctly via swapAxis.
- Skip-to-content link with strong focus contrast at the top of Base.astro.
- viewport, lang, charset, theme-color, manifest, favicon variants, and apple-touch-icon all present.
- No third-party tracking scripts (no GA, no Microsoft Clarity, no Meta pixel), consistent with the privacy policy.
- Astro view transitions wired so SPA-style nav still re-initializes accessibility and personalization through astro:after-swap hooks.
- Security headers (HSTS, CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, COOP, CORP) applied uniformly via postbuild wrapper plus SSR middleware.
- Privacy page accurately describes the bcrypt password flow with magic-link onboarding and SHA-256 session hashing.
