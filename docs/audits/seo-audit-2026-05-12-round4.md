# SEO audit 2026-05-12, Round 4

Branch: seo-security-improvements
Scope: public-facing pages and supporting code only. Portal admin out of scope.
Auditor: Claude Code (Opus 4.7, 1M context) sub-agent
Prior rounds: docs/audits/seo-audit-2026-05-12.md (41 findings), docs/audits/seo-audit-2026-05-12-round2.md (18 findings), docs/audits/seo-audit-2026-05-12-round3.md (11 findings)

## Summary
- Total findings: 8 (critical: 0, high: 1, medium: 2, low: 3, info: 2)
- Top themes:
  - Four blog list templates ship stray `</content></invoke>` literals after the closing `</Base>` tag. NEW this round, not flagged previously.
  - Case studies collection is still empty; homepage references were guarded but the case-study index hero, blog hero, and nav still advertise content that does not exist.
  - Top-level pages still fall back to og-default.png; no per-page OG variants.
  - Implementation and Training Service JSON-LD lack `termsOfService`, while Web Management and Marketing Strategy now carry it. Consistency gap.
  - `text-neutral-700` count unchanged from round 3 (86 hits across 33 files); placeholder colors and decorative chrome not yet classified.

## Round 3 fixes verified in code
- SEO3-002 resolved: `src/pages/about.astro:34-40` now lists five awards in the `Person.award` array, matching the visible Credentials section exactly: Bronze Horizon (Non-profit), Silver Horizon (Training and eLearning), Bronze Horizon (Non-profit and Advocacy), Silver Davey (General-Education), and Utah Press Association Awards.
- SEO3-003 resolved: `src/pages/services/web-management.astro:55-65` and `src/pages/services/marketing-strategy.astro:55-65` now emit Service JSON-LD with `provider` referencing `https://codyasmith.com/#organization`, `serviceType`, `areaServed`, `description`, and `termsOfService`. No `offers` array, which is correct given both pages intentionally hide public pricing.
- SEO3-005 resolved: `public/robots.txt:1-53` now explicitly restates `Disallow: /portal/`, `/api/`, and `/naming-preview` inside every named AI-bot record (GPTBot, ChatGPT-User, ClaudeBot, Claude-User, PerplexityBot, Google-Extended, CCBot). Comment block in lines 7-10 also documents the REP-record-scoping rationale so the next editor does not undo it.

## Findings

### [SEO4-001] Four blog list templates ship stray `</content></invoke>` literals after the closing `</Base>` tag
**Severity**: high
**Dimension**: 15 (Content quality), 16 (Tracking and accuracy of public content), 18 (Schema validity), 1 (Page metadata)
**Files**: `src/pages/blog/case-studies/index.astro:165-167`, `src/pages/blog/articles/index.astro:158-160`, `src/pages/blog/tags/[tag].astro:93-95`, `src/pages/blog/index.astro:190-192`
**Observation**: NEW in round 4. Each of the four files ends with the literal text `</content>\n</invoke>` sitting outside the `</Base>` closing tag (and in `case-studies/index.astro` and `articles/index.astro`, outside the trailing `<script>` block). This is an artifact of a prior LLM editing pass. Astro compiles the files without erroring (`npx astro build` proceeds through these routes before failing later on the unrelated CSRF_SECRET env requirement), and the artifact will render in the static HTML output as a literal text node after the main layout closes. The visible effect is small unstyled text at the bottom of the page in some browsers, but the larger problem is that the HTML is malformed, screen readers will encounter unexpected content, and view-source-driven SEO tools (Search Console fetch-and-render, social-card validators, AI grounding crawlers) will see broken markup and may downgrade trust in the page.
**Recommendation**: Delete the trailing `</content></invoke>` lines from all four files. Verify with `Select-String -Path "src\pages\blog\**\*.astro" -Pattern '</invoke>'` to confirm zero matches. Optionally add a pre-commit hook that fails when these literals appear anywhere under `src/`.
**Effort**: trivial
**Verification**: `grep -r '</invoke>' src/` returns zero matches. View-source on `/blog`, `/blog/articles`, `/blog/case-studies`, and `/blog/tags/{tag}` shows clean closing `</html>` with no trailing text nodes.

