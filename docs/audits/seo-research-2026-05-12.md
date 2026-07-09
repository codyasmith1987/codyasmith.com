# SEO and AI Discoverability Reference, 2026-05-12

Working reference for a personal consultancy marketing site on Astro plus Tailwind, mostly static prerendered, with localStorage-driven persona variant swapping. Curated from 2024 to 2026 primary sources. Where Google guidance is contested or fresh, the safer default is called out.

Primary canonical sources used throughout:

- Google Search Central docs at https://developers.google.com/search
- Google Crawling docs at https://developers.google.com/crawling
- web.dev at https://web.dev
- MDN at https://developer.mozilla.org
- schema.org at https://schema.org
- Anthropic privacy at https://privacy.claude.com
- OpenAI bots at https://developers.openai.com/api/docs/bots
- Perplexity docs at https://docs.perplexity.ai
- Astro docs at https://docs.astro.build

## Core Web Vitals

- LCP good is under 2.5 seconds at the 75th percentile of real-user data, per Google Search Central, https://developers.google.com/search/docs/appearance/core-web-vitals.
- INP good is at or under 200 ms, with 201 to 500 ms needs-improvement and above 500 ms poor, per web.dev, https://web.dev/articles/inp. INP replaced FID as a Core Web Vital on March 12, 2024.
- CLS good is under 0.1. Thresholds for all three have been stable since INP transitioned in.
- Never lazy-load the LCP image. Add `fetchpriority="high"` to the LCP hero. Per Addy Osmani at https://addyosmani.com/blog/fetch-priority/ this typically saves 0.5 to 2 seconds.
- INP levers: break up long tasks, move work off the main thread, shrink event handlers, avoid expensive synchronous reads of layout, prefer `requestIdleCallback` for non-urgent work.
- CLS levers: width and height attributes on images and embeds, reserve space for ads or banners, use `font-display: swap` only when paired with size-adjusted fallback metrics, animate `transform` and `opacity` only.

Implementation hint: in Astro, on the hero image: `<img src="..." width="1200" height="630" alt="..." fetchpriority="high" decoding="async" />`. Defer hydrating any island that is not in the initial viewport with `client:visible` or `client:idle`.

## Mobile-First Indexing

- Google indexes the mobile-rendered version of your page. Content, structured data, headings, links, and meta must be identical to desktop. Per https://developers.google.com/search/docs/crawling-indexing/mobile/mobile-sites-mobile-first-indexing.
- Minimum tap target is 48 by 48 CSS pixels with 8 px spacing between adjacent targets, per Google and Material Design.
- Avoid horizontal scroll on small viewports. `meta viewport` should be `width=device-width, initial-scale=1`. No `maximum-scale` and no `user-scalable=no` for accessibility.
- Serve responsive images with `srcset` and `sizes`. For modern formats use `<picture>` with `<source type="image/avif">` first, `<source type="image/webp">` second, JPEG fallback in the `<img>`.
- Mobile-first does not mean mobile-only. The desktop version is still served, but Google ranks based on the mobile DOM.

Implementation hint: Tailwind's default text and spacing already pass tap-target rules at `min-h-12 min-w-12`. For images, an Astro pattern: `<picture><source srcset={avifSet} type="image/avif" sizes="..." /><source srcset={webpSet} type="image/webp" sizes="..." /><img src={jpegFallback} alt="..." width="..." height="..." loading="lazy" decoding="async" /></picture>`. Use `@astrojs/image` or the built-in Astro Image component for variant generation.

## Structured Data (JSON-LD)

- Use JSON-LD in a `<script type="application/ld+json">` block in the head. Google's preferred format, per https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data.
- Highest-value types for a solo consultancy in 2026, ranked: Organization or ProfessionalService on the home page, Person on the about page, BreadcrumbList on every interior page, Article or BlogPosting on every essay, WebSite at the site root, Service on each service page, FAQPage on FAQ blocks (see deprecation note below).
- Organization has no required properties. Google recommends `name`, `url`, `logo`, `sameAs`, `contactPoint`, `address`. Per https://developers.google.com/search/docs/appearance/structured-data/organization.
- BreadcrumbList requires at least two `ListItem` entries, each with `position`, `name`, and `item` (URL). Visible breadcrumbs and JSON-LD breadcrumbs must match. Per https://developers.google.com/search/docs/appearance/structured-data/breadcrumb.
- Article, NewsArticle, BlogPosting have no required properties for rich results but Google strongly recommends `author`, `headline`, `image`, `datePublished`, `dateModified`. Per https://developers.google.com/search/docs/appearance/structured-data/article.
- ProfessionalService is a valid Organization subtype for consultancies. Pair with `areaServed`, `priceRange`, `serviceType`, `hasOfferCatalog`.
- Sitelinks SearchBox via WebSite plus SearchAction was removed from Google SERPs on November 21, 2024. Markup does no harm but produces no rich result. Per https://developers.google.com/search/updates.
- HowTo rich results were fully deprecated on desktop in September 2023. FAQ rich results are no longer displayed in Google Search as of May 7, 2026, with Search Console support ending August 2026. Per https://developers.google.com/search/blog/2023/08/howto-faq-changes and https://www.searchenginejournal.com/google-drops-faq-rich-results/. The schemas remain valid for semantic understanding and AI assistants still parse them.
- DiscussionForumPosting and ProfilePage are for user-generated content on forums and social platforms. Do not use on a publisher-authored consultancy site. Per https://developers.google.com/search/docs/appearance/structured-data/discussion-forum.

Implementation hint: keep JSON-LD generated by an Astro layout component that reads from the page frontmatter. One Organization block in the root layout, one BreadcrumbList component receiving an array, one Article block on `[slug].astro`.

## E-E-A-T Signals

- Surface a real author with a real name on every essay. Use `<address>` or a byline pattern. Link to a dedicated `/about` or `/authors/cody` page.
- In JSON-LD, use Person with `name`, `url`, `image`, `jobTitle`, `worksFor`, `sameAs` (array of LinkedIn, GitHub, X, professional profiles), `knowsAbout` (array of topic strings or DefinedTerm). Per https://schema.org/Person.
- `knowsAbout` is rewarded in AI Overview citation patterns: topical alignment between the author's knowsAbout and the query is a citation signal, per leadgen-economy.com and aubreyyung.com analyses.
- `hasCredential` with EducationalOccupationalCredential references actual certifications. Use sparingly and only for verifiable items.
- Show dates: `datePublished` and `dateModified` on Article, and the same dates visible in HTML, ideally with a `<time datetime="...">` element.
- Build a transparency page: contact, real address (or city if home-based), pricing range, and how-we-work. This is a quality-rater signal even before any schema is read.
- Reviews and awards: use Review and AggregateRating schema only on pages where the reviews are actually displayed. Fabricated or self-applied review markup is a manual-action risk.

Implementation hint: a single `Author.astro` component that renders both the visible byline and the Person JSON-LD from one data file.

## AI Assistant Discoverability

- llms.txt is a 2024 proposal from Jeremy Howard and Answer.AI at https://llmstxt.org. As of late 2025, BuiltWith tracks roughly 844,000 sites adopting it. No major AI platform has officially confirmed they consume it, and Google has publicly rejected it (Search Engine Land, https://searchengineland.com/llms-txt-proposed-standard-453676). Safer default: ship a minimal `/llms.txt` because the cost is near zero, but do not rely on it for discoverability.
- Anthropic operates three bots, all of which honor robots.txt per https://privacy.claude.com/en/articles/8896518-:
  - ClaudeBot: training data collection. UA contains `ClaudeBot/1.0`.
  - Claude-User: real-time fetch when a user asks Claude to read a URL.
  - Claude-SearchBot: indexing for Claude search features.
- OpenAI operates three bots per https://developers.openai.com/api/docs/bots:
  - GPTBot: training.
  - OAI-SearchBot: ChatGPT search citations index.
  - ChatGPT-User: user-initiated retrieval.
- Perplexity operates two bots per https://docs.perplexity.ai/docs/resources/perplexity-crawlers:
  - PerplexityBot: indexing. Honors robots.txt.
  - Perplexity-User: real-time retrieval. Perplexity has stated this user-agent does not necessarily honor robots.txt.
- Google-Extended is a control token, not a crawler. Disallowing it opts your content out of Gemini and Vertex AI training without affecting Google Search ranking. Per https://developers.google.com/search/docs/crawling-indexing/overview-google-crawlers.
- CCBot is Common Crawl's spider. Its dataset feeds most foundation-model training. Blocking it removes you from a large share of AI training corpora.
- For a marketing site whose goal is AI citation, the safer default in 2026 is allow indexing bots (OAI-SearchBot, PerplexityBot, Claude-SearchBot, Googlebot, Google-Extended) and decide per-bot whether to allow training bots (GPTBot, ClaudeBot, CCBot). Citation in AI Overviews and Perplexity strongly correlates with classical top-10 organic rank: roughly 40 percent of AI Overview citations come from the top 10, per Surfer SEO and Wellows analyses.
- Content freshness matters: posts under 3 months old are cited about 3x more often in AI answers, per The Digital Bloom 2025 analysis.