### [SEO4-002] Case studies collection still empty; index hero, sector filter, nav advertise content that does not exist
**Severity**: medium
**Dimension**: 15 (Content quality), 6 (Internal linking), 8 (Sitemap), 19 (RSS)
**Files**: `src/content/case-studies/` (empty), `src/pages/blog/case-studies/index.astro:86-91`, `src/pages/blog/case-studies/rss.xml.ts:13`, `src/components/Nav.astro:6` (nav still routes to `/blog`)
**Observation**: Round 1 SEO-007, round 2 SEO2-001, round 3 SEO3-001 all unresolved. The collection is still empty. Build emits a content warning at compile time: `No files found matching "**/*.{md,mdx}" in directory "src\content\case-studies"`. The case-studies RSS contains no items. The `getStaticPaths` for `[slug].astro` returns nothing. Severity dropped from high to medium because the homepage now guards `latestCase` and `otherCases` with conditional renders, and `getCollection('caseStudies')` returning empty no longer causes user-facing dead sections on `/blog`. However the dedicated case-studies index at `/blog/case-studies` still renders a hero and empty-state copy advertising future case studies, and the blog index hero on `src/pages/blog/index.astro:60-62` still reads "Articles on whatever I can't stop thinking about. Case studies on clients my lawyer cleared." The candidate file `case-study-psychographic-personalization.md` still sits at the repo root, not under `src/content/case-studies/`.
**Recommendation**: One of three options. (1) Move the candidate file into `src/content/case-studies/` after legal/client review. (2) Ship at least one greenlit case study so the index has something. (3) If neither is imminent, edit the blog index hero copy to drop the case-studies mention and either remove or rewrite the `/blog/case-studies` index hero so it reflects "coming soon" rather than promising current content.
**Effort**: medium (content) or trivial (copy edit)
**Verification**: Either `/blog/case-studies/{slug}` resolves with valid Article JSON-LD, or the case-study marketing language on both index pages stops promising existing receipts.

### [SEO4-003] Top-level pages still fall back to og-default.png with no per-page OG variant
**Severity**: medium
**Dimension**: 2 (Open Graph), 20 (OG images)
**Files**: `src/pages/services.astro:5`, `src/pages/services/web-management.astro:52`, `src/pages/services/marketing-strategy.astro:52`, `src/pages/services/implementation.astro:117`, `src/pages/services/training.astro:111`, `src/pages/about.astro:5`, `src/pages/contact.astro:5`, `src/pages/work.astro:5`, `src/pages/listener.astro:9`, `src/pages/privacy.astro:5`, `src/pages/404.astro:5`
**Observation**: Round 1 SEO-026, round 2 SEO2-006, round 3 SEO3-004 and SEO3-011 still unresolved. Every non-blog page passes through Base.astro with no `ogImage` prop and resolves to `/og-default.png`. The `public/og/` directory does not exist. The renderOg helper in `src/lib/og.ts` and the blog OG endpoints at `src/pages/blog/og/articles/[slug].png.ts` and `src/pages/blog/og/case-studies/[slug].png.ts` demonstrate the satori + Resvg pipeline works; the helper is just not wired to any page outside the blog detail templates.
**Recommendation**: Cheapest path: hand-author 4 to 6 1200x630 PNGs for the homepage, /services, the four service subpages, /about, /contact, /listener. Drop in `public/og/{slug}.png` and pass `ogImage="/og/{slug}.png"` per page. Higher-effort path: add `src/pages/og/[slug].png.ts` mirroring the blog endpoints with a static title/eyebrow map. /listener is the highest-priority single page because it is the most direct lead-magnet share target.
**Effort**: medium
**Verification**: LinkedIn Post Inspector and X Card Validator each show a distinct preview image per top-level page; view-source confirms unique `og:image` URLs.