Implementation hint: build robots.txt by listing each bot family explicitly. Do not rely on `User-agent: *` to cover them, since some retrieval bots ignore the wildcard. Include `Sitemap:` once. See robots.txt section.

## Persona Variant Indexing (Cloaking Risk)

- Cloaking means showing materially different content to a crawler than to users with intent to manipulate rankings. Personalization is allowed when the base content is the same and the crawler sees what an anonymous human visitor sees. Per https://developers.google.com/search/docs/essentials/spam-policies and John Mueller AMA notes.
- Content swapped client-side after first paint is fine as long as the initial HTML (what Googlebot renders) contains the canonical version that represents the page truthfully. Hidden content via `display: none` is not penalized by itself, but Google has historically discounted text that is hidden at first paint when scoring relevance. Per Google Search Central community guidance.
- Variants delivered by localStorage are invisible to Googlebot (it does not preserve localStorage between visits). Googlebot sees only the default. That makes the default the canonical and the only version that will be indexed.
- Safer pattern for persona variants:
  1. Render the default variant unconditionally in HTML, semantically complete.
  2. Render alternate variants with `hidden` or `data-variant` attributes, not `display: none`. Use `hidden until="found"` if you ever want in-page-find to work across variants.
  3. Apply `aria-hidden="true"` on inactive variants so screen readers do not announce duplicate copy.
  4. Do not branch on User-Agent: showing one variant to Googlebot and another to humans is cloaking. Branch only on user signals (localStorage, cookie set by user interaction).
  5. If you want a specific persona variant to be indexable, expose it at its own URL (such as `?variant=builder`) and set `<link rel="canonical">` on that URL back to the default URL, or vice versa if the variant is the primary. Self-referencing canonicals are correct.
- Make the default variant the most ranking-optimized version: written for the broadest audience, with the keywords you want to rank for, in semantic HTML.

Implementation hint: in your Astro layout, render all variants server-side. Use `hidden` plus `data-variant="<key>"`. A small inline script in `<head>` reads localStorage and toggles `hidden` synchronously before paint to avoid CLS. Avoid swapping headings (h1, h2) between variants since Google may index either set.

## Sitemap Conventions

- One sitemap unless you exceed 50,000 URLs or 50 MB. Otherwise split with a sitemap index. Per https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap.
- Include only canonical, indexable URLs returning 200. Exclude noindex pages, admin routes, API endpoints, paginated duplicates without canonical, search result pages.
- `lastmod` is the only secondary tag Google uses. It must be accurate, in W3C Datetime format. Google explicitly ignores `<priority>` and `<changefreq>`.
- Inaccurate `lastmod` causes Google to disregard the signal site-wide. Update it only when main content, structured data, or links materially change. Do not bump it on copyright-year edits.
- Image sitemap extension is still supported and still useful for image-heavy pages that need Google Images discovery, especially for unique illustrations. Combine into the main sitemap with `image:image`. Per https://developers.google.com/search/docs/crawling-indexing/sitemaps/combine-sitemap-extensions.
- Video and news sitemaps remain documented and supported. Use them only if you publish video or qualify as Google News.

Implementation hint: `@astrojs/sitemap` defaults are fine for most consultancy sites. Customize when you have noindex pages: pass `filter: (page) => !page.includes('/admin/')`. Use `serialize` to set accurate `lastmod` from frontmatter `dateModified`. For multi-language, set `i18n` config.

## robots.txt

- Google honors `User-agent`, `Allow`, `Disallow`, `Sitemap`. Google explicitly ignores `Crawl-delay`. Per https://developers.google.com/crawling/docs/robots-txt/robots-txt-spec.
- Anthropic supports the non-standard `Crawl-delay` per its privacy docs. Bing also honors it. Use only inside Anthropic and Bing user-agent groups.
- Rule precedence in Google: the most specific user-agent group wins, then within a group the longest matching path wins, then `Allow` beats `Disallow` on ties (least restrictive rule).
- Group ordering inside the file does not matter. Each `User-agent` line opens a group; group ends at the next `User-agent` or end of file.
- Declare `Sitemap:` once with an absolute URL. Multiple `Sitemap:` lines are allowed.
- Address AI crawlers explicitly. The wildcard `*` does not always apply to retrieval bots and never reliably to bots that ignore robots.txt (Perplexity-User).
- For a marketing site that wants to be cited by AI:
  - Allow Googlebot, Bingbot.
  - Allow OAI-SearchBot, PerplexityBot, Claude-SearchBot (these are the indexing bots used for AI search results).
  - Decide GPTBot, ClaudeBot, CCBot, Google-Extended based on whether you want training use.
  - Disallow obvious admin and API paths.

Implementation hint:

```
User-agent: *
Disallow: /admin/
Disallow: /api/

User-agent: GPTBot
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: PerplexityBot
Allow: /

Sitemap: https://codyasmith.com/sitemap-index.xml
```

## Canonical URLs

- One URL per piece of content. Pick trailing slash or no trailing slash and keep it consistent. Per https://developers.google.com/search/docs/crawling-indexing/canonicalization.
- Always self-reference canonical on indexable pages: `<link rel="canonical" href="https://codyasmith.com/path/">`. Self-referencing canonicals are recommended.
- Pick apex or www and 301-redirect the other. Same for http to https.
- Astro has a `trailingSlash: 'always' | 'never' | 'ignore'` config option. Set it explicitly. Note that even with `trailingSlash: 'never'`, the default `Astro.url` still emits a trailing slash on the canonical, requiring a `.replace(/\/+$/, '')` helper. Per https://noahflk.com/blog/trailing-slashes-astro.
- Avoid query-parameter URL variants in canonical. If you must accept tracking params (utm), canonical should strip them.
- Cross-domain canonicals are valid but irrelevant for a single-site consultancy.

Implementation hint: in a base layout, compute canonical as `new URL(Astro.url.pathname, Astro.site).href.replace(/\/+$/, '') + '/'` (or omit the trailing append, depending on your chosen style). Verify in the rendered HTML that one and only one `<link rel="canonical">` is present.

## Open Graph and Twitter Card

- 1200 by 630 px remains the universal baseline for `og:image`. Per https://www.ogimage.gallery/libary/the-ultimate-guide-to-og-image-dimensions-2024-update and og-image.org. It satisfies Facebook, LinkedIn, Discord, Slack, and acceptable for Twitter `summary_large_image`.
- Twitter recommends 1200 by 675 (16:9) for `summary_large_image`. 1200 by 630 still renders correctly. If you want a Twitter-specific image, supply `twitter:image`.
- Required tags for a typical article share: `og:title`, `og:description`, `og:url`, `og:image`, `og:type`, `og:site_name`. For Twitter: `twitter:card` (set to `summary_large_image`), `twitter:title`, `twitter:description`, `twitter:image`. Twitter falls back to OG tags for the rest.
- `og:image:alt` and `twitter:image:alt` are not required by Google but are accessibility wins and good for AI assistants summarizing the page. Always include.
- For Article: add `article:published_time`, `article:modified_time`, `article:author`, `article:section`, `article:tag`.
- File format: JPEG for photographic OG images (smaller, fast), PNG for crisp graphics. WebP is fine for OG on most platforms in 2026 but JPEG remains safest universal.
- Include `og:image:width` and `og:image:height` so platforms render without re-downloading.

Implementation hint: a `SocialMeta.astro` component receives `{ title, description, url, image, imageAlt, type, publishedTime, modifiedTime }` and emits all OG and Twitter tags in one place. Generate per-page OG images at build time with `satori` or `@vercel/og`.

## HTTP-Level

- 301 (permanent) and 308 (permanent, preserves method and body) both pass essentially full PageRank. 301 is the safer universal default for GET resources. Per https://developers.google.com/search/docs/crawling-indexing/301-redirects.
- 302 and 307 are temporary. Google treats them as not transferring signals for at least the first few months. Use only for genuinely temporary moves.
- Meta-refresh redirects with 0 seconds are interpreted as permanent by Google but are not recommended.
- Keep redirects in place at least one year, per John Mueller.
- noindex: meta `<meta name="robots" content="noindex">` and `X-Robots-Tag: noindex` header are equivalent. Use the header for PDFs, images, and other non-HTML. Per https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag.
- For noindex to work, the URL must not be blocked in robots.txt: a blocked URL cannot be crawled and Google never sees the noindex.
- `loading="lazy"` on `<img>` and `<iframe>` for off-screen content. `loading="eager"` or omit for above-the-fold. Per https://web.dev/articles/browser-level-image-lazy-loading.
- `decoding="async"` on all images so decoding does not block rendering.
- Never combine `loading="lazy"` with `fetchpriority="high"` on the same image. For the LCP image: omit `loading` (defaults to eager) and add `fetchpriority="high"`.