### [SEO4-004] Implementation and Training Service JSON-LD lack `termsOfService` that Web Management and Marketing Strategy now carry
**Severity**: low
**Dimension**: 3 (Structured data), 18 (Schema validity)
**Files**: `src/pages/services/implementation.astro:59-114`, `src/pages/services/training.astro:59-108`, `src/pages/services/web-management.astro:55-65`, `src/pages/services/marketing-strategy.astro:55-65`
**Observation**: NEW in round 4, surfaced by round 3 SEO3-003 fix. Web Management and Marketing Strategy both gained a `termsOfService` field on their Service JSON-LD ("Month-to-month after onboarding..." and "Month-to-month after the initial audit..."). Implementation and Training, which were fixed in round 2 for SEO2-003, do not have a `termsOfService` field on their Service blocks. The four service pages now ship structurally inconsistent Service entities to crawlers. Implementation has an honest answer in its FAQ ("Change orders get quoted separately before any additional work begins...") and Training has one too ("Reference guides, SOPs, and checklists are included with any session and they're yours to keep...") which can each be condensed into a one-line `termsOfService` value.
**Recommendation**: Add `termsOfService` to both Service JSON-LD blocks. For Implementation: "Fixed scope after sign-off. Change orders quoted separately. Short warranty window post-delivery." For Training: "Materials yours to keep. Cohort-based; remote by default." Match the rhythm of the existing two and keep under 200 chars.
**Effort**: trivial
**Verification**: Rich Results test accepts all four Service entities; `termsOfService` populates on each.

### [SEO4-005] Text-neutral-700 still used 86 times across 33 files; contrast not classified per token
**Severity**: low
**Dimension**: 14 (Accessibility)
**Files**: many; see grep results in round 3 SEO3-007
**Observation**: Round 1 SEO-032, round 2 SEO2-012, round 3 SEO3-007 all unresolved. Identical count and file list as round 3 (86 hits, 33 files). #404040 on neutral-950 #0a0a0a is about 2.0:1, which fails WCAG AA at every threshold. Several are clearly decorative chrome (Footer.astro:23 copyright text, divider middots, Nav.astro:19 personalization badge eyebrow microcopy), but some are meaningful copy: portal login `placeholder-neutral-700` (multiple files), listener tier 1 source-bars empty state, and several inline `<span>`s used for separators that could be `aria-hidden`. Filing again because it has now been deferred across three rounds without an inventory pass.
**Recommendation**: A single focused inventory pass on the 33 files. Classify each hit as decorative (acceptable AA fail on small chrome) or meaningful (lift to text-neutral-500 or higher). For separators and decorative middots, add `aria-hidden="true"` so screen readers ignore them and the contrast loss does not affect assistive tech. Codify the rule in CLAUDE.md.
**Effort**: small (audit) / medium (full pass)
**Verification**: Lighthouse Accessibility reports zero contrast failures on homepage, services, contact, listener gate, and a blog detail page.

### [SEO4-006] Articles index H1 still pairs "I argue for a living. You get what you paid for."
**Severity**: low
**Dimension**: 15 (Content quality)
**Files**: `src/pages/blog/articles/index.astro:50-53`
**Observation**: Round 1 SEO-041, round 2 SEO2-011, round 3 SEO3-008 all unresolved. The H1 still ends on the refund-warning phrasing. Filing one last time because the call is Cody's; closing this finding next round if the line stands.
**Recommendation**: Defer per prior rounds. If revisited, "I argue for a living. These are the arguments." preserves the rhythm with less snippet ambiguity.
**Effort**: trivial
**Verification**: Search Console snippet for `/blog/articles` reads cleanly six weeks post-deploy.

### [SEO4-007] No sitemap or RSS post-build assertion still in place
**Severity**: info
**Dimension**: 8 (Sitemap), 19 (RSS)
**Files**: `astro.config.mjs:17-26`, `scripts/postbuild-security-headers.mjs`
**Observation**: Round 2 SEO2-014, round 3 SEO3-009 unresolved. The build pipeline runs `astro build && node scripts/postbuild-security-headers.mjs` per `package.json:10`. The postbuild script wraps the entry handler with security headers but does not assert that `dist/sitemap-index.xml` or the three RSS feeds (`/blog/rss.xml`, `/blog/articles/rss.xml`, `/blog/case-studies/rss.xml`) exist and parse. Round 3 SEO3-006 (RSS absolute-URL verification) also remains pending; the related script would naturally cover it. A regression in `site`, `trailingSlash`, or the rss/sitemap integrations would ship a broken artifact silently.
**Recommendation**: Add `scripts/postbuild-assert-sitemap-rss.mjs` that opens `dist/sitemap-index.xml`, asserts the homepage + /services + /blog + at least one blog detail URL appear, then opens each RSS XML, asserts `<link>` values start with `https://codyasmith.com`, and exits nonzero on failure. Chain it after `postbuild-security-headers.mjs` in `package.json` build script.
**Effort**: trivial
**Verification**: `npm run build` fails when sitemap or RSS is malformed; passes when complete.