Implementation hint: in Astro static builds, configure redirects in the host (Vercel, Netlify, Cloudflare) rather than relying on meta-refresh. For per-page noindex, set in frontmatter and conditionally emit the meta in the head.

## Internal Linking and Anchor Text

- Use descriptive anchor text that reflects the destination page's primary topic. Avoid "click here" and "read more" without context.
- Vary anchor text. Exact-match anchor over-optimization to internal pages can look spammy at scale. A natural mix of branded, partial-match, and natural-language anchors is safer.
- Breadcrumb navigation is a strong internal-link signal. Google removed the visual breadcrumb in mobile SERPs in January 2025 but increased its reliance on the underlying BreadcrumbList JSON-LD. Per https://www.searchenginejournal.com/google-highlights-forums-profiles-with-new-structured-data/502301/ context.
- BreadcrumbList JSON-LD must mirror the visible breadcrumb exactly. Mismatch can trigger rich-result suppression.
- Related-content modules at the bottom of essays improve crawl depth and time on site. Use editorially chosen links, not random recent posts.
- Footer links should be limited and meaningful. Sitewide footer link stuffing is a low-value signal.

Implementation hint: build a `Breadcrumbs.astro` that takes an array of `{ name, href }` and renders both the visible nav and a BreadcrumbList JSON-LD from the same array.

## Page Speed (Code-Level)

- `font-display: swap` on all `@font-face` declarations so text is never invisible while the font loads. Pair with a metric-matched fallback (`size-adjust`, `ascent-override`, `descent-override`) to reduce CLS.
- Preload critical fonts only: the one or two faces that render above-the-fold body and headline. `<link rel="preload" href="/fonts/inter.woff2" as="font" type="font/woff2" crossorigin>`. Preload tag goes before the `@font-face` style block.
- For Google Fonts: `<link rel="preconnect" href="https://fonts.googleapis.com" crossorigin>` and `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` before the stylesheet link. Per Google Fonts guidance.
- Self-host fonts when feasible: removes the third-party round trip entirely and gives total control over caching.
- Inline critical CSS for above-the-fold content; load the rest deferred. Astro's Vite pipeline supports `vite-plugin-critical` or just hand-write a minimal inline `<style>` in the head and link the rest with `<link rel="stylesheet" media="print" onload="this.media='all'">`.
- Image format priority: AVIF (best compression, 95%+ global browser support per caniuse) > WebP (near-universal) > JPEG (photos) and PNG (sharp graphics). Use `<picture>` with multiple `<source type="image/avif">` and `<source type="image/webp">` and a JPEG `<img>` fallback.
- Defer non-critical JS: in Astro, use `client:idle`, `client:visible`, `client:media` instead of `client:load` wherever the interactivity is not immediate.
- Limit preconnect hints to 4 to 6 origins.

Implementation hint: in `BaseHead.astro`, in order: meta charset, viewport, title, description, canonical, preconnect, preload (critical font), inline critical CSS, stylesheet links, JSON-LD. JS at the end of body or with `type="module"` (deferred by default).

## RSS Feed

- Provide full content in `<description>` (or `<content:encoded>` with CDATA) for friendlier consumption by readers and AI assistants. Summary-only feeds force a click and reduce reach. Per RSS Best Practices Profile at https://www.rssboard.org/rss-profile.
- Use RSS 2.0 unless you have a specific Atom requirement. Both work in modern readers; RSS 2.0 has wider tooling.
- `pubDate` and `lastBuildDate` must be RFC 822 format with a four-digit year: `Thu, 04 Oct 2007 23:59:45 GMT` or `+0000`. Per https://www.rssboard.org/rss-profile and https://whitep4nth3r.com/blog/how-to-format-dates-for-rss-feeds-rfc-822/.
- Include `<atom:link rel="self" type="application/rss+xml" href="..." />` in `<channel>` for autodiscovery. Requires `xmlns:atom="http://www.w3.org/2005/Atom"` on `<rss>`.
- Image enclosures via `<enclosure url type length>` for podcasts. For blog images, use `<media:content>` (Media RSS namespace) or include the image inside `<description>` HTML.
- Set `<link>` on each item to its canonical URL and `<guid isPermaLink="true">` to the same URL or a stable identifier.