### [SEO4-008] CSP image-src constraint still undocumented for content authors
**Severity**: info
**Dimension**: 16 (Tracking), 11 (Performance), 15 (Content quality)
**Files**: `src/middleware.ts:50`, `scripts/postbuild-security-headers.mjs:36`, `CLAUDE.md`
**Observation**: Round 2 SEO2-018, round 3 SEO3-010 unresolved. CSP still uses `img-src 'self' data: blob:` in both SSR middleware and the postbuild wrapper. Correct for current content (every article cover under `public/images/blog/*`). CLAUDE.md has no note about the constraint, so a future content author who references an external image URL will see it silently blocked with no obvious cause.
**Recommendation**: Add one line under content-authoring conventions in CLAUDE.md: "All blog images must be uploaded to `public/images/blog/{slug}/`; external image URLs will be blocked by the site CSP." Same rule applies to MDX Figure/Gallery entries.
**Effort**: trivial
**Verification**: A future MDX file that references an external image URL fails to render the image in the browser with a CSP violation visible in the console; CLAUDE.md note prevents the mistake at authoring time.

## Strengths confirmed since round 3
- Person schema on /about has accurate 5-award array that matches the visible Credentials section.
- All four service detail pages emit a Service JSON-LD block with provider, serviceType, areaServed, and description; Web Management and Marketing Strategy add termsOfService; Implementation and Training add an offers array (UnitPriceSpecification for hourly rates, PriceSpecification for flat-fee items).
- robots.txt explicitly disallows /portal/, /api/, and /naming-preview under each AI-bot record group, with a header comment explaining the REP record-scoping rationale.
- All four service detail pages emit FAQPage JSON-LD with rendered `<details>` accordion text matching the schema text exactly.
- Figure.astro and Gallery.astro accept optional width and height props.
- Portal login uses the preload-as-style + media print swap pattern with a noscript fallback.
- Sector chips on /blog/case-studies meet WCAG 2.5.5 (min-h-[44px], px-3 py-2.5).
- Article JSON-LD pipeline complete and centralized in BlogPost.astro with headline, datePublished, dateModified, image with dimensions, author, publisher, mainEntityOfPage, articleSection, and keywords.
- Homepage @graph (Organization + ProfessionalService + WebSite) cross-references via @id.
- BreadcrumbList JSON-LD ships on every blog category and detail page through the Base layout prop.
- ItemList JSON-LD ships on blog index, articles index, case-studies index, and tag pages.
- Base.astro emits a complete Open Graph + Twitter Card set with image dimensions, image alt, article meta (published, modified, author, section, tag), site name, locale, and canonical.
- middleware.ts emits X-Robots-Tag: noindex, nofollow on every response under /portal.
- astro.config.mjs sets trailingSlash: 'never' and the sitemap filter excludes portal, api, PNG endpoints, and naming-preview.
- Fonts loaded via preload-as-style plus media-print swap with noscript fallback on Base.astro and /portal/login.
- Cover images on blog detail pages use loading="lazy", decoding="async", and width/height when frontmatter provides them.
- Persona variant H1s reduce to one DOM `<h1>` per page via `<div role="heading" aria-level="1">` wrappers; aria-hidden toggled correctly via swapAxis.
- Skip-to-content link with strong focus contrast at the top of Base.astro.
- viewport, lang, charset, theme-color, manifest, favicon variants, and apple-touch-icon all present.
- No third-party tracking scripts (no GA, no Microsoft Clarity, no Meta pixel), consistent with the privacy policy.
- Astro view transitions wired so SPA-style nav re-initializes accessibility and personalization through astro:after-swap hooks.
- Security headers (HSTS, CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, COOP, CORP) applied uniformly via postbuild wrapper plus SSR middleware.
- Privacy page accurately describes bcrypt password flow with magic-link onboarding and SHA-256 session hashing.