Implementation hint: `@astrojs/rss` handles RFC 822 dates automatically when you pass `Date` objects to `pubDate`. Pass `content` to emit `<content:encoded>` full-content. Manually emit the `<atom:link>` element via the `customData` option.

## Accessibility as SEO

- WCAG 2.2 Level AA is the worldwide compliance benchmark in 2026. The European Accessibility Act made it legally required across the EU in June 2025. AAA is aspirational; AA is the practical target.
- Alt text: descriptive of content and function. Empty `alt=""` on purely decorative images is correct, not lazy. Per https://www.w3.org/WAI/tutorials/images/.
- Heading hierarchy: one `<h1>` per page, no skipped levels (do not jump from h2 to h4). Heading text should reflect the section's topic; this is also a relevance signal.
- Landmarks: `<header>`, `<nav>`, `<main>`, `<aside>`, `<footer>`. Prefer semantic HTML over ARIA roles. ARIA is for gaps the HTML cannot fill.
- Skip link at the top of `<body>`: `<a href="#main" class="sr-only focus:not-sr-only">Skip to content</a>`.
- Focus management: visible focus ring on every interactive element. Do not `outline: none` without a replacement. Tailwind's `focus-visible:ring-*` utilities are sufficient.
- Color contrast: 4.5:1 for body text, 3:1 for large text (24 px or 19 px bold), per WCAG AA.
- Forms: every input has a programmatically associated `<label>`, error messages reference inputs with `aria-describedby`.

Implementation hint: a `<a class="sr-only focus:not-sr-only" href="#main">Skip to content</a>` immediately inside `<body>`. Wrap the main column in `<main id="main">`. Tailwind's `sr-only` class is standard.

## Indie Personal Site Signals

- A real human name, a real location, a real phone or email, and a recognizable face on the site outranks faceless corporate copy for trust signals. This is where the marginal hour pays off for a consultant.
- Original first-hand content with specific examples and verifiable case studies wins over generic SEO listicles. AI Overviews preferentially cite original content over rewrites.
- Topical depth on a narrow set of subjects (a content cluster) beats shallow breadth. Pick three to five subject pillars and write deeply on each.
- Backlinks from sources you actually know personally (peers, podcasts, local news) carry more weight than syndicated links. Don't buy links.
- Update cadence matters: AI assistants cite content under 3 months old roughly 3x more often. A monthly essay schedule keeps the freshness signal live.
- A small site has the advantage of a clean signal-to-noise ratio: every page can be high quality. Don't dilute by mass-producing thin pages.
- Local: a real local address with NAP (Name, Address, Phone) consistency across the site, Google Business Profile, and other directories is a strong local-search signal for Cedar City UT visibility.

Implementation hint: one `LocalBusiness` or `ProfessionalService` JSON-LD with `address`, `geo`, `areaServed`, `telephone`, `openingHours`. Match identically to your Google Business Profile.

## Newer Signals Worth Knowing

- AI Overviews now appear on roughly 48% of Google queries (Averi, 2026). About 40 percent of AI Overview citations come from the top 10 organic results, per Surfer SEO and Wellows 2025 analyses, so classical SEO still drives AI visibility.
- Citation distribution within an article skews to the intro: 44 percent of LLM citations are drawn from the first 30 percent of body text. Front-load the answer, then expand. Inverted-pyramid writing is now algorithmically rewarded.
- Domain authority floor: sites under DR 63 receive negligible AI citations per Decoding's 10M-citation analysis. Building genuine link authority remains foundational.
- FAQ rich results are gone from SERPs but the FAQPage schema is still parsed by AI assistants and contributes to topical understanding. The safer default in 2026: keep FAQPage on actual FAQ blocks; do not artificially manufacture them for ranking.
- DiscussionForumPosting and ProfilePage rich results launched in 2023 are aimed at forums and social platforms. Not applicable to a publisher-authored consultancy site.
- Profile-style author markup (Person plus `knowsAbout` plus `sameAs`) is the highest-leverage schema add for E-E-A-T in AI search.
- Cloudflare since July 2025 blocks AI bots by default for new customers. If you host on Cloudflare, double-check that your AI bot allow rules are explicit in the dashboard, not just in robots.txt.

Implementation hint: front-load the answer in every essay. First paragraph should stand alone as an extractable response to the page title posed as a question. The rest of the essay is the why, evidence, and depth.
